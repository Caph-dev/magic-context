//! The one-time move of a project's rows from the module's `store.db` into the host's
//! `context.db` (`single_store.migrate`).
//!
//! After the move `context.db` is the only place the project's memories, notes,
//! compartments, events, primer candidates and user-memory candidates are served from,
//! and `store.db` keeps a retained copy that is never served as current.
//!
//! The move is a sequence of small `BEGIN IMMEDIATE` transactions on `context.db`, each
//! under the privileged-writer bracket, the in-transaction fingerprint recheck and the
//! project and session scope, so no seat waits more than one bounded chunk for the write
//! lock. Every chunk writes only rows that are missing or different, so a re-run after a
//! crash repeats nothing. The last chunk is held back: once every earlier row has been
//! re-read and found equal to its source, one final transaction writes that chunk, checks
//! nothing drifted since the re-read, and inserts the project's single-store marker. The
//! marker is therefore visible exactly when the copy is complete. `store.db` is then told,
//! in its own later commit, that TypeScript authority applies again (both files are never
//! joined in one transaction).
//!
//! Nothing here is served until the module reads the moved rows from `context.db`, so the
//! route refuses with [`CUTOVER_ABSENT`] in any build that cannot do that yet.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use mc_store::{McStore, SingleStoreMigrationRow, SingleStoreSourceRow};
use rusqlite::types::Value as SqlValue;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Transaction};
use serde_json::Value;

use crate::host_store::{
    self, HostStore, HostStoreError, BRACKET_TABLE, BUILT_CONTEXT_FENCE_VERSION,
    DEFAULT_PUBLISH_CHUNK_ROWS, MARKER_LANE_VERSION, MARKER_TABLE, MAX_VISIBILITY_CHUNK_ROWS,
    PUBLISH_CHUNK_BUDGET_US,
};

// ── Refusal codes ───────────────────────────────────────────────────────────

/// This build cannot read a moved project from `context.db`, so moving one would leave it
/// served from the stale `store.db` copy.
pub const CUTOVER_ABSENT: &str = "single_store_cutover_absent";
/// The file is below the marker lane, or this binary was built against a fence below it.
pub const MARKER_WRITE_REFUSED: &str = "single_store_marker_write_refused";
/// A table the move writes is not the schema this binary was built against.
pub const FINGERPRINT_MISMATCH: &str = "single_store_fingerprint_mismatch";
/// A copied row did not read back equal to its source, a context row in the project's
/// scope has no source, or something changed between verification and the final commit.
pub const VERIFY_MISMATCH: &str = "single_store_verify_mismatch";
/// Some session of the project has no host that could keep its rows embedded.
pub const HOST_LESS: &str = "single_store_host_less";
/// The project is being copied, or the copy ran out of its time budget. Retryable.
pub const COPY_IN_PROGRESS: &str = "single_store_copy_in_progress";
/// The store does not own both of the project's domains, so it is not the source of truth.
pub const AUTHORITY_NOT_MODULE: &str = "single_store_authority_not_module";
/// A `context.db` event or user-memory candidate of the project has no `store.db`
/// counterpart and cannot be proven either current or superseded.
pub const UNCLASSIFIED_ROWS: &str = "single_store_unclassified_rows";

/// The harnesses whose host keeps a moved project's rows embedded. A session under any
/// other harness would leave its memories unembedded after the move.
pub const HOST_BACKED_HARNESSES: &[&str] = &["opencode"];

/// The longest one run may hold the project's writes still.
pub const MAX_COPY_PAUSE: Duration = Duration::from_secs(120);

/// Tables the move writes that are not domain tables, with the schema fingerprint each
/// must carry (same hash as [`host_store::DOMAIN_TABLE_FINGERPRINTS`]).
pub const COPY_AUXILIARY_FINGERPRINTS: &[(&str, &str)] = &[
    (
        "authority_managed",
        "d4d8338d8424f7551d3ad13b0a42e03e1c96d06e69ea68e3d4fab31010f1e30e",
    ),
    (
        "mirror_identity",
        "62545ecd2573557d682faac1e4b90d2ab05acf88b4dd1a5091c4f89d116c1ffd",
    ),
];

/// Domain tables the move writes.
pub const COPY_DOMAIN_TABLES: &[&str] = &[
    "memories",
    "notes",
    "compartments",
    "compartment_events",
    "primer_candidates",
    "user_memory_candidates",
    "memory_embedding_watermarks",
];

/// The one statement anywhere in the module that inserts a single-store marker. It runs
/// only inside the final copy transaction, so a marker never exists without its rows.
const MARKER_INSERT_SQL: &str = "INSERT INTO single_store_projects(
     project_path, context_store_uuid, marked_at, marked_by_version
 ) VALUES (?1, ?2, ?3, ?4)";

/// The build identity a marker records: the release SHA, or the crate version for an
/// unstamped build.
pub fn build_version() -> String {
    match option_env!("MC_BUILD_SHA")
        .map(str::trim)
        .filter(|sha| !sha.is_empty())
    {
        Some(sha) => sha.to_string(),
        None => format!("unstamped-{}", env!("CARGO_PKG_VERSION")),
    }
}

// ── Request, options, outcome ──────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrateRequest {
    pub project: String,
    pub dry_run: bool,
    /// Re-attempt a project whose last run was refused.
    pub retry: bool,
}

/// How a run is carried out. Production uses [`MigrateOptions::new`]; tests shrink the
/// budgets and may assume the cutover is present.
#[derive(Debug, Clone)]
pub struct MigrateOptions {
    pub context_db: PathBuf,
    pub built_fence: i64,
    pub staged_budget: usize,
    pub session_budget: usize,
    pub max_pause: Duration,
    pub build_version: String,
    /// Test-only: behave as a build whose readers can serve a moved project.
    pub assume_cutover: bool,
}

impl MigrateOptions {
    pub fn new(context_db: PathBuf) -> Self {
        MigrateOptions {
            context_db,
            built_fence: BUILT_CONTEXT_FENCE_VERSION,
            staged_budget: DEFAULT_PUBLISH_CHUNK_ROWS,
            session_budget: MAX_VISIBILITY_CHUNK_ROWS,
            max_pause: MAX_COPY_PAUSE,
            build_version: build_version(),
            assume_cutover: false,
        }
    }

    /// Whether this build may move a project. Only a test build can assume it.
    pub fn cutover_present(&self) -> bool {
        mc_store::SINGLE_STORE_CAPABLE || (cfg!(test) && self.assume_cutover)
    }
}

/// Why a run stopped without completing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrateRefusal {
    pub code: String,
    pub detail: String,
    /// True when the same request can succeed later without anyone changing anything.
    pub retryable: bool,
}

impl MigrateRefusal {
    fn new(code: &str, detail: impl Into<String>) -> Self {
        MigrateRefusal {
            code: code.to_string(),
            detail: detail.into(),
            retryable: false,
        }
    }

    fn retryable(code: &str, detail: impl Into<String>) -> Self {
        MigrateRefusal {
            code: code.to_string(),
            detail: detail.into(),
            retryable: true,
        }
    }
}

impl std::fmt::Display for MigrateRefusal {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.detail)
    }
}

impl From<HostStoreError> for MigrateRefusal {
    fn from(error: HostStoreError) -> Self {
        let retryable = matches!(error, HostStoreError::Busy { .. });
        MigrateRefusal {
            code: error.code().to_string(),
            detail: error.to_string(),
            retryable,
        }
    }
}

impl From<rusqlite::Error> for MigrateRefusal {
    fn from(error: rusqlite::Error) -> Self {
        // A scope trigger aborts with a message carrying the scope-violation code; keep
        // that name rather than reporting a generic SQLite failure.
        if error.to_string().contains(host_store::SCOPE_VIOLATION_CODE) {
            return MigrateRefusal::new(host_store::SCOPE_VIOLATION_CODE, error.to_string());
        }
        HostStoreError::from(error).into()
    }
}

impl From<mc_store::McStoreError> for MigrateRefusal {
    fn from(error: mc_store::McStoreError) -> Self {
        MigrateRefusal::new("single_store_store_error", error.to_string())
    }
}

/// Per-table counts for the report.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
pub struct TableCounts {
    /// Rows `store.db` holds for the project in this table.
    pub source: usize,
    /// Rows that were missing or different when the run planned its work: what it copies,
    /// or in a dry run what it would copy.
    pub copied: usize,
    /// Row writes (inserts or updates) the run actually committed.
    pub written: usize,
    /// Rows already equal to their source, left untouched.
    pub skipped: usize,
    /// Rows read back equal to their source in the final verification.
    pub verified: usize,
    /// `context.db` rows removed: compartments above the store's last sequence, and
    /// events or candidates that `store.db` proves were superseded.
    pub deleted: usize,
    /// `context.db` rows with no source that were kept because they belong to history
    /// `store.db` still has unchanged.
    pub kept: usize,
    /// `context.db` events left untouched because the compartment they point at exists in
    /// neither store, so they cannot belong to any live compartment.
    pub orphans_kept: usize,
}

/// What a run did.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct MigrateReport {
    /// `migrated`, `already_marked` or `dry_run`.
    pub status: String,
    pub project: String,
    pub tables: BTreeMap<String, TableCounts>,
    /// How long each `context.db` write transaction held the write lock, in order.
    pub transaction_holds_us: Vec<i64>,
    pub max_hold_us: i64,
    pub p99_hold_us: i64,
    /// Wall-clock time the project's writes were held still.
    pub total_pause_ms: i64,
    pub sessions: usize,
    pub marker_committed: bool,
    pub neutralized: bool,
}

impl MigrateReport {
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }

    fn finish_holds(&mut self) {
        let mut holds = self.transaction_holds_us.clone();
        holds.sort_unstable();
        self.max_hold_us = holds.last().copied().unwrap_or(0);
        self.p99_hold_us = if holds.is_empty() {
            0
        } else {
            holds[((holds.len() * 99).div_ceil(100)).saturating_sub(1)]
        };
    }
}

/// Test seams around each `context.db` transaction. Production passes [`NoObserver`].
pub trait MigrateObserver {
    /// After the run recorded that it is copying and before its first transaction.
    fn before_first_chunk(&mut self) {}
    /// After verification passed and before the final transaction begins.
    fn before_final(&mut self) {}
    /// After a chunk committed and before the next transaction begins.
    fn between_transactions(&mut self, _context_db: &Path, _committed: usize) {}
    /// Inside a transaction, after its writes and before its commit.
    fn inside_transaction(&mut self, _tx: &Transaction<'_>, _index: usize, _is_final: bool) {}
    /// After the final `context.db` commit and before `store.db` is neutralised.
    fn after_context_commit(&mut self) {}
}

pub struct NoObserver;
impl MigrateObserver for NoObserver {}

// ── Holding a project still ────────────────────────────────────────────────

#[derive(Default)]
struct ProjectHold {
    copying: bool,
    writers: usize,
    sessions: BTreeSet<String>,
}

#[derive(Default)]
struct CopyRegistry {
    projects: Mutex<HashMap<String, ProjectHold>>,
    changed: Condvar,
}

fn registry() -> &'static CopyRegistry {
    static REGISTRY: OnceLock<CopyRegistry> = OnceLock::new();
    REGISTRY.get_or_init(CopyRegistry::default)
}

/// The registry key of `project` in `store`: two stores open in one process (tests,
/// embedded callers) hold their projects independently.
fn hold_key(store: &McStore, project: &str) -> String {
    format!("{}\u{0}{project}", store.tag_cache_namespace())
}

/// True while `project` is being copied out of `store`.
pub fn copy_in_progress(store: &McStore, project: &str) -> bool {
    registry()
        .projects
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&hold_key(store, project))
        .is_some_and(|hold| hold.copying)
}

/// True while a copy out of `store` covering `session_id` is running.
pub fn session_copy_in_progress(store: &McStore, session_id: &str) -> bool {
    let prefix = hold_key(store, "");
    registry()
        .projects
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .iter()
        .any(|(key, hold)| {
            key.starts_with(&prefix) && hold.copying && hold.sessions.contains(session_id)
        })
}

/// The gate the module installs on its store: a fold publish or facade write for a
/// project being copied waits for the copy to finish, and a copy waits for writes that
/// were already running. Built for one store with [`CopyWriteGate::for_store`].
pub struct CopyWriteGate {
    namespace: u64,
}

impl CopyWriteGate {
    pub fn for_store(store: &McStore) -> Self {
        CopyWriteGate {
            namespace: store.tag_cache_namespace(),
        }
    }
}

struct WriterGuard(String);

impl Drop for WriterGuard {
    fn drop(&mut self) {
        let registry = registry();
        let mut projects = registry
            .projects
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(hold) = projects.get_mut(&self.0) {
            hold.writers = hold.writers.saturating_sub(1);
            if !hold.copying && hold.writers == 0 {
                projects.remove(&self.0);
            }
        }
        registry.changed.notify_all();
    }
}

impl mc_store::ProjectWriteGate for CopyWriteGate {
    fn enter(&self, project: &str) -> mc_store::ProjectWriteGuard {
        let project = &format!("{}\u{0}{project}", self.namespace);
        let registry = registry();
        let mut projects = registry
            .projects
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        while projects.get(project).is_some_and(|hold| hold.copying) {
            projects = registry
                .changed
                .wait(projects)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
        projects.entry(project.to_string()).or_default().writers += 1;
        Box::new(WriterGuard(project.to_string()))
    }
}

/// Held for the whole run; dropping it releases the project's writes.
struct CopyGuard(String);

impl Drop for CopyGuard {
    fn drop(&mut self) {
        let registry = registry();
        let mut projects = registry
            .projects
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(hold) = projects.get_mut(&self.0) {
            hold.copying = false;
            hold.sessions.clear();
            if hold.writers == 0 {
                projects.remove(&self.0);
            }
        }
        registry.changed.notify_all();
    }
}

/// Hold `project` still the way a running copy does, for a test of what other routes
/// answer meanwhile. Dropping the value releases it.
#[cfg(test)]
pub(crate) fn hold_for_test(store: &McStore, project: &str, sessions: &[&str]) -> impl Drop {
    let sessions = sessions.iter().map(|session| session.to_string()).collect();
    begin_copy(store, project, &sessions, Duration::from_secs(5)).expect("hold the project")
}

/// Stop new writes for `project` and wait for running ones to finish.
fn begin_copy(
    store: &McStore,
    project: &str,
    sessions: &BTreeSet<String>,
    wait: Duration,
) -> Result<CopyGuard, MigrateRefusal> {
    let key = hold_key(store, project);
    let registry = registry();
    let mut projects = registry
        .projects
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let hold = projects.entry(key.clone()).or_default();
    if hold.copying {
        return Err(MigrateRefusal::retryable(
            COPY_IN_PROGRESS,
            format!("a copy of {project} is already running"),
        ));
    }
    hold.copying = true;
    hold.sessions = sessions.clone();
    let guard = CopyGuard(key.clone());
    let deadline = Instant::now() + wait;
    while projects.get(&key).is_some_and(|hold| hold.writers > 0) {
        let now = Instant::now();
        if now >= deadline {
            drop(projects);
            drop(guard);
            return Err(MigrateRefusal::retryable(
                COPY_IN_PROGRESS,
                format!("writes for {project} did not finish within {wait:?}"),
            ));
        }
        projects = registry
            .changed
            .wait_timeout(projects, deadline - now)
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .0;
    }
    Ok(guard)
}

// ── What is compared ───────────────────────────────────────────────────────

/// Every `memories` column except the surrogate id. A copied row equals its source when
/// all of these are equal, `superseded_by_memory_id` after translation into context ids.
const MEMORY_COLUMNS: &[&str] = &[
    "project_path",
    "category",
    "content",
    "normalized_hash",
    "importance",
    "scope",
    "shareable",
    "source_session_id",
    "source_type",
    "seen_count",
    "retrieval_count",
    "first_seen_at",
    "created_at",
    "updated_at",
    "last_seen_at",
    "last_retrieved_at",
    "status",
    "expires_at",
    "verification_status",
    "verified_at",
    "classified_at",
    "superseded_by_memory_id",
    "merged_from",
    "metadata_json",
    "mural_cue",
    "mural_cue_hash",
    "mural_cue_at",
    "mural_cue_rejection_count",
];
const MEMORY_SUPERSEDED: usize = 21;

/// Every `notes` column except the surrogate id.
const NOTE_COLUMNS: &[&str] = &[
    "type",
    "status",
    "content",
    "session_id",
    "project_path",
    "surface_condition",
    "created_at",
    "updated_at",
    "last_checked_at",
    "ready_at",
    "ready_reason",
    "compiled_provider",
    "compiled_config",
    "compiled_at",
    "compile_status",
    "harness",
    "anchor_ordinal",
    "anchor_block_id",
    "compiled_check",
    "manifest_json",
    "check_hash",
    "check_cron",
    "check_version",
    "check_status",
    "check_failure_count",
    "check_network_failure_count",
    "check_quarantined_until",
    "check_next_due_at",
    "check_compiled_at",
    "check_false_since_at",
    "check_last_liveness_at",
    "policy_version",
];

/// Every `compartments` column except the id and the embedding columns, which start
/// empty and are filled by the host's backfill.
const COMPARTMENT_COLUMNS: &[&str] = &[
    "session_id",
    "sequence",
    "start_message",
    "end_message",
    "start_message_id",
    "end_message_id",
    "title",
    "content",
    "p1",
    "p2",
    "p3",
    "p4",
    "importance",
    "episode_type",
    "legacy",
    "created_at",
    "harness",
    "rebase_status",
];
/// The compared fields that say what a compartment is about: title, body, the four
/// tiers, importance, episode type and the legacy flag. They decide whether the module
/// rewrote a compartment. The message coordinates are left out on purpose: a session the
/// host summarised before rust mode took over keeps the same compartments, but the
/// module records their boundaries as block ids (`msg_…#0`) on its own ordinal scale,
/// while the host recorded message ids. That is one compartment written two ways, not a
/// rewrite. The creation time, harness and rebase status are labels, not content.
const COMPARTMENT_CONTENT_FIELDS: std::ops::RangeInclusive<usize> = 6..=14;

const EVENT_COLUMNS: &[&str] = &[
    "session_id",
    "compartment_id",
    "kind",
    "at_compartment",
    "fields_json",
    "created_at",
    "harness",
];
const EVENT_COMPARTMENT_ID: usize = 1;

const PRIMER_COLUMNS: &[&str] = &[
    "project_path",
    "harness",
    "session_id",
    "question",
    "normalized_question",
    "source_compartment_start",
    "source_compartment_end",
    "source_start_message_id",
    "source_end_message_id",
    "source_message_time",
    "created_at",
];

const CANDIDATE_COLUMNS: &[&str] = &[
    "content",
    "session_id",
    "source_compartment_start",
    "source_compartment_end",
    "created_at",
];

fn src(row: &SingleStoreSourceRow, name: &str) -> SqlValue {
    row.get(name).cloned().unwrap_or(SqlValue::Null)
}

fn as_i64(value: &SqlValue) -> Option<i64> {
    match value {
        SqlValue::Integer(value) => Some(*value),
        _ => None,
    }
}

fn as_text(value: &SqlValue) -> Option<&str> {
    match value {
        SqlValue::Text(value) => Some(value.as_str()),
        _ => None,
    }
}

fn text(value: &str) -> SqlValue {
    SqlValue::Text(value.to_string())
}

/// A total, stable spelling of a row, for multiset comparison.
fn row_key(values: &[SqlValue]) -> String {
    format!("{values:?}")
}

fn column_list(columns: &[&str]) -> String {
    columns.join(", ")
}

fn placeholders(count: usize, first: usize) -> String {
    (first..first + count)
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(", ")
}

fn assignments(columns: &[&str]) -> String {
    columns
        .iter()
        .enumerate()
        .map(|(index, column)| format!("{column} = ?{}", index + 1))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Read `columns` of every row `sql` selects; `sql` must select `id` followed by them.
fn read_rows(
    conn: &Connection,
    sql: &str,
    args: &[SqlValue],
    width: usize,
) -> Result<Vec<(i64, Vec<SqlValue>)>, rusqlite::Error> {
    let mut statement = conn.prepare(sql)?;
    let rows = statement
        .query_map(params_from_iter(args.iter()), |row| {
            let id: i64 = row.get(0)?;
            let mut values = Vec::with_capacity(width);
            for index in 0..width {
                values.push(row.get::<_, SqlValue>(index + 1)?);
            }
            Ok((id, values))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

// ── The source model ───────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct MemorySrc {
    store_id: i64,
    values: Vec<SqlValue>,
    superseded_store: Option<i64>,
    source_uuid: Option<String>,
    source_row: Option<i64>,
}

#[derive(Debug, Clone)]
struct NoteSrc {
    store_id: i64,
    values: Vec<SqlValue>,
    source_uuid: Option<String>,
    source_row: Option<i64>,
}

#[derive(Debug, Clone)]
struct EventSrc {
    values: Vec<SqlValue>,
    compartment_sequence: Option<i64>,
}

#[derive(Debug, Clone, Default)]
struct SessionSrc {
    /// Ordered by sequence.
    compartments: Vec<Vec<SqlValue>>,
    events: Vec<EventSrc>,
    candidates: Vec<Vec<SqlValue>>,
}

impl SessionSrc {
    fn compartment(&self, sequence: i64) -> Option<&Vec<SqlValue>> {
        self.compartments
            .iter()
            .find(|row| as_i64(&row[1]) == Some(sequence))
    }

    fn max_sequence(&self) -> Option<i64> {
        self.compartments
            .iter()
            .filter_map(|row| as_i64(&row[1]))
            .max()
    }
}

#[derive(Debug, Clone)]
struct Model {
    project: String,
    file_uuid: String,
    /// S(P): every session attributed to the project.
    sessions: BTreeSet<String>,
    /// Memories ordered so a superseding memory comes before the one it supersedes.
    memories: Vec<MemorySrc>,
    notes: Vec<NoteSrc>,
    primers: Vec<Vec<SqlValue>>,
    /// Sessions of S(P) with rows in a session-keyed store table.
    session_rows: BTreeMap<String, SessionSrc>,
}

/// The host-backed harness each session runs under, or the reason the project fails the
/// host-less predicate.
fn session_harnesses(
    conn: &Connection,
    project: &str,
    bound_sessions: &BTreeSet<String>,
) -> Result<Result<BTreeMap<String, String>, String>, MigrateRefusal> {
    let managed: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM authority_managed WHERE project_path = ?1)",
        params![project],
        |row| row.get(0),
    )?;
    if !managed {
        return Ok(Err(format!(
            "{project} has no authority_managed row, so no host has ever managed it"
        )));
    }
    let mut harnesses: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    {
        let mut statement = conn
            .prepare("SELECT session_id, harness FROM session_projects WHERE project_path = ?1")?;
        let rows = statement.query_map(params![project], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (session, harness) = row?;
            harnesses.entry(session).or_default().insert(harness);
        }
    }
    for session in bound_sessions {
        if !harnesses.contains_key(session) {
            return Ok(Err(format!(
                "store.db session {session} of {project} has no session_projects row, so its harness is unknown"
            )));
        }
    }
    let mut chosen = BTreeMap::new();
    for (session, set) in &harnesses {
        if let Some(foreign) = set
            .iter()
            .find(|harness| !HOST_BACKED_HARNESSES.contains(&harness.as_str()))
        {
            return Ok(Err(format!(
                "session {session} of {project} runs under harness {foreign}, which has no embedding host"
            )));
        }
        let harness = set.iter().next().cloned().unwrap_or_default();
        chosen.insert(session.clone(), harness);
    }
    Ok(Ok(chosen))
}

/// Order memories so every superseding memory is placed before the ones it supersedes,
/// letting a row's `superseded_by_memory_id` be translated in the same pass that writes it.
fn supersession_order(memories: Vec<MemorySrc>) -> Vec<MemorySrc> {
    let index: HashMap<i64, usize> = memories
        .iter()
        .enumerate()
        .map(|(position, memory)| (memory.store_id, position))
        .collect();
    let mut state = vec![0u8; memories.len()];
    let mut order = Vec::with_capacity(memories.len());
    for start in 0..memories.len() {
        let mut stack = vec![(start, false)];
        while let Some((node, expanded)) = stack.pop() {
            if expanded {
                state[node] = 2;
                order.push(node);
                continue;
            }
            if state[node] != 0 {
                continue;
            }
            state[node] = 1;
            stack.push((node, true));
            if let Some(target) = memories[node]
                .superseded_store
                .and_then(|target| index.get(&target))
            {
                if state[*target] == 0 {
                    stack.push((*target, false));
                }
            }
        }
    }
    let mut slots: Vec<Option<MemorySrc>> = memories.into_iter().map(Some).collect();
    order
        .into_iter()
        .filter_map(|position| slots[position].take())
        .collect()
}

fn note_status(status: &SqlValue) -> SqlValue {
    match as_text(status) {
        Some("surfacing") | Some("surfaced") => text("ready"),
        _ => status.clone(),
    }
}

fn build_model(
    project: &str,
    file_uuid: &str,
    sessions: BTreeSet<String>,
    harness: &BTreeMap<String, String>,
    source: mc_store::SingleStoreSource,
) -> Result<Model, MigrateRefusal> {
    let session_harness = |session: &str| -> Option<String> { harness.get(session).cloned() };
    let memories = source
        .memories
        .iter()
        .map(|row| MemorySrc {
            store_id: as_i64(&src(row, "id")).unwrap_or_default(),
            values: MEMORY_COLUMNS
                .iter()
                .enumerate()
                .map(|(index, column)| {
                    if index == MEMORY_SUPERSEDED {
                        SqlValue::Null
                    } else {
                        src(row, column)
                    }
                })
                .collect(),
            superseded_store: as_i64(&src(row, "superseded_by_memory_id")),
            source_uuid: as_text(&src(row, "context_store_uuid")).map(str::to_string),
            source_row: as_i64(&src(row, "context_row_id")),
        })
        .collect();
    let notes = source
        .notes
        .iter()
        .map(|row| {
            let session = as_text(&src(row, "session_id")).map(str::to_string);
            // The session's host harness; a note whose session is not the project's is
            // project-scoped, and the host stamps those 'opencode'.
            let note_harness = session
                .as_deref()
                .and_then(session_harness)
                .unwrap_or_else(|| "opencode".to_string());
            let values = NOTE_COLUMNS
                .iter()
                .map(|column| match *column {
                    "status" => note_status(&src(row, "status")),
                    "created_at" => src(row, "created_at_ms"),
                    "updated_at" => src(row, "updated_at_ms"),
                    "harness" => text(&note_harness),
                    other => src(row, other),
                })
                .collect();
            NoteSrc {
                store_id: as_i64(&src(row, "id")).unwrap_or_default(),
                values,
                source_uuid: as_text(&src(row, "context_store_uuid")).map(str::to_string),
                source_row: as_i64(&src(row, "context_row_id")),
            }
        })
        .collect();
    let mut primers = Vec::new();
    for row in &source.primer_candidates {
        let session = as_text(&src(row, "session_id"))
            .unwrap_or_default()
            .to_string();
        let Some(primer_harness) = session_harness(&session) else {
            return Err(MigrateRefusal::new(
                HOST_LESS,
                format!(
                    "primer candidate {} of {project} belongs to session {session}, which is not one of the project's sessions, so its harness is unknown",
                    as_i64(&src(row, "id")).unwrap_or_default()
                ),
            ));
        };
        primers.push(
            PRIMER_COLUMNS
                .iter()
                .map(|column| match *column {
                    "harness" => text(&primer_harness),
                    other => src(row, other),
                })
                .collect(),
        );
    }
    let mut session_rows: BTreeMap<String, SessionSrc> = BTreeMap::new();
    for (session, rows) in &source.compartments {
        let session_label = session_harness(session).unwrap_or_default();
        session_rows
            .entry(session.clone())
            .or_default()
            .compartments = rows
            .iter()
            .map(|row| {
                COMPARTMENT_COLUMNS
                    .iter()
                    .map(|column| match *column {
                        "harness" => text(&session_label),
                        "rebase_status" => text("ok"),
                        other => src(row, other),
                    })
                    .collect()
            })
            .collect();
    }
    for (session, rows) in &source.compartment_events {
        let session_label = session_harness(session).unwrap_or_default();
        session_rows.entry(session.clone()).or_default().events = rows
            .iter()
            .map(|row| EventSrc {
                values: EVENT_COLUMNS
                    .iter()
                    .map(|column| match *column {
                        "harness" => text(&session_label),
                        "compartment_id" => SqlValue::Null,
                        other => src(row, other),
                    })
                    .collect(),
                // The store keeps the compartment's sequence here, because its
                // compartments have no row id of their own.
                compartment_sequence: as_i64(&src(row, "compartment_id")),
            })
            .collect();
    }
    for (session, rows) in &source.user_memory_candidates {
        session_rows.entry(session.clone()).or_default().candidates = rows
            .iter()
            .map(|row| {
                CANDIDATE_COLUMNS
                    .iter()
                    .map(|column| src(row, column))
                    .collect()
            })
            .collect();
    }
    Ok(Model {
        project: project.to_string(),
        file_uuid: file_uuid.to_string(),
        sessions,
        memories: supersession_order(memories),
        notes,
        primers,
        session_rows,
    })
}

// ── Resolving a store row to its context row ───────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mapping {
    /// `mirror_identity` names the context row.
    Identity(i64),
    /// Found without an identity row; the write records one.
    Found(i64),
    /// No context row yet. `stale_identity` means an identity row points at a row that no
    /// longer exists and must be replaced.
    Missing { stale_identity: bool },
}

impl Mapping {
    fn context_id(self) -> Option<i64> {
        match self {
            Mapping::Identity(id) | Mapping::Found(id) => Some(id),
            Mapping::Missing { .. } => None,
        }
    }
}

fn identity_row(
    conn: &Connection,
    domain: &str,
    project: &str,
    store_id: i64,
) -> Result<Option<i64>, rusqlite::Error> {
    conn.query_row(
        "SELECT context_row_id FROM mirror_identity
          WHERE domain = ?1 AND module_project = ?2 AND module_row_id = ?3",
        params![domain, project, store_id],
        |row| row.get(0),
    )
    .optional()
}

/// Whether no `mirror_identity` row claims context row `id` yet. A row already mapped to
/// another store row is never matched again by the fallbacks below: the store can hold
/// two rows that read the same (a note seeded twice, say), and each needs its own twin.
fn unclaimed(conn: &Connection, domain: &str, id: i64) -> Result<bool, rusqlite::Error> {
    conn.query_row(
        "SELECT NOT EXISTS(SELECT 1 FROM mirror_identity WHERE domain = ?1 AND context_row_id = ?2)",
        params![domain, id],
        |row| row.get(0),
    )
}

/// Resolve a memory the way the mirror does: identity row, then the context id the row
/// was seeded from (same file only), then a unique match on the natural key.
fn resolve_memory(
    conn: &Connection,
    model: &Model,
    memory: &MemorySrc,
) -> Result<Mapping, MigrateRefusal> {
    let mut stale_identity = false;
    if let Some(context_id) = identity_row(conn, "memories", &model.project, memory.store_id)? {
        let owner: Option<String> = conn
            .query_row(
                "SELECT project_path FROM memories WHERE id = ?1",
                params![context_id],
                |row| row.get(0),
            )
            .optional()?;
        match owner {
            Some(owner) if owner == model.project => return Ok(Mapping::Identity(context_id)),
            Some(owner) => {
                return Err(MigrateRefusal::new(
                    VERIFY_MISMATCH,
                    format!(
                        "memory {} of {} is mapped to context row {context_id}, which belongs to {owner}",
                        memory.store_id, model.project
                    ),
                ))
            }
            None => stale_identity = true,
        }
    }
    if memory.source_uuid.as_deref() == Some(model.file_uuid.as_str()) {
        if let Some(source_row) = memory.source_row.filter(|id| *id >= 0) {
            let found: Option<i64> = conn
                .query_row(
                    "SELECT id FROM memories WHERE id = ?1 AND project_path = ?2",
                    params![source_row, model.project],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(id) = found {
                if unclaimed(conn, "memories", id)? {
                    return Ok(Mapping::Found(id));
                }
            }
        }
    }
    let category = memory.values[1].clone();
    let hash = memory.values[3].clone();
    if as_text(&hash).is_some_and(|hash| !hash.is_empty()) {
        let mut statement = conn.prepare(
            "SELECT id FROM memories
              WHERE project_path = ?1 AND category = ?2 AND normalized_hash = ?3 ORDER BY id",
        )?;
        let candidates = statement
            .query_map(params![model.project, category, hash], |row| {
                row.get::<_, i64>(0)
            })?
            .collect::<Result<Vec<_>, _>>()?;
        if let [only] = candidates.as_slice() {
            if unclaimed(conn, "memories", *only)? {
                return Ok(Mapping::Found(*only));
            }
        }
    }
    Ok(Mapping::Missing { stale_identity })
}

/// Whether context note `id` is inside the project's note scope: the project's own
/// notes, and project-less notes of the project's sessions.
fn note_in_scope(
    conn: &Connection,
    model: &Model,
    id: i64,
) -> Result<Option<bool>, rusqlite::Error> {
    let row: Option<(Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT project_path, session_id FROM notes WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    Ok(row.map(|(project, session)| match project {
        Some(project) => project == model.project,
        None => session.is_some_and(|session| model.sessions.contains(&session)),
    }))
}

/// Resolve a note: identity row, then the context id it was seeded from (same file, same
/// type, inside the project's note scope), then, for a note that belongs to a session, a
/// unique match on session, creation time and content. Session notes have no mirror key of
/// their own, so the last step is what keeps one that was seeded without an identity row
/// from being copied a second time.
fn resolve_note(
    conn: &Connection,
    model: &Model,
    note: &NoteSrc,
) -> Result<Mapping, MigrateRefusal> {
    let mut stale_identity = false;
    if let Some(context_id) = identity_row(conn, "notes", &model.project, note.store_id)? {
        match note_in_scope(conn, model, context_id)? {
            Some(true) => return Ok(Mapping::Identity(context_id)),
            Some(false) => {
                return Err(MigrateRefusal::new(
                    VERIFY_MISMATCH,
                    format!(
                        "note {} of {} is mapped to context row {context_id}, which is outside the project",
                        note.store_id, model.project
                    ),
                ))
            }
            None => stale_identity = true,
        }
    }
    if note.source_uuid.as_deref() == Some(model.file_uuid.as_str()) {
        if let Some(source_row) = note.source_row.filter(|id| *id >= 0) {
            let same_type: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM notes WHERE id = ?1 AND type IS ?2)",
                params![source_row, note.values[0]],
                |row| row.get(0),
            )?;
            if same_type
                && note_in_scope(conn, model, source_row)? == Some(true)
                && unclaimed(conn, "notes", source_row)?
            {
                return Ok(Mapping::Found(source_row));
            }
        }
    }
    let session = note.values[3].clone();
    if as_text(&session).is_some() {
        let mut statement = conn.prepare(
            "SELECT id FROM notes
              WHERE session_id = ?1 AND created_at = ?2 AND content = ?3 AND type IS ?4
              ORDER BY id",
        )?;
        let candidates = statement
            .query_map(
                params![session, note.values[6], note.values[2], note.values[0]],
                |row| row.get::<_, i64>(0),
            )?
            .collect::<Result<Vec<_>, _>>()?;
        let mut in_scope = Vec::new();
        for id in candidates {
            if note_in_scope(conn, model, id)? == Some(true) && unclaimed(conn, "notes", id)? {
                in_scope.push(id);
            }
        }
        if let [only] = in_scope.as_slice() {
            return Ok(Mapping::Found(*only));
        }
    }
    Ok(Mapping::Missing { stale_identity })
}

/// The context id `superseded_by_memory_id` must carry for `memory`.
fn translated_superseded(
    conn: &Connection,
    model: &Model,
    memory: &MemorySrc,
) -> Result<SqlValue, MigrateRefusal> {
    let Some(target) = memory.superseded_store else {
        return Ok(SqlValue::Null);
    };
    if let Some(target_memory) = model.memories.iter().find(|row| row.store_id == target) {
        return Ok(resolve_memory(conn, model, target_memory)?
            .context_id()
            .map_or(SqlValue::Null, SqlValue::Integer));
    }
    Ok(identity_row(conn, "memories", &model.project, target)?
        .map_or(SqlValue::Null, SqlValue::Integer))
}

fn desired_memory(
    conn: &Connection,
    model: &Model,
    memory: &MemorySrc,
) -> Result<Vec<SqlValue>, MigrateRefusal> {
    let mut values = memory.values.clone();
    values[MEMORY_SUPERSEDED] = translated_superseded(conn, model, memory)?;
    Ok(values)
}

fn read_by_id(
    conn: &Connection,
    table: &str,
    columns: &[&str],
    id: i64,
) -> Result<Option<Vec<SqlValue>>, rusqlite::Error> {
    Ok(read_rows(
        conn,
        &format!(
            "SELECT id, {} FROM {table} WHERE id = ?1",
            column_list(columns)
        ),
        &[SqlValue::Integer(id)],
        columns.len(),
    )?
    .into_iter()
    .next()
    .map(|(_, values)| values))
}

fn context_compartment_id(
    conn: &Connection,
    session: &str,
    sequence: i64,
) -> Result<Option<i64>, rusqlite::Error> {
    conn.query_row(
        "SELECT id FROM compartments WHERE session_id = ?1 AND sequence = ?2",
        params![session, sequence],
        |row| row.get(0),
    )
    .optional()
}

fn desired_event(
    conn: &Connection,
    session: &str,
    event: &EventSrc,
) -> Result<Vec<SqlValue>, rusqlite::Error> {
    let mut values = event.values.clone();
    values[EVENT_COMPARTMENT_ID] = match event.compartment_sequence {
        Some(sequence) => context_compartment_id(conn, session, sequence)?
            .map_or(SqlValue::Null, SqlValue::Integer),
        None => SqlValue::Null,
    };
    Ok(values)
}

fn session_rows(
    conn: &Connection,
    table: &str,
    columns: &[&str],
    session: &str,
) -> Result<Vec<(i64, Vec<SqlValue>)>, rusqlite::Error> {
    read_rows(
        conn,
        &format!(
            "SELECT id, {} FROM {table} WHERE session_id = ?1 ORDER BY id",
            column_list(columns)
        ),
        &[text(session)],
        columns.len(),
    )
}

/// The context compartment at `sequence`, compared fields only.
fn context_compartment(
    conn: &Connection,
    session: &str,
    sequence: i64,
) -> Result<Option<(i64, Vec<SqlValue>)>, rusqlite::Error> {
    Ok(read_rows(
        conn,
        &format!(
            "SELECT id, {} FROM compartments WHERE session_id = ?1 AND sequence = ?2",
            column_list(COMPARTMENT_COLUMNS)
        ),
        &[text(session), SqlValue::Integer(sequence)],
        COMPARTMENT_COLUMNS.len(),
    )?
    .into_iter()
    .next())
}

/// What `store.db` says about a context compartment a history row points at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CompartmentFate {
    /// The store still has it, saying the same thing.
    Unchanged,
    /// The store rewrote it, or truncated the session below it.
    Superseded,
    /// Neither can be shown.
    Unknown,
    /// The row points at a compartment id that no longer exists in `context.db`. Compartment
    /// ids are never reused (AUTOINCREMENT), and `store.db` keys compartments by sequence,
    /// so no compartment in either store can be the one the row meant: it is history left
    /// behind by an earlier rewrite, not a row the move could misattribute.
    Orphan,
}

fn compartment_fate(
    session: &SessionSrc,
    context_values: Option<&Vec<SqlValue>>,
    sequence: i64,
) -> CompartmentFate {
    let Some(max) = session.max_sequence() else {
        return CompartmentFate::Unknown;
    };
    match (session.compartment(sequence), context_values) {
        (Some(store), Some(context)) => {
            if store[COMPARTMENT_CONTENT_FIELDS] == context[COMPARTMENT_CONTENT_FIELDS] {
                CompartmentFate::Unchanged
            } else {
                CompartmentFate::Superseded
            }
        }
        (None, _) if sequence > max => CompartmentFate::Superseded,
        _ => CompartmentFate::Unknown,
    }
}

/// Classify a context event with no store counterpart by the compartment it points at.
fn event_fate(
    conn: &Connection,
    session_id: &str,
    session: &SessionSrc,
    values: &[SqlValue],
) -> Result<CompartmentFate, rusqlite::Error> {
    let Some(compartment_id) = as_i64(&values[EVENT_COMPARTMENT_ID]) else {
        return Ok(CompartmentFate::Unknown);
    };
    let row: Option<(String, i64)> = conn
        .query_row(
            "SELECT session_id, sequence FROM compartments WHERE id = ?1",
            params![compartment_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((owner, sequence)) = row else {
        return Ok(CompartmentFate::Orphan);
    };
    if owner != session_id {
        return Ok(CompartmentFate::Unknown);
    }
    let context = context_compartment(conn, session_id, sequence)?.map(|(_, values)| values);
    Ok(compartment_fate(session, context.as_ref(), sequence))
}

/// Classify a context user-memory candidate with no store counterpart by the compartment
/// range it was drawn from: superseded if any of them was rewritten or truncated away,
/// unchanged only if every one is still the same.
fn candidate_fate(
    conn: &Connection,
    session_id: &str,
    session: &SessionSrc,
    values: &[SqlValue],
) -> Result<CompartmentFate, rusqlite::Error> {
    let (Some(start), Some(end)) = (as_i64(&values[2]), as_i64(&values[3])) else {
        return Ok(CompartmentFate::Unknown);
    };
    if end < start || end - start > 10_000 {
        return Ok(CompartmentFate::Unknown);
    }
    let mut fate = CompartmentFate::Unchanged;
    for sequence in start..=end {
        let context = context_compartment(conn, session_id, sequence)?.map(|(_, values)| values);
        match compartment_fate(session, context.as_ref(), sequence) {
            CompartmentFate::Superseded => return Ok(CompartmentFate::Superseded),
            CompartmentFate::Unknown | CompartmentFate::Orphan => fate = CompartmentFate::Unknown,
            CompartmentFate::Unchanged => {}
        }
    }
    Ok(fate)
}

/// Match a session's desired history rows against its context rows as multisets.
/// Returns the indexes of desired rows with no context twin and the context rows with no
/// desired twin.
fn match_multiset(
    desired: &[Vec<SqlValue>],
    context: &[(i64, Vec<SqlValue>)],
) -> (Vec<usize>, Vec<(i64, Vec<SqlValue>)>) {
    let mut available: HashMap<String, Vec<usize>> = HashMap::new();
    for (position, (_, values)) in context.iter().enumerate() {
        available.entry(row_key(values)).or_default().push(position);
    }
    let mut used = vec![false; context.len()];
    let mut missing = Vec::new();
    for (index, values) in desired.iter().enumerate() {
        match available.get_mut(&row_key(values)).and_then(Vec::pop) {
            Some(position) => used[position] = true,
            None => missing.push(index),
        }
    }
    let unmatched = context
        .iter()
        .zip(used)
        .filter(|(_, used)| !used)
        .map(|(row, _)| row.clone())
        .collect();
    (missing, unmatched)
}

// ── Work items ─────────────────────────────────────────────────────────────

/// One row-level unit of copy work. Items are applied in plan order, and each one
/// re-derives what to write inside its transaction, so applying an item twice writes once.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
enum Item {
    Memory(usize),
    Note(usize),
    Primer(usize),
    /// Delete a context candidate that `store.db` proves superseded.
    CandidateDelete {
        session: String,
        id: i64,
    },
    /// Copy the store candidate at this index of its session.
    Candidate {
        session: String,
        index: usize,
    },
    /// Delete a context event that `store.db` proves superseded.
    EventDelete {
        session: String,
        id: i64,
    },
    /// Delete the session's context compartments above the store's last sequence.
    CompartmentTrim {
        session: String,
    },
    Compartment {
        session: String,
        sequence: i64,
    },
    /// Copy the store event at this index of its session.
    Event {
        session: String,
        index: usize,
    },
}

impl Item {
    fn table(&self) -> &'static str {
        match self {
            Item::Memory(_) => "memories",
            Item::Note(_) => "notes",
            Item::Primer(_) => "primer_candidates",
            Item::CandidateDelete { .. } | Item::Candidate { .. } => "user_memory_candidates",
            Item::EventDelete { .. } | Item::Event { .. } => "compartment_events",
            Item::CompartmentTrim { .. } | Item::Compartment { .. } => "compartments",
        }
    }

    /// Staged rows stand alone; session rows make up a session's visible history and are
    /// chunked under the larger visibility budget.
    fn is_staged(&self) -> bool {
        matches!(
            self,
            Item::Memory(_)
                | Item::Note(_)
                | Item::Primer(_)
                | Item::CandidateDelete { .. }
                | Item::Candidate { .. }
        )
    }
}

const REPORT_TABLES: &[&str] = &[
    "memories",
    "notes",
    "primer_candidates",
    "user_memory_candidates",
    "compartments",
    "compartment_events",
];

struct Plan {
    items: Vec<Item>,
    counts: BTreeMap<String, TableCounts>,
}

fn primer_row(
    conn: &Connection,
    desired: &[SqlValue],
) -> Result<Option<(i64, Vec<SqlValue>)>, rusqlite::Error> {
    Ok(read_rows(
        conn,
        &format!(
            "SELECT id, {} FROM primer_candidates
              WHERE project_path = ?1 AND harness = ?2 AND session_id = ?3
                AND source_start_message_id = ?4 AND source_end_message_id = ?5",
            column_list(PRIMER_COLUMNS)
        ),
        &[
            desired[0].clone(),
            desired[1].clone(),
            desired[2].clone(),
            desired[7].clone(),
            desired[8].clone(),
        ],
        PRIMER_COLUMNS.len(),
    )?
    .into_iter()
    .next())
}

fn desired_events(
    conn: &Connection,
    session_id: &str,
    session: &SessionSrc,
) -> Result<Vec<Vec<SqlValue>>, rusqlite::Error> {
    session
        .events
        .iter()
        .map(|event| desired_event(conn, session_id, event))
        .collect()
}

/// How many times `values` occurs in `rows`.
fn occurrences(rows: &[Vec<SqlValue>], values: &[SqlValue]) -> usize {
    rows.iter().filter(|row| row.as_slice() == values).count()
}

fn unclassified(session: &str, table: &str, id: i64) -> MigrateRefusal {
    MigrateRefusal::new(
        UNCLASSIFIED_ROWS,
        format!(
            "context.db {table} row {id} of session {session} has no store.db counterpart and cannot be shown to be either current or superseded"
        ),
    )
}

/// Everything that still differs between the project's store rows and `context.db`, in
/// the order it must be written.
fn plan(conn: &Connection, model: &Model) -> Result<Plan, MigrateRefusal> {
    let mut items = Vec::new();
    let mut counts: BTreeMap<String, TableCounts> = REPORT_TABLES
        .iter()
        .map(|table| (table.to_string(), TableCounts::default()))
        .collect();
    fn note_row(counts: &mut BTreeMap<String, TableCounts>, table: &str, pending: bool) {
        let entry = counts.entry(table.to_string()).or_default();
        entry.source += 1;
        if pending {
            entry.copied += 1;
        } else {
            entry.skipped += 1;
        }
    }
    // A memory whose superseding memory is about to be written must be written too: its
    // translated reference only exists once that memory has its context id.
    let mut pending_memories = BTreeSet::new();
    for index in 0..model.memories.len() {
        let memory = &model.memories[index];
        let pending = item_pending(conn, model, &Item::Memory(index))?
            || memory
                .superseded_store
                .is_some_and(|target| pending_memories.contains(&target));
        if pending {
            pending_memories.insert(memory.store_id);
        }
        note_row(&mut counts, "memories", pending);
        if pending {
            items.push(Item::Memory(index));
        }
    }
    for index in 0..model.notes.len() {
        let pending = item_pending(conn, model, &Item::Note(index))?;
        note_row(&mut counts, "notes", pending);
        if pending {
            items.push(Item::Note(index));
        }
    }
    for index in 0..model.primers.len() {
        let pending = item_pending(conn, model, &Item::Primer(index))?;
        note_row(&mut counts, "primer_candidates", pending);
        if pending {
            items.push(Item::Primer(index));
        }
    }
    // Every classification below reads compartments as they are before this run touches
    // them, which is why all candidate work is planned ahead of any compartment write.
    for (session_id, session) in &model.session_rows {
        let context = session_rows(
            conn,
            "user_memory_candidates",
            CANDIDATE_COLUMNS,
            session_id,
        )?;
        let (missing, unmatched) = match_multiset(&session.candidates, &context);
        for (id, values) in &unmatched {
            match candidate_fate(conn, session_id, session, values)? {
                CompartmentFate::Unchanged => {
                    counts.get_mut("user_memory_candidates").unwrap().kept += 1;
                }
                CompartmentFate::Superseded => items.push(Item::CandidateDelete {
                    session: session_id.clone(),
                    id: *id,
                }),
                CompartmentFate::Unknown | CompartmentFate::Orphan => {
                    return Err(unclassified(session_id, "user_memory_candidates", *id))
                }
            }
        }
        for index in 0..session.candidates.len() {
            note_row(
                &mut counts,
                "user_memory_candidates",
                missing.contains(&index),
            );
        }
        items.extend(missing.into_iter().map(|index| Item::Candidate {
            session: session_id.clone(),
            index,
        }));
    }
    for (session_id, session) in &model.session_rows {
        let desired = desired_events(conn, session_id, session)?;
        let context = session_rows(conn, "compartment_events", EVENT_COLUMNS, session_id)?;
        let (missing, unmatched) = match_multiset(&desired, &context);
        for (id, values) in &unmatched {
            match event_fate(conn, session_id, session, values)? {
                CompartmentFate::Unchanged => {
                    counts.get_mut("compartment_events").unwrap().kept += 1;
                }
                CompartmentFate::Superseded => items.push(Item::EventDelete {
                    session: session_id.clone(),
                    id: *id,
                }),
                // Left in place, neither copied nor deleted, and counted.
                CompartmentFate::Orphan => {
                    counts.get_mut("compartment_events").unwrap().orphans_kept += 1;
                }
                CompartmentFate::Unknown => {
                    return Err(unclassified(session_id, "compartment_events", *id))
                }
            }
        }
        let trim = Item::CompartmentTrim {
            session: session_id.clone(),
        };
        if item_pending(conn, model, &trim)? {
            items.push(trim);
        }
        for row in &session.compartments {
            let sequence = as_i64(&row[1]).unwrap_or_default();
            let item = Item::Compartment {
                session: session_id.clone(),
                sequence,
            };
            let pending = item_pending(conn, model, &item)?;
            note_row(&mut counts, "compartments", pending);
            if pending {
                items.push(item);
            }
        }
        for index in 0..session.events.len() {
            note_row(&mut counts, "compartment_events", missing.contains(&index));
        }
        items.extend(missing.into_iter().map(|index| Item::Event {
            session: session_id.clone(),
            index,
        }));
    }
    Ok(Plan { items, counts })
}

fn session_of<'a>(model: &'a Model, session: &str) -> &'a SessionSrc {
    model
        .session_rows
        .get(session)
        .expect("items only name sessions of the model")
}

/// Whether `item` still has something to write.
fn item_pending(conn: &Connection, model: &Model, item: &Item) -> Result<bool, MigrateRefusal> {
    Ok(match item {
        Item::Memory(index) => {
            let memory = &model.memories[*index];
            match resolve_memory(conn, model, memory)? {
                Mapping::Missing { .. } | Mapping::Found(_) => true,
                Mapping::Identity(id) => {
                    read_by_id(conn, "memories", MEMORY_COLUMNS, id)?
                        != Some(desired_memory(conn, model, memory)?)
                }
            }
        }
        Item::Note(index) => {
            let note = &model.notes[*index];
            match resolve_note(conn, model, note)? {
                Mapping::Missing { .. } | Mapping::Found(_) => true,
                Mapping::Identity(id) => {
                    read_by_id(conn, "notes", NOTE_COLUMNS, id)? != Some(note.values.clone())
                }
            }
        }
        Item::Primer(index) => {
            let desired = &model.primers[*index];
            primer_row(conn, desired)?.map(|(_, values)| values) != Some(desired.clone())
        }
        Item::CandidateDelete { session, id } => {
            row_exists(conn, "user_memory_candidates", session, *id)?
        }
        Item::EventDelete { session, id } => row_exists(conn, "compartment_events", session, *id)?,
        Item::Candidate { session, index } => {
            let rows = &session_of(model, session).candidates;
            let wanted = occurrences(&rows[..=*index], &rows[*index]);
            let context: Vec<Vec<SqlValue>> =
                session_rows(conn, "user_memory_candidates", CANDIDATE_COLUMNS, session)?
                    .into_iter()
                    .map(|(_, values)| values)
                    .collect();
            occurrences(&context, &rows[*index]) < wanted
        }
        Item::Event { session, index } => {
            let desired = desired_events(conn, session, session_of(model, session))?;
            let wanted = occurrences(&desired[..=*index], &desired[*index]);
            let context: Vec<Vec<SqlValue>> =
                session_rows(conn, "compartment_events", EVENT_COLUMNS, session)?
                    .into_iter()
                    .map(|(_, values)| values)
                    .collect();
            occurrences(&context, &desired[*index]) < wanted
        }
        Item::CompartmentTrim { session } => match session_of(model, session).max_sequence() {
            Some(max) => conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM compartments WHERE session_id = ?1 AND sequence > ?2)",
                params![session, max],
                |row| row.get::<_, bool>(0),
            )?,
            None => false,
        },
        Item::Compartment { session, sequence } => {
            let desired = session_of(model, session)
                .compartment(*sequence)
                .expect("planned from the model");
            context_compartment(conn, session, *sequence)?.map(|(_, values)| values)
                != Some(desired.clone())
        }
    })
}

fn row_exists(
    conn: &Connection,
    table: &str,
    session: &str,
    id: i64,
) -> Result<bool, rusqlite::Error> {
    conn.query_row(
        &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE id = ?1 AND session_id = ?2)"),
        params![id, session],
        |row| row.get(0),
    )
}

fn insert_row(
    tx: &Transaction<'_>,
    table: &str,
    columns: &[&str],
    values: &[SqlValue],
) -> Result<i64, rusqlite::Error> {
    tx.execute(
        &format!(
            "INSERT INTO {table} ({}) VALUES ({})",
            column_list(columns),
            placeholders(columns.len(), 1)
        ),
        params_from_iter(values.iter()),
    )?;
    Ok(tx.last_insert_rowid())
}

fn update_row(
    tx: &Transaction<'_>,
    table: &str,
    columns: &[&str],
    values: &[SqlValue],
    id: i64,
) -> Result<(), rusqlite::Error> {
    let mut args: Vec<SqlValue> = values.to_vec();
    args.push(SqlValue::Integer(id));
    tx.execute(
        &format!(
            "UPDATE {table} SET {} WHERE id = ?{}",
            assignments(columns),
            columns.len() + 1
        ),
        params_from_iter(args.iter()),
    )?;
    Ok(())
}

fn remember_identity(
    tx: &Transaction<'_>,
    domain: &str,
    project: &str,
    store_id: i64,
    context_id: i64,
) -> Result<(), rusqlite::Error> {
    tx.execute(
        "INSERT OR IGNORE INTO mirror_identity(domain, module_project, module_row_id, context_row_id)
         VALUES (?1, ?2, ?3, ?4)",
        params![domain, project, store_id, context_id],
    )?;
    Ok(())
}

fn forget_identity(
    tx: &Transaction<'_>,
    domain: &str,
    project: &str,
    store_id: i64,
) -> Result<(), rusqlite::Error> {
    tx.execute(
        "DELETE FROM mirror_identity WHERE domain = ?1 AND module_project = ?2 AND module_row_id = ?3",
        params![domain, project, store_id],
    )?;
    Ok(())
}

#[derive(Debug, Default, Clone, Copy)]
struct Applied {
    written: usize,
    deleted: usize,
    inserted_memory: Option<i64>,
}

/// Write whatever `item` still needs, inside the caller's transaction.
fn apply_item(tx: &Transaction<'_>, model: &Model, item: &Item) -> Result<Applied, MigrateRefusal> {
    let mut applied = Applied::default();
    match item {
        Item::Memory(index) => {
            let memory = &model.memories[*index];
            let desired = desired_memory(tx, model, memory)?;
            match resolve_memory(tx, model, memory)? {
                Mapping::Missing { stale_identity } => {
                    if stale_identity {
                        forget_identity(tx, "memories", &model.project, memory.store_id)?;
                    }
                    let id = insert_row(tx, "memories", MEMORY_COLUMNS, &desired)?;
                    remember_identity(tx, "memories", &model.project, memory.store_id, id)?;
                    applied.written = 1;
                    applied.inserted_memory = Some(id);
                }
                Mapping::Found(id) | Mapping::Identity(id) => {
                    if read_by_id(tx, "memories", MEMORY_COLUMNS, id)? != Some(desired.clone()) {
                        update_row(tx, "memories", MEMORY_COLUMNS, &desired, id)?;
                        applied.written = 1;
                    }
                    remember_identity(tx, "memories", &model.project, memory.store_id, id)?;
                }
            }
        }
        Item::Note(index) => {
            let note = &model.notes[*index];
            match resolve_note(tx, model, note)? {
                Mapping::Missing { stale_identity } => {
                    if stale_identity {
                        forget_identity(tx, "notes", &model.project, note.store_id)?;
                    }
                    let id = insert_row(tx, "notes", NOTE_COLUMNS, &note.values)?;
                    remember_identity(tx, "notes", &model.project, note.store_id, id)?;
                    applied.written = 1;
                }
                Mapping::Found(id) | Mapping::Identity(id) => {
                    if read_by_id(tx, "notes", NOTE_COLUMNS, id)? != Some(note.values.clone()) {
                        update_row(tx, "notes", NOTE_COLUMNS, &note.values, id)?;
                        applied.written = 1;
                    }
                    remember_identity(tx, "notes", &model.project, note.store_id, id)?;
                }
            }
        }
        Item::Primer(index) => {
            let desired = &model.primers[*index];
            match primer_row(tx, desired)? {
                Some((_, values)) if &values == desired => {}
                Some((id, _)) => {
                    update_row(tx, "primer_candidates", PRIMER_COLUMNS, desired, id)?;
                    applied.written = 1;
                }
                None => {
                    insert_row(tx, "primer_candidates", PRIMER_COLUMNS, desired)?;
                    applied.written = 1;
                }
            }
        }
        Item::CandidateDelete { session, id } | Item::EventDelete { session, id } => {
            let table = item.table();
            applied.deleted = tx.execute(
                &format!("DELETE FROM {table} WHERE id = ?1 AND session_id = ?2"),
                params![id, session],
            )?;
        }
        Item::Candidate { .. } | Item::Event { .. } => {
            if item_pending(tx, model, item)? {
                let (table, columns, values) = match item {
                    Item::Candidate { session, index } => (
                        "user_memory_candidates",
                        CANDIDATE_COLUMNS,
                        session_of(model, session).candidates[*index].clone(),
                    ),
                    Item::Event { session, index } => (
                        "compartment_events",
                        EVENT_COLUMNS,
                        desired_event(tx, session, &session_of(model, session).events[*index])?,
                    ),
                    _ => unreachable!("matched above"),
                };
                insert_row(tx, table, columns, &values)?;
                applied.written = 1;
            }
        }
        Item::CompartmentTrim { session } => {
            if let Some(max) = session_of(model, session).max_sequence() {
                applied.deleted = tx.execute(
                    "DELETE FROM compartments WHERE session_id = ?1 AND sequence > ?2",
                    params![session, max],
                )?;
            }
        }
        Item::Compartment { session, sequence } => {
            let desired = session_of(model, session)
                .compartment(*sequence)
                .expect("planned from the model")
                .clone();
            match context_compartment(tx, session, *sequence)? {
                Some((_, values)) if values == desired => {}
                Some((id, values)) => {
                    update_row(tx, "compartments", COMPARTMENT_COLUMNS, &desired, id)?;
                    // The P1 embedding describes the old text; the host backfill
                    // re-embeds a row whose embedding is empty.
                    if values[8] != desired[8] {
                        tx.execute(
                            "UPDATE compartments SET p1_embedding = NULL, p1_embedding_model_id = NULL
                              WHERE id = ?1",
                            params![id],
                        )?;
                    }
                    applied.written = 1;
                }
                None => {
                    insert_row(tx, "compartments", COMPARTMENT_COLUMNS, &desired)?;
                    applied.written = 1;
                }
            }
        }
    }
    Ok(applied)
}

/// Apply a chunk of items; raise the embedding watermark for any memory it inserted.
/// Returns what each item did, to be counted once the chunk has committed.
fn apply_chunk_items(
    tx: &Transaction<'_>,
    model: &Model,
    items: &[Item],
) -> Result<Vec<(&'static str, Applied)>, MigrateRefusal> {
    let mut highest_memory = None;
    let mut tallies: Vec<(&'static str, Applied)> = Vec::new();
    for item in items {
        let applied = apply_item(tx, model, item)?;
        if let Some(id) = applied.inserted_memory {
            highest_memory = Some(highest_memory.map_or(id, |current: i64| current.max(id)));
        }
        tallies.push((item.table(), applied));
    }
    if let Some(id) = highest_memory {
        host_store::raise_embedding_watermark(tx, &model.project, id, now_ms())?;
    }
    Ok(tallies)
}

/// Add a committed chunk's tallies to the report's counts.
fn count_applied(counts: &mut BTreeMap<String, TableCounts>, tallies: &[(&'static str, Applied)]) {
    for (table, applied) in tallies {
        let entry = counts.entry(table.to_string()).or_default();
        entry.deleted += applied.deleted;
        entry.written += applied.written;
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}

// ── Gate, verification and drift ───────────────────────────────────────────

/// The marker-write gate: the file carries the marker lane, this binary was built at or
/// above it, and every table the move writes is the schema this binary knows.
fn check_marker_gate(
    conn: &Connection,
    fence: &host_store::FenceState,
) -> Result<(), MigrateRefusal> {
    let lane_present: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = ?1)",
            params![MARKER_LANE_VERSION],
            |row| row.get(0),
        )
        .unwrap_or(false);
    if !lane_present || fence.built_version < MARKER_LANE_VERSION {
        return Err(MigrateRefusal::new(
            MARKER_WRITE_REFUSED,
            format!(
                "a marker needs context.db migration {MARKER_LANE_VERSION} applied (applied: {lane_present}) and a module built at fence {MARKER_LANE_VERSION} or later (built: {})",
                fence.built_version
            ),
        ));
    }
    for table in [BRACKET_TABLE, MARKER_TABLE]
        .iter()
        .chain(COPY_DOMAIN_TABLES.iter())
    {
        fence
            .check_table(table)
            .map_err(|error| MigrateRefusal::new(FINGERPRINT_MISMATCH, error.to_string()))?;
    }
    check_auxiliary_fingerprints(conn)
}

fn check_auxiliary_fingerprints(conn: &Connection) -> Result<(), MigrateRefusal> {
    for (table, expected) in COPY_AUXILIARY_FINGERPRINTS {
        let found = host_store::read_table_fingerprint(conn, table)?;
        if found.as_deref() != Some(*expected) {
            return Err(MigrateRefusal::new(
                FINGERPRINT_MISMATCH,
                format!(
                    "context.db table {table} has schema fingerprint {}, not the {expected} this module was built against",
                    found.as_deref().unwrap_or("(missing)")
                ),
            ));
        }
    }
    Ok(())
}

fn context_store_uuid(conn: &Connection) -> Result<Option<String>, rusqlite::Error> {
    conn.query_row(
        "SELECT value FROM context_store_meta WHERE key = 'store_uuid'",
        [],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map(|value| value.filter(|value| !value.is_empty()))
}

fn is_marked(conn: &Connection, project: &str) -> Result<bool, rusqlite::Error> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM single_store_projects WHERE project_path = ?1)",
        params![project],
        |row| row.get(0),
    )
}

fn mismatch(detail: impl Into<String>) -> MigrateRefusal {
    MigrateRefusal::new(VERIFY_MISMATCH, detail)
}

fn describe(items: &[Item]) -> String {
    let shown: Vec<String> = items
        .iter()
        .take(5)
        .map(|item| format!("{item:?}"))
        .collect();
    format!("{} rows differ, first: {}", items.len(), shown.join(", "))
}

/// Re-read everything the run wrote. Only the held-back final chunk may still differ;
/// anything else, a context row in the project's scope with no source, or two sources
/// sharing one context row, is a mismatch.
fn verify(conn: &Connection, model: &Model, held: &[Item]) -> Result<(), MigrateRefusal> {
    let pending = plan(conn, model)?.items;
    let stray: Vec<Item> = pending
        .into_iter()
        .filter(|item| !held.contains(item))
        .collect();
    if !stray.is_empty() {
        return Err(mismatch(describe(&stray)));
    }
    let mut mapped_memories = BTreeMap::new();
    for memory in &model.memories {
        if let Some(id) = resolve_memory(conn, model, memory)?.context_id() {
            if let Some(other) = mapped_memories.insert(id, memory.store_id) {
                return Err(mismatch(format!(
                    "store memories {other} and {} both resolve to context memory {id}",
                    memory.store_id
                )));
            }
        }
    }
    let mut statement = conn.prepare("SELECT id FROM memories WHERE project_path = ?1")?;
    let extras: Vec<i64> = statement
        .query_map(params![model.project], |row| row.get::<_, i64>(0))?
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .filter(|id| !mapped_memories.contains_key(id))
        .collect();
    if !extras.is_empty() {
        return Err(mismatch(format!(
            "context memories {extras:?} of {} have no store.db source",
            model.project
        )));
    }
    let mut mapped_notes = BTreeMap::new();
    for note in &model.notes {
        if let Some(id) = resolve_note(conn, model, note)?.context_id() {
            if let Some(other) = mapped_notes.insert(id, note.store_id) {
                return Err(mismatch(format!(
                    "store notes {other} and {} both resolve to context note {id}",
                    note.store_id
                )));
            }
        }
    }
    let mut scoped_notes: Vec<i64> = conn
        .prepare("SELECT id FROM notes WHERE project_path = ?1")?
        .query_map(params![model.project], |row| row.get::<_, i64>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    {
        let mut by_session =
            conn.prepare("SELECT id FROM notes WHERE project_path IS NULL AND session_id = ?1")?;
        for session in &model.sessions {
            for id in by_session.query_map(params![session], |row| row.get::<_, i64>(0))? {
                scoped_notes.push(id?);
            }
        }
    }
    let extras: Vec<i64> = scoped_notes
        .into_iter()
        .filter(|id| !mapped_notes.contains_key(id))
        .collect();
    if !extras.is_empty() {
        return Err(mismatch(format!(
            "context notes {extras:?} of {} have no store.db source",
            model.project
        )));
    }
    Ok(())
}

/// What the final transaction checks is unchanged since verification began.
#[derive(Debug, Clone, PartialEq, Eq)]
struct DriftSnapshot {
    epochs: (i64, i64),
    sessions: BTreeMap<String, (i64, i64)>,
}

fn drift_snapshot(conn: &Connection, model: &Model) -> Result<DriftSnapshot, rusqlite::Error> {
    let epoch = |domain: &str| -> Result<i64, rusqlite::Error> {
        conn.query_row(
            "SELECT COALESCE((SELECT epoch FROM domain_mutation_epoch
                               WHERE project_path = ?1 AND domain = ?2), 0)",
            params![model.project, domain],
            |row| row.get(0),
        )
    };
    let mut sessions = BTreeMap::new();
    for session in model.session_rows.keys() {
        let shape: (i64, i64) = conn.query_row(
            "SELECT COALESCE(MAX(sequence), 0), COUNT(*) FROM compartments WHERE session_id = ?1",
            params![session],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        sessions.insert(session.clone(), shape);
    }
    Ok(DriftSnapshot {
        epochs: (epoch("memories")?, epoch("notes")?),
        sessions,
    })
}

// ── The run ────────────────────────────────────────────────────────────────

/// Run `inner` as one privileged, project- and session-scoped transaction on `context.db`,
/// returning its value and how long it held the write lock.
fn copy_transaction<T>(
    host: &mut HostStore,
    model: &Model,
    tables: &[&str],
    inner: impl FnOnce(&Transaction<'_>) -> Result<T, MigrateRefusal>,
) -> Result<(T, i64), MigrateRefusal> {
    let mut refusal = None;
    let (conn, fence) = host.connection_and_fence();
    let fence = fence.clone();
    let result = host_store::counted(host_store::with_scoped_privileged_transaction(
        conn,
        &fence,
        tables,
        &model.project,
        Some(&model.sessions),
        |tx| {
            check_auxiliary_fingerprints(tx)
                .and_then(|()| inner(tx))
                .map_err(|error| {
                    refusal = Some(error);
                    // Any error rolls the transaction back; the refusal above is what the
                    // caller reports.
                    HostStoreError::PrivilegeFlipFailed {
                        reason: "copy transaction refused".to_string(),
                    }
                })
        },
    ));
    match (result, refusal) {
        (_, Some(refusal)) => Err(refusal),
        (Ok(value), None) => Ok(value),
        (Err(error), None) => Err(error.into()),
    }
}

fn phase_row(
    store: &McStore,
    model: &Model,
    phase: &str,
    started_at: i64,
    generation: i64,
) -> SingleStoreMigrationRow {
    let _ = store;
    SingleStoreMigrationRow {
        project: model.project.clone(),
        context_store_uuid: model.file_uuid.clone(),
        phase: phase.to_string(),
        copy_generation: generation,
        cursor_json: "{}".to_string(),
        started_at,
        updated_at: now_ms(),
        marker_committed_at: None,
        refusal_code: None,
        refusal_detail: None,
    }
}

/// Neutralise `project` in `store.db` if the marker exists but the store still reads as
/// the project's owner. Returns whether anything changed.
fn complete_neutralisation(
    store: &McStore,
    file_uuid: &str,
    project: &str,
    build: &str,
) -> Result<bool, MigrateRefusal> {
    let phase_done = store
        .single_store_migration(project)?
        .is_some_and(|row| row.phase == "neutralized");
    let mut owned = false;
    for domain in ["memories", "notes"] {
        if store
            .authority_status(file_uuid, project, domain)?
            .is_some_and(|row| row.state != "TS")
        {
            owned = true;
        }
    }
    if phase_done && !owned {
        return Ok(false);
    }
    store.neutralize_single_store_project(file_uuid, project, build, now_ms())?;
    Ok(true)
}

/// Move `request.project` into `context.db`.
pub fn run(
    store: &McStore,
    request: &MigrateRequest,
    options: &MigrateOptions,
    observer: &mut dyn MigrateObserver,
) -> Result<MigrateReport, MigrateRefusal> {
    if !options.cutover_present() {
        return Err(MigrateRefusal::new(
            CUTOVER_ABSENT,
            "this build still serves every project from store.db, so a moved project would be served stale; it cannot move one",
        ));
    }
    let project = request.project.as_str();
    let mut report = MigrateReport {
        project: project.to_string(),
        ..MigrateReport::default()
    };
    let mut host = HostStore::open_with_fence(&options.context_db, options.built_fence)?;
    let file_uuid = {
        let (conn, fence) = host.connection_and_fence();
        check_marker_gate(conn, fence)?;
        let Some(file_uuid) = context_store_uuid(conn)? else {
            return Err(MigrateRefusal::new(
                MARKER_WRITE_REFUSED,
                "context.db has no store_uuid, so the marker could not name its file",
            ));
        };
        if is_marked(conn, project)? {
            report.status = "already_marked".to_string();
            if !request.dry_run {
                report.neutralized =
                    complete_neutralisation(store, &file_uuid, project, &options.build_version)?;
            }
            return Ok(report);
        }
        file_uuid
    };
    if let Some(row) = store.single_store_migration(project)? {
        if row.phase == "refused" && !request.retry {
            return Err(MigrateRefusal::new(
                row.refusal_code.as_deref().unwrap_or(VERIFY_MISMATCH),
                format!(
                    "{}; the last run for {project} was refused, re-run with --retry to repair and try again",
                    row.refusal_detail.unwrap_or_default()
                ),
            ));
        }
    }
    for domain in ["memories", "notes"] {
        let state = store
            .authority_status(&file_uuid, project, domain)?
            .map(|row| row.state);
        if state.as_deref() != Some("MODULE") {
            return Err(MigrateRefusal::new(
                AUTHORITY_NOT_MODULE,
                format!(
                    "{project}'s {domain} authority is {}, not MODULE, so store.db is not its source of truth",
                    state.as_deref().unwrap_or("absent")
                ),
            ));
        }
    }
    let bound = store.single_store_bound_sessions(project)?;
    let harness = {
        let (conn, _) = host.connection_and_fence();
        session_harnesses(conn, project, &bound)?
            .map_err(|detail| MigrateRefusal::new(HOST_LESS, detail))?
    };
    let sessions: BTreeSet<String> = harness.keys().cloned().chain(bound).collect();
    report.sessions = sessions.len();

    let pause_started = Instant::now();
    let _hold = if request.dry_run {
        None
    } else {
        Some(begin_copy(
            store,
            project,
            &sessions,
            Duration::from_secs(30),
        )?)
    };
    let source = store.single_store_source(project, &sessions)?;
    let model = build_model(project, &file_uuid, sessions, &harness, source)?;
    let planned = {
        let (conn, _) = host.connection_and_fence();
        plan(conn, &model)?
    };
    report.tables = planned.counts;
    if request.dry_run {
        report.status = "dry_run".to_string();
        return Ok(report);
    }

    let generation = store
        .single_store_migration(project)?
        .map_or(0, |row| row.copy_generation)
        + 1;
    let started_at = now_ms();
    store.record_single_store_migration(&phase_row(
        store, &model, "copying", started_at, generation,
    ))?;
    let refuse = |refusal: MigrateRefusal| -> MigrateRefusal {
        if !refusal.retryable {
            let mut row = phase_row(store, &model, "refused", started_at, generation);
            row.refusal_code = Some(refusal.code.clone());
            row.refusal_detail = Some(refusal.detail.clone());
            if let Err(error) = store.record_single_store_migration(&row) {
                tracing::warn!("mc-module: could not record the single-store refusal: {error}");
            }
        }
        refusal
    };
    let out_of_time = |started: Instant| -> Result<(), MigrateRefusal> {
        if started.elapsed() > options.max_pause {
            return Err(MigrateRefusal::retryable(
                COPY_IN_PROGRESS,
                format!(
                    "the copy held the project's writes for {:?}; the committed chunks stay and a re-run continues",
                    options.max_pause
                ),
            ));
        }
        Ok(())
    };

    observer.before_first_chunk();
    let mut queue: std::collections::VecDeque<Item> = planned.items.into();
    let mut budgets = [options.staged_budget.max(1), options.session_budget.max(1)];
    let mut committed = 0usize;
    let held = loop {
        let Some(front) = queue.front() else {
            break Vec::new();
        };
        let class = usize::from(!front.is_staged());
        let mut chunk = Vec::new();
        while let Some(next) = queue.front() {
            if usize::from(!next.is_staged()) != class || chunk.len() >= budgets[class] {
                break;
            }
            chunk.push(queue.pop_front().expect("front exists"));
        }
        if queue.is_empty() {
            break chunk;
        }
        out_of_time(pause_started)?;
        let (tallies, hold_us) = copy_transaction(&mut host, &model, COPY_DOMAIN_TABLES, |tx| {
            let tallies = apply_chunk_items(tx, &model, &chunk)?;
            observer.inside_transaction(tx, committed, false);
            Ok(tallies)
        })
        .map_err(&refuse)?;
        count_applied(&mut report.tables, &tallies);
        report.transaction_holds_us.push(hold_us);
        committed += 1;
        observer.between_transactions(&options.context_db, committed);
        if hold_us > PUBLISH_CHUNK_BUDGET_US {
            budgets[class] = (budgets[class] / 2).max(1);
        }
        // Give waiting seats at least as long as this chunk kept them out.
        std::thread::sleep(Duration::from_micros(hold_us.max(0) as u64));
    };

    let drift = {
        let (conn, _) = host.connection_and_fence();
        let drift = drift_snapshot(conn, &model)?;
        verify(conn, &model, &held).map_err(&refuse)?;
        drift
    };
    observer.before_final();
    out_of_time(pause_started)?;
    let mut final_tables: Vec<&str> = COPY_DOMAIN_TABLES.to_vec();
    final_tables.push(MARKER_TABLE);
    let marked_at = now_ms();
    let (tallies, hold_us) = copy_transaction(&mut host, &model, &final_tables, |tx| {
        if drift_snapshot(tx, &model)? != drift {
            return Err(mismatch(format!(
                "{project}'s context.db rows changed between verification and the final commit"
            )));
        }
        let tallies = apply_chunk_items(tx, &model, &held)?;
        for item in &held {
            if item_pending(tx, &model, item)? {
                return Err(mismatch(format!(
                    "{item:?} did not read back equal to its source"
                )));
            }
        }
        tx.execute(
            MARKER_INSERT_SQL,
            params![project, model.file_uuid, marked_at, options.build_version],
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO authority_managed(project_path, context_store_uuid, marked_at)
             VALUES (?1, ?2, ?3)",
            params![project, model.file_uuid, marked_at],
        )?;
        observer.inside_transaction(tx, committed, true);
        Ok(tallies)
    })
    .map_err(&refuse)?;
    count_applied(&mut report.tables, &tallies);
    report.transaction_holds_us.push(hold_us);
    report.marker_committed = true;
    for counts in report.tables.values_mut() {
        counts.verified = counts.source;
    }

    let mut marked = phase_row(store, &model, "marked", started_at, generation);
    marked.marker_committed_at = Some(marked_at);
    if let Err(error) = store.record_single_store_migration(&marked) {
        // The marker is the completion fact; the next boot finishes from it.
        tracing::warn!("mc-module: could not record the single-store phase: {error}");
    }
    observer.after_context_commit();
    store.neutralize_single_store_project(
        &model.file_uuid,
        project,
        &options.build_version,
        now_ms(),
    )?;
    report.neutralized = true;
    report.status = "migrated".to_string();
    report.total_pause_ms = pause_started.elapsed().as_millis() as i64;
    report.finish_holds();
    Ok(report)
}

/// Finish the `store.db` half for every marked project the store still reads as its own,
/// without copying anything. Run once the store has opened, so a crash between the marker
/// commit and the neutralisation is repaired at the next start.
pub fn complete_pending_neutralisations(
    store: &McStore,
    context_db: &Path,
    build: &str,
) -> Result<Vec<String>, MigrateRefusal> {
    let snapshot = host_store::read_marker_snapshot(context_db).map_err(|error| match error {
        host_store::MarkerReadError::Open(error)
        | host_store::MarkerReadError::Untrusted(error) => MigrateRefusal::from(error),
    })?;
    if snapshot.marked.is_empty() {
        return Ok(Vec::new());
    }
    let conn = Connection::open_with_flags(
        context_db,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let Some(file_uuid) = context_store_uuid(&conn)? else {
        return Ok(Vec::new());
    };
    drop(conn);
    let mut completed = Vec::new();
    for project in &snapshot.marked {
        let known = store.single_store_migration(project)?.is_some()
            || store
                .authority_status(&file_uuid, project, "memories")?
                .is_some()
            || store
                .authority_status(&file_uuid, project, "notes")?
                .is_some();
        if known && complete_neutralisation(store, &file_uuid, project, build)? {
            completed.push(project.clone());
        }
    }
    Ok(completed)
}

#[cfg(test)]
#[path = "single_store_migrate_tests.rs"]
pub(crate) mod tests;

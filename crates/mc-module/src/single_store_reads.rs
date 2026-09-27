//! The module's reads of a moved project's rows from `context.db`.
//!
//! Once a project's single-store marker is committed, `context.db` is the only current
//! copy of its memories, notes, compartments and history rows. [`ContextDomainReader`] is
//! installed on the module's `McStore` and answers the store's domain reads for such a
//! project; the store keeps answering unmarked projects from `store.db`, unchanged.
//!
//! Every answer converts the `context.db` row into the shape the `store.db` read returns,
//! so the code above the store cannot tell which file a row came from. The few places the
//! two files disagree on representation are converted here and named where they happen.
//!
//! The marker is read on every call and never cached. The connection is kept open
//! between calls, query-only; its schema fence is re-read whenever the file's schema
//! version moves, so a host migration that alters a table is seen by the next read.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use mc_store::{
    HistorianEventCandidate, HistorianPrimerCandidate, HistorianUserMemoryCandidate, McStoreError,
    SingleStoreDomain, StoredMemory,
};
use rusqlite::{params, Connection, OpenFlags};

use crate::host_store::{
    FenceState, HostStoreError, BUILT_CONTEXT_FENCE_VERSION, CONTEXT_BUSY_TIMEOUT_MS,
    MARKER_LANE_VERSION, MARKER_TABLE, SINGLE_STORE_TRIPWIRE_CODE,
};

struct OpenReader {
    conn: Connection,
    schema_version: i64,
    fence: FenceState,
}

/// Answers `McStore` domain reads for projects whose rows moved into `context.db`.
pub struct ContextDomainReader {
    path: PathBuf,
    reader: Mutex<Option<OpenReader>>,
}

fn domain_error(error: HostStoreError) -> McStoreError {
    McStoreError::SingleStoreDomain {
        code: error.code().to_string(),
        detail: error.to_string(),
    }
}

fn sql_error(error: rusqlite::Error) -> McStoreError {
    domain_error(HostStoreError::from(error))
}

fn schema_version(conn: &Connection) -> Result<i64, rusqlite::Error> {
    conn.query_row("PRAGMA schema_version", [], |row| row.get(0))
}

impl ContextDomainReader {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            reader: Mutex::new(None),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn open(&self) -> Result<Option<OpenReader>, McStoreError> {
        // Without SQLITE_OPEN_CREATE a missing file stays missing. No context.db means no
        // project on this box has moved, so every project is read from store.db.
        if !self.path.exists() {
            return Ok(None);
        }
        let open_failed = |reason: String| {
            domain_error(HostStoreError::OpenFailed {
                path: self.path.display().to_string(),
                reason,
            })
        };
        let conn = Connection::open_with_flags(
            &self.path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|error| open_failed(error.to_string()))?;
        conn.pragma_update(None, "query_only", "ON")
            .map_err(|error| open_failed(error.to_string()))?;
        conn.busy_timeout(std::time::Duration::from_millis(u64::from(
            CONTEXT_BUSY_TIMEOUT_MS,
        )))
        .map_err(|error| open_failed(error.to_string()))?;
        let schema_version = schema_version(&conn).map_err(sql_error)?;
        let fence = match FenceState::read(&conn, &self.path, BUILT_CONTEXT_FENCE_VERSION) {
            Ok(fence) => fence,
            // A file with no schema_migrations rows was never migrated by a host, so it
            // cannot hold the marker table either: nothing on it has moved.
            Err(HostStoreError::FenceMissing { .. }) => return Ok(None),
            Err(error) => return Err(domain_error(error)),
        };
        Ok(Some(OpenReader {
            conn,
            schema_version,
            fence,
        }))
    }

    /// Run `read` on the open connection, opening it first or re-reading its fence when
    /// the file's schema moved. `None` when there is no `context.db`.
    fn with_reader<T>(
        &self,
        read: impl FnOnce(&OpenReader) -> Result<T, McStoreError>,
    ) -> Result<Option<T>, McStoreError> {
        let mut slot = self
            .reader
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let stale = match slot.as_ref() {
            Some(open) => schema_version(&open.conn).ok() != Some(open.schema_version),
            None => true,
        };
        if stale {
            *slot = self.open()?;
        }
        match slot.as_ref() {
            Some(open) => read(open).map(Some),
            None => Ok(None),
        }
    }

    /// Run a domain read against tables whose schema must still be the one this build
    /// reads. A changed table refuses rather than being misread.
    fn read_tables<T>(
        &self,
        tables: &[&str],
        read: impl FnOnce(&Connection) -> Result<T, rusqlite::Error>,
    ) -> Result<T, McStoreError> {
        self.with_reader(|open| {
            for table in tables {
                open.fence.check_table(table).map_err(domain_error)?;
            }
            read(&open.conn).map_err(sql_error)
        })?
        .ok_or_else(|| McStoreError::SingleStoreDomain {
            code: SINGLE_STORE_TRIPWIRE_CODE.to_string(),
            detail: format!(
                "{} disappeared after a project on it was found marked",
                self.path.display()
            ),
        })
    }

    fn marked(open: &OpenReader, project: &str) -> Result<bool, McStoreError> {
        if open.fence.persisted_version < MARKER_LANE_VERSION {
            return Ok(false);
        }
        // An altered or missing marker table cannot tell "unmarked" from "marker lost",
        // and serving store.db for a moved project would serve retained rows as current.
        open.fence
            .check_table(MARKER_TABLE)
            .map_err(|error| McStoreError::SingleStoreDomain {
                code: SINGLE_STORE_TRIPWIRE_CODE.to_string(),
                detail: error.to_string(),
            })?;
        open.conn
            .query_row(
                &format!("SELECT EXISTS(SELECT 1 FROM {MARKER_TABLE} WHERE project_path = ?1)"),
                params![project],
                |row| row.get::<_, bool>(0),
            )
            .map_err(sql_error)
    }
}

impl SingleStoreDomain for ContextDomainReader {
    fn is_marked(&self, project: &str) -> Result<bool, McStoreError> {
        Ok(self
            .with_reader(|open| Self::marked(open, project))?
            .unwrap_or(false))
    }

    fn marked_project_for_session(
        &self,
        session_id: &str,
        store_projects: &[String],
    ) -> Result<Option<String>, McStoreError> {
        Ok(self
            .with_reader(|open| {
                if open.fence.persisted_version < MARKER_LANE_VERSION {
                    return Ok(None);
                }
                let mut candidates: Vec<String> = store_projects.to_vec();
                // session_projects is the host's table; the module only reads its two
                // key columns. A file where it cannot be read refuses the read rather
                // than dropping half of the session's attribution.
                let mut statement = open
                    .conn
                    .prepare_cached(
                        "SELECT project_path FROM session_projects WHERE session_id = ?1",
                    )
                    .map_err(sql_error)?;
                for project in statement
                    .query_map(params![session_id], |row| row.get::<_, String>(0))
                    .map_err(sql_error)?
                {
                    candidates.push(project.map_err(sql_error)?);
                }
                candidates.sort();
                candidates.dedup();
                for project in candidates {
                    if Self::marked(open, &project)? {
                        return Ok(Some(project));
                    }
                }
                Ok(None)
            })?
            .flatten())
    }

    fn load_active_memories(
        &self,
        project: &str,
        now_ms: i64,
    ) -> Result<Vec<StoredMemory>, McStoreError> {
        // context.db ids are the ids agents see, so a moved project's memory id and its
        // host id are the same number.
        self.read_tables(&["memories"], |conn| {
            let mut statement = conn.prepare_cached(
                "SELECT id, project_path, category, content, importance, status, expires_at,
                        superseded_by_memory_id, updated_at, last_seen_at, verified_at
                   FROM memories
                  WHERE project_path = ?1
                    AND status IN ('active', 'permanent')
                    AND (expires_at IS NULL OR expires_at > ?2)
                  ORDER BY COALESCE(importance, 50) DESC, id ASC",
            )?;
            let rows = statement
                .query_map(params![project, now_ms], |row| {
                    let id: i64 = row.get(0)?;
                    Ok(StoredMemory {
                        id,
                        host_row_id: Some(id),
                        project_path: row.get(1)?,
                        category: row.get(2)?,
                        content: row.get(3)?,
                        importance: row.get(4)?,
                        status: row.get(5)?,
                        expires_at: row.get(6)?,
                        superseded_by_memory_id: row.get(7)?,
                        updated_at: row.get(8)?,
                        last_seen_at: row.get(9)?,
                        verified_at: row.get(10)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    fn load_compartment_events(
        &self,
        session_id: &str,
    ) -> Result<Vec<HistorianEventCandidate>, McStoreError> {
        // context.db points an event at its compartment's row id; store.db, which has no
        // compartment row ids, uses the compartment's sequence. The join gives the
        // sequence back. An event whose compartment no longer exists has none.
        self.read_tables(&["compartment_events", "compartments"], |conn| {
            let mut statement = conn.prepare_cached(
                "SELECT e.kind, e.at_compartment, c.sequence, e.fields_json, e.created_at,
                        e.harness
                   FROM compartment_events AS e
                   LEFT JOIN compartments AS c
                     ON c.id = e.compartment_id AND c.session_id = e.session_id
                  WHERE e.session_id = ?1
                  ORDER BY e.id",
            )?;
            let rows = statement
                .query_map(params![session_id], |row| {
                    Ok(HistorianEventCandidate {
                        kind: row.get(0)?,
                        at_compartment: row.get::<_, Option<i64>>(1)?.map(|v| v as u64),
                        compartment_id: row.get::<_, Option<i64>>(2)?.map(|v| v as u64),
                        fields_json: row.get(3)?,
                        created_at: row.get(4)?,
                        harness: row.get(5)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    fn load_primer_candidates(
        &self,
        session_id: &str,
    ) -> Result<Vec<HistorianPrimerCandidate>, McStoreError> {
        self.read_tables(&["primer_candidates"], |conn| {
            let mut statement = conn.prepare_cached(
                "SELECT project_path, session_id, question, source_compartment_start,
                        source_compartment_end, source_start_message_id, source_end_message_id,
                        source_message_time, created_at
                   FROM primer_candidates
                  WHERE session_id = ?1
                  ORDER BY id",
            )?;
            let rows = statement
                .query_map(params![session_id], |row| {
                    Ok(HistorianPrimerCandidate {
                        project_path: row.get(0)?,
                        session_id: row.get(1)?,
                        question: row.get(2)?,
                        source_compartment_start: row.get::<_, Option<i64>>(3)?.map(|v| v as u64),
                        source_compartment_end: row.get::<_, Option<i64>>(4)?.map(|v| v as u64),
                        source_start_message_id: row.get(5)?,
                        source_end_message_id: row.get(6)?,
                        source_message_time: row.get(7)?,
                        created_at: row.get(8)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    fn load_user_memory_candidates(
        &self,
        session_id: &str,
    ) -> Result<Vec<HistorianUserMemoryCandidate>, McStoreError> {
        self.read_tables(&["user_memory_candidates"], |conn| {
            let mut statement = conn.prepare_cached(
                "SELECT content, session_id, source_compartment_start, source_compartment_end,
                        created_at
                   FROM user_memory_candidates
                  WHERE session_id = ?1
                  ORDER BY id",
            )?;
            let rows = statement
                .query_map(params![session_id], |row| {
                    Ok(HistorianUserMemoryCandidate {
                        content: row.get(0)?,
                        session_id: row.get(1)?,
                        source_compartment_start: row.get::<_, Option<i64>>(2)?.map(|v| v as u64),
                        source_compartment_end: row.get::<_, Option<i64>>(3)?.map(|v| v as u64),
                        created_at: row.get(4)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }
}

#[cfg(test)]
#[path = "single_store_reads_tests.rs"]
mod tests;

//! Where a moved project's domain rows are read once it lives in `context.db`.
//!
//! A project that went through the one-time single-store move carries a marker row in
//! `context.db`, and from then on `context.db` is the only current copy of its memories,
//! notes, compartments and history rows; `store.db` keeps a retained copy that must never
//! be served. This store cannot read `context.db` itself (the module owns that file and
//! its schema fence), so the module installs a [`SingleStoreDomain`] and each domain read
//! asks it first. An unmarked project, or a store with no domain installed, reads
//! `store.db` exactly as before.
//!
//! The marker is read fresh on every call and never cached: a project marked by a move
//! that finished a moment ago is served from `context.db` on the very next read.

use crate::{
    HistorianEventCandidate, HistorianPrimerCandidate, HistorianUserMemoryCandidate, McStoreError,
    StoredMemory,
};

/// The reads the module answers from `context.db` for a marked project.
///
/// Every method is called only after [`SingleStoreDomain::is_marked`] or
/// [`SingleStoreDomain::marked_project_for_session`] said the project is marked, and it
/// returns the rows in the same shape and order the `store.db` read would.
pub trait SingleStoreDomain: Send + Sync {
    /// Whether `project` carries a marker row, read now.
    fn is_marked(&self, project: &str) -> Result<bool, McStoreError>;

    /// The marked project `session_id` belongs to, if any. A session belongs to a project
    /// when `context.db` records it in `session_projects` for that project, or when
    /// `store.db` binds it to one of `store_projects` (the projects its transform roots
    /// are bound to). Sessions carry no project column of their own, so this is the same
    /// session set the move copied.
    fn marked_project_for_session(
        &self,
        session_id: &str,
        store_projects: &[String],
    ) -> Result<Option<String>, McStoreError>;

    /// A marked project's render-eligible memories, in the order of
    /// [`crate::McStore::load_active_memories`].
    fn load_active_memories(
        &self,
        project: &str,
        now_ms: i64,
    ) -> Result<Vec<StoredMemory>, McStoreError>;

    /// A marked session's historian events, oldest first. `compartment_id` is given as
    /// the compartment's sequence, the surrogate `store.db` uses.
    fn load_compartment_events(
        &self,
        session_id: &str,
    ) -> Result<Vec<HistorianEventCandidate>, McStoreError>;

    /// A marked session's primer candidates, oldest first.
    fn load_primer_candidates(
        &self,
        session_id: &str,
    ) -> Result<Vec<HistorianPrimerCandidate>, McStoreError>;

    /// A marked session's user-memory candidates, oldest first.
    fn load_user_memory_candidates(
        &self,
        session_id: &str,
    ) -> Result<Vec<HistorianUserMemoryCandidate>, McStoreError>;
}

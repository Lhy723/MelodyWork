use rusqlite::Transaction;

// Delete explicitly rather than relying on cascades from databases created
// before foreign-key enforcement. Callers keep the session/project transaction
// and the separate app-owned Pi artifact lifecycle.

/// Remove session-owned agent rows inside the transaction controlled by the caller.
pub(crate) fn purge_session_agent_rows(
    transaction: &Transaction<'_>,
    session_id: &str,
) -> Result<(), String> {
    for statement in [
        "DELETE FROM session_timeline_entries WHERE session_id = ?1",
        "DELETE FROM pi_session_forks
          WHERE branch_session_id = ?1 OR source_session_id = ?1",
        "DELETE FROM agent_session_bindings WHERE session_id = ?1",
        "DELETE FROM agent_event_log WHERE session_id = ?1",
        "DELETE FROM migration_journal WHERE session_id = ?1",
        "DELETE FROM agent_schedule_runs
          WHERE schedule_id IN (
              SELECT schedule_id FROM agent_schedules WHERE session_id = ?1
          )",
        "DELETE FROM agent_schedules WHERE session_id = ?1",
    ] {
        transaction
            .execute(statement, [session_id])
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Remove agent rows for every session in a project inside the caller's transaction.
pub(crate) fn purge_project_agent_rows(
    transaction: &Transaction<'_>,
    project_id: &str,
) -> Result<(), String> {
    for statement in [
        "DELETE FROM session_timeline_entries
         WHERE session_id IN (
             SELECT id FROM sessions WHERE project_id = ?1
         )",
        "DELETE FROM agent_session_bindings
         WHERE session_id IN (
             SELECT id FROM sessions WHERE project_id = ?1
         )",
        "DELETE FROM agent_event_log
         WHERE session_id IN (
             SELECT id FROM sessions WHERE project_id = ?1
         )",
        "DELETE FROM migration_journal
         WHERE session_id IN (
             SELECT id FROM sessions WHERE project_id = ?1
         )",
        "DELETE FROM pi_session_forks
         WHERE source_session_id IN (
             SELECT id FROM sessions WHERE project_id = ?1
         ) OR branch_session_id IN (
             SELECT id FROM sessions WHERE project_id = ?1
         )",
        "DELETE FROM agent_schedule_runs
         WHERE schedule_id IN (
             SELECT schedule_id FROM agent_schedules
              WHERE session_id IN (
                  SELECT id FROM sessions WHERE project_id = ?1
              )
         )",
        "DELETE FROM agent_schedules
         WHERE session_id IN (
             SELECT id FROM sessions WHERE project_id = ?1
         )",
    ] {
        transaction
            .execute(statement, [project_id])
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

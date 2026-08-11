/**
 * Derives the Remote Control name for an orchestrator session from the ticket
 * ids it covers, e.g. ["FE-12", "BE-16", "FE-3"] -> "orchestrator-FE-12_BE-16_FE-3".
 *
 * The ids are joined with "_" (not spaces) so the result is a single
 * shell-safe token — it travels through the dashboard markers and the shell
 * wrapper as one `--rc-name` argument without quoting.
 *
 * Returns null when there are no ids, letting the caller fall back to a
 * session-hash name (the `mintree orchestrate --prompt "..."` path, which has
 * no tickets to name the session after).
 */
export function buildOrchestratorRcName(ids) {
    if (ids.length === 0)
        return null;
    return `orchestrator-${ids.join("_")}`;
}

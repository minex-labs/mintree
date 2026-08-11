export type SessionState = "waiting" | "idle" | "active" | "exited";
/**
 * Synchronously slurps stdin to a string. Used by hook handlers to read the
 * JSON payload Claude pipes in. Returns "" on any failure so the caller can
 * exit silently — a hook crash would interrupt Claude.
 */
export declare function readStdin(): string;
/**
 * Extracts the main repo root and worktree directory name from an absolute
 * cwd that lives under `<repo>/.mintree/worktrees/<dir>/...`. Returns null
 * when the cwd is outside that pattern (Claude was launched somewhere else
 * or the worktree was already removed).
 */
export declare function extractRepoAndDir(cwd: string): {
    repoRoot: string;
    worktreeDir: string;
} | null;
/**
 * Pulls the issue id out of a worktree directory name. The dir name is the
 * bare issue id (`100`, `FE-123`); the trailing `-` clause still matches
 * legacy `<issue>-<desc>` worktrees on disk. Returns null when the directory
 * name doesn't follow the convention (e.g. a manually-created worktree
 * dropped under .mintree/worktrees/). The id is either bare digits (GitHub)
 * or a `<TEAM>-\d+` Linear identifier.
 */
export declare function issueIdFromWorktreeDir(worktreeDir: string): string | null;
export type StatePayload = {
    state: SessionState;
    session_id: string;
    issue_id: string;
    worktree_dir: string;
    message: string | null;
    at: string;
};
/**
 * Writes the state file for an issue under `<repo>/.mintree/session-states/`.
 * Creates the directory if missing. Atomic-ish: same write pattern as
 * metadata.json — fine for state probing from the dashboard, fast to refresh.
 */
export declare function writeStateFile(repoRoot: string, issueId: string, payload: StatePayload): string;
/**
 * The only entry point the hook sub-commands call. Reads the JSON payload
 * Claude piped in, locates the worktree+issue from the payload's `cwd`, and
 * writes the state file. Exits 0 unconditionally — the worst case is a
 * silent no-op, never an error that would interrupt Claude.
 */
export declare function signalState(state: SessionState): void;
/**
 * The hook tree mintree wants to see in `~/.claude/settings.json`. Each
 * inner command runs async with a 10s timeout — slow hooks would otherwise
 * block Claude's UI thread. The Notification entry is gated on the
 * `permission_prompt` matcher so the dashboard's "waiting" state only
 * lights up when Claude is actually waiting for a permission decision,
 * not for every notification.
 */
export declare function getHooksJson(): Record<string, unknown>;
/**
 * Installs (or replaces) the four mintree hooks in `~/.claude/settings.json`.
 * Existing non-mintree hooks for the same events are preserved; previous
 * mintree entries are filtered out and re-added so re-running this is safe.
 * Returns the path of the file we wrote.
 */
export declare function installHooks(): {
    settingsPath: string;
    created: boolean;
};

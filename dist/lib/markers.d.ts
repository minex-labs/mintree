/**
 * Emits the shell-wrapper markers. When `MINTREE_MARKER_FILE` is set in env
 * (the dashboard wrapper does this so it can run the TUI without capturing
 * stdout), the markers are appended there. Otherwise they go to stdout —
 * the `worktree create` wrapper greps stdout for them after capturing it.
 *
 * Each marker is written on its own line, terminated with a newline.
 */
export declare function emitMarkers(markers: string[]): void;
export type CreateMarkers = {
    worktreePath: string;
    work: boolean;
    promptFile?: string;
    permissionMode?: string;
};
/**
 * Builds the marker block emitted after a successful `worktree create`.
 * Same layout the shell wrapper expects: MINTREE_CD always present, the
 * three work-related markers only when --work was on.
 */
export declare function buildCreateMarkers(input: CreateMarkers): string[];
export type OrchestrateMarkers = {
    repoRoot: string;
    promptFile: string;
    permissionMode?: string;
    rcName?: string;
};
/**
 * Builds the marker block emitted when the dashboard launches the orchestrator
 * from the Orchestrate tab. The shell wrapper cd's to `repoRoot` and then runs
 * `mintree orchestrate --prompt-file <file> [--permission-mode <mode>]`.
 */
export declare function buildOrchestrateMarkers(input: OrchestrateMarkers): string[];

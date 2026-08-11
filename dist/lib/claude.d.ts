import { type ChildProcess } from "child_process";
export declare const PERMISSION_MODES: readonly ["default", "auto"];
export type PermissionMode = (typeof PERMISSION_MODES)[number];
/**
 * Resolves the absolute path of the Claude Code CLI binary, or null if not on
 * PATH. Falls back to ~/.claude/local/claude (the Anthropic installer
 * location) when PATH lookup fails — this is the single most common reason a
 * Node child sees "claude not found" while the user sees it on the shell.
 */
export declare function resolveClaudeBinary(): string | null;
export type LaunchClaudeOptions = {
    permissionMode: PermissionMode;
    sessionId: string;
    resume: boolean;
    prompt?: string;
    cwd: string;
    remoteControlName?: string;
};
/**
 * Spawns the Claude CLI with stdio inherited so the child takes over the TTY.
 * The session is started fresh with `--session-id` or resumed with `--resume`
 * depending on `resume`. Returns the ChildProcess so the caller can wire
 * exit/error handlers.
 *
 * Throws if the claude binary is not resolvable.
 */
export declare function launchClaude(options: LaunchClaudeOptions): ChildProcess;

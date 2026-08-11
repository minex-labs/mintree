import * as fs from "fs";
/**
 * Emits the shell-wrapper markers. When `MINTREE_MARKER_FILE` is set in env
 * (the dashboard wrapper does this so it can run the TUI without capturing
 * stdout), the markers are appended there. Otherwise they go to stdout —
 * the `worktree create` wrapper greps stdout for them after capturing it.
 *
 * Each marker is written on its own line, terminated with a newline.
 */
export function emitMarkers(markers) {
    if (markers.length === 0)
        return;
    const text = markers.join("\n") + "\n";
    const file = process.env["MINTREE_MARKER_FILE"];
    if (file) {
        try {
            fs.appendFileSync(file, text);
            return;
        }
        catch {
            // If the file is unwritable for any reason, fall through to stdout
            // rather than silently swallow the markers.
        }
    }
    process.stdout.write(text);
}
/**
 * Builds the marker block emitted after a successful `worktree create`.
 * Same layout the shell wrapper expects: MINTREE_CD always present, the
 * three work-related markers only when --work was on.
 */
export function buildCreateMarkers(input) {
    const lines = [`MINTREE_CD:${input.worktreePath}`];
    if (input.work)
        lines.push("MINTREE_WORK:1");
    if (input.work && input.promptFile) {
        lines.push(`MINTREE_WORK_PROMPT_FILE:${input.promptFile}`);
    }
    if (input.work && input.permissionMode) {
        lines.push(`MINTREE_PERMISSION_MODE:${input.permissionMode}`);
    }
    return lines;
}
/**
 * Builds the marker block emitted when the dashboard launches the orchestrator
 * from the Orchestrate tab. The shell wrapper cd's to `repoRoot` and then runs
 * `mintree orchestrate --prompt-file <file> [--permission-mode <mode>]`.
 */
export function buildOrchestrateMarkers(input) {
    const lines = [
        `MINTREE_CD:${input.repoRoot}`,
        "MINTREE_ORCHESTRATE:1",
        `MINTREE_ORCHESTRATE_PROMPT_FILE:${input.promptFile}`,
    ];
    if (input.permissionMode) {
        lines.push(`MINTREE_PERMISSION_MODE:${input.permissionMode}`);
    }
    if (input.rcName) {
        lines.push(`MINTREE_ORCHESTRATE_RC_NAME:${input.rcName}`);
    }
    return lines;
}

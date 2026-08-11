import * as fs from "fs";

/**
 * Emits the shell-wrapper markers. When `MINTREE_MARKER_FILE` is set in env
 * (the dashboard wrapper does this so it can run the TUI without capturing
 * stdout), the markers are appended there. Otherwise they go to stdout —
 * the `worktree create` wrapper greps stdout for them after capturing it.
 *
 * Each marker is written on its own line, terminated with a newline.
 */
export function emitMarkers(markers: string[]): void {
	if (markers.length === 0) return;
	const text = markers.join("\n") + "\n";
	const file = process.env["MINTREE_MARKER_FILE"];
	if (file) {
		try {
			fs.appendFileSync(file, text);
			return;
		} catch {
			// If the file is unwritable for any reason, fall through to stdout
			// rather than silently swallow the markers.
		}
	}
	process.stdout.write(text);
}

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
export function buildCreateMarkers(input: CreateMarkers): string[] {
	const lines: string[] = [`MINTREE_CD:${input.worktreePath}`];
	if (input.work) lines.push("MINTREE_WORK:1");
	if (input.work && input.promptFile) {
		lines.push(`MINTREE_WORK_PROMPT_FILE:${input.promptFile}`);
	}
	if (input.work && input.permissionMode) {
		lines.push(`MINTREE_PERMISSION_MODE:${input.permissionMode}`);
	}
	return lines;
}

export type OrchestrateMarkers = {
	// Main repo root — the orchestrator runs here (not in a worktree), so the
	// shell wrapper cd's the parent shell to it before launching Claude.
	repoRoot: string;
	// Temp file holding the orchestrator prompt. Markers can't carry multi-line
	// text safely, so the prompt is handed over via a file (read + deleted by
	// `mintree orchestrate`).
	promptFile: string;
	permissionMode?: string;
	// Remote Control name derived from the selected ticket ids
	// (orchestrator-FE-12_BE-16_FE-3). A single shell-safe token, forwarded as
	// `--rc-name` because the dashboard launch carries no positional ids.
	rcName?: string;
};

/**
 * Builds the marker block emitted when the dashboard launches the orchestrator
 * from the Orchestrate tab. The shell wrapper cd's to `repoRoot` and then runs
 * `mintree orchestrate --prompt-file <file> [--permission-mode <mode>]`.
 */
export function buildOrchestrateMarkers(input: OrchestrateMarkers): string[] {
	const lines: string[] = [
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

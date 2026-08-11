import * as fs from "fs";
import * as path from "path";

export type SessionState = "waiting" | "idle" | "active" | "exited";

/**
 * Synchronously slurps stdin to a string. Used by hook handlers to read the
 * JSON payload Claude pipes in. Returns "" on any failure so the caller can
 * exit silently — a hook crash would interrupt Claude.
 */
export function readStdin(): string {
	try {
		return fs.readFileSync(0, "utf-8");
	} catch {
		return "";
	}
}

/**
 * Extracts the main repo root and worktree directory name from an absolute
 * cwd that lives under `<repo>/.mintree/worktrees/<dir>/...`. Returns null
 * when the cwd is outside that pattern (Claude was launched somewhere else
 * or the worktree was already removed).
 */
export function extractRepoAndDir(cwd: string): { repoRoot: string; worktreeDir: string } | null {
	const marker = "/.mintree/worktrees/";
	const idx = cwd.indexOf(marker);
	if (idx === -1) return null;

	const repoRoot = cwd.slice(0, idx);
	const rest = cwd.slice(idx + marker.length);
	const worktreeDir = rest.split("/")[0];
	if (!worktreeDir) return null;

	return { repoRoot, worktreeDir };
}

/**
 * Pulls the issue id out of a worktree directory name. The dir name is the
 * bare issue id (`100`, `FE-123`); the trailing `-` clause still matches
 * legacy `<issue>-<desc>` worktrees on disk. Returns null when the directory
 * name doesn't follow the convention (e.g. a manually-created worktree
 * dropped under .mintree/worktrees/). The id is either bare digits (GitHub)
 * or a `<TEAM>-\d+` Linear identifier.
 */
export function issueIdFromWorktreeDir(worktreeDir: string): string | null {
	const m = worktreeDir.match(/^((?:[A-Z][A-Z0-9_]*-)?\d+)(?:-|$)/);
	return m && m[1] ? m[1] : null;
}

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
export function writeStateFile(repoRoot: string, issueId: string, payload: StatePayload): string {
	const statesDir = path.join(repoRoot, ".mintree", "session-states");
	fs.mkdirSync(statesDir, { recursive: true });
	const file = path.join(statesDir, `${issueId}.json`);
	fs.writeFileSync(file, JSON.stringify(payload, null, 2) + "\n");
	return file;
}

/**
 * The only entry point the hook sub-commands call. Reads the JSON payload
 * Claude piped in, locates the worktree+issue from the payload's `cwd`, and
 * writes the state file. Exits 0 unconditionally — the worst case is a
 * silent no-op, never an error that would interrupt Claude.
 */
export function signalState(state: SessionState): void {
	const input = readStdin();
	let data: { cwd?: string; session_id?: string; message?: string } = {};
	if (input) {
		try {
			data = JSON.parse(input);
		} catch {
			process.exit(0);
		}
	}

	const cwd = data.cwd || process.cwd();
	const info = extractRepoAndDir(cwd);
	if (!info) process.exit(0);

	const { repoRoot, worktreeDir } = info;
	const issueId = issueIdFromWorktreeDir(worktreeDir);
	if (!issueId) process.exit(0);

	writeStateFile(repoRoot, issueId, {
		state,
		session_id: data.session_id ?? "",
		issue_id: issueId,
		worktree_dir: worktreeDir,
		message: state === "waiting" ? (data.message ?? null) : null,
		at: new Date().toISOString(),
	});

	process.exit(0);
}

/**
 * The hook tree mintree wants to see in `~/.claude/settings.json`. Each
 * inner command runs async with a 10s timeout — slow hooks would otherwise
 * block Claude's UI thread. The Notification entry is gated on the
 * `permission_prompt` matcher so the dashboard's "waiting" state only
 * lights up when Claude is actually waiting for a permission decision,
 * not for every notification.
 */
export function getHooksJson(): Record<string, unknown> {
	const base = "mintree helpers session-signal";
	const opts = { async: true, timeout: 10 };
	return {
		Notification: [
			{
				matcher: "permission_prompt",
				hooks: [{ type: "command", command: `${base} notification`, ...opts }],
			},
		],
		Stop: [{ hooks: [{ type: "command", command: `${base} stop`, ...opts }] }],
		UserPromptSubmit: [{ hooks: [{ type: "command", command: `${base} prompt`, ...opts }] }],
		SessionEnd: [{ hooks: [{ type: "command", command: `${base} end`, ...opts }] }],
	};
}

/**
 * Installs (or replaces) the four mintree hooks in `~/.claude/settings.json`.
 * Existing non-mintree hooks for the same events are preserved; previous
 * mintree entries are filtered out and re-added so re-running this is safe.
 * Returns the path of the file we wrote.
 */
export function installHooks(): { settingsPath: string; created: boolean } {
	const home = process.env["HOME"] || "";
	const claudeDir = path.join(home, ".claude");
	const settingsPath = path.join(claudeDir, "settings.json");

	const created = !fs.existsSync(settingsPath);
	let settings: Record<string, unknown> = {};
	try {
		if (!created) settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
	} catch {
		// Corrupt settings — start fresh rather than refusing to install.
		settings = {};
	}

	const required = getHooksJson();
	const existingHooks =
		typeof settings["hooks"] === "object" && settings["hooks"] !== null
			? (settings["hooks"] as Record<string, unknown>)
			: {};

	for (const [event, hookEntries] of Object.entries(required)) {
		const existing = existingHooks[event];
		if (!Array.isArray(existing)) {
			existingHooks[event] = hookEntries;
			continue;
		}
		const filtered = existing.filter((entry) => {
			if (!entry || typeof entry !== "object") return true;
			const inner = (entry as { hooks?: unknown[] }).hooks ?? [];
			return !inner.some((h) => {
				return (
					h !== null &&
					typeof h === "object" &&
					typeof (h as { command?: unknown }).command === "string" &&
					(h as { command: string }).command.includes("mintree helpers session-signal")
				);
			});
		});
		existingHooks[event] = [...filtered, ...(hookEntries as unknown[])];
	}

	settings["hooks"] = existingHooks;

	fs.mkdirSync(claudeDir, { recursive: true });
	fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");

	return { settingsPath, created };
}

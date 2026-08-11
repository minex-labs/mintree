import { execSync, spawn, type ChildProcess } from "child_process";
import { existsSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { setITermBadge, clearITermBadge } from "./terminal.js";

export const PERMISSION_MODES = ["default", "auto"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/**
 * Resolves the absolute path of the Claude Code CLI binary, or null if not on
 * PATH. Falls back to ~/.claude/local/claude (the Anthropic installer
 * location) when PATH lookup fails — this is the single most common reason a
 * Node child sees "claude not found" while the user sees it on the shell.
 */
export function resolveClaudeBinary(): string | null {
	try {
		const out = execSync("which claude", { stdio: ["ignore", "pipe", "ignore"] })
			.toString()
			.trim();
		if (out) return out;
	} catch {
		// fall through
	}
	const local = join(homedir(), ".claude", "local", "claude");
	if (existsSync(local)) return local;
	return null;
}

// macOS ARG_MAX is 256KB; leave room for env vars.
const ARG_MAX_SAFE = 200 * 1024;

/**
 * If `prompt` fits in argv, returns it as-is. Otherwise writes it to a temp
 * file and returns a short instruction the agent can follow to read it. This
 * keeps the launch flow safe against very long prompts without forcing
 * callers to handle the spill case.
 */
function promptArg(prompt: string): string {
	if (Buffer.byteLength(prompt) <= ARG_MAX_SAFE) return prompt;
	const filePath = join(tmpdir(), `mintree-prompt-${Date.now()}.md`);
	writeFileSync(filePath, prompt);
	return `Read ${filePath} and follow the instructions inside.`;
}

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
export function launchClaude(options: LaunchClaudeOptions): ChildProcess {
	const bin = resolveClaudeBinary();
	if (!bin) {
		throw new Error(
			"Claude CLI not found. Install it with: npm install -g @anthropic-ai/claude-code",
		);
	}

	const args: string[] = ["--permission-mode", options.permissionMode];
	if (options.resume) {
		args.push("--resume", options.sessionId);
	} else {
		args.push("--session-id", options.sessionId);
	}
	// Always launch with Remote Control. Mintree's whole premise is being able
	// to resume sessions from other devices, so the flag is non-optional —
	// global `remoteControlAtStartup` becomes irrelevant for mintree-launched
	// sessions. The optional name = worktree dir, so the RC UI can identify
	// the session at a glance instead of showing a UUID.
	if (options.remoteControlName) {
		args.push("--remote-control", options.remoteControlName);
	} else {
		args.push("--remote-control");
	}
	if (options.prompt && options.prompt.length > 0) {
		args.push("--", promptArg(options.prompt));
	}

	// Label the session with an iTerm2 badge before handing over the TTY. The
	// badge survives Claude overwriting the terminal title, so the tab stays
	// identifiable (worktree issue id, or orchestrator name) while it runs.
	// No-op outside iTerm2.
	const badge = options.remoteControlName;
	if (badge) setITermBadge(badge);

	const child = spawn(bin, args, { stdio: "inherit", cwd: options.cwd });

	// Clear the badge once Claude exits so the badge doesn't linger on the
	// shell that regains the TTY.
	if (badge) child.on("exit", () => clearITermBadge());

	return child;
}

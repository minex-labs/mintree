import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { option } from "pastel";
import { z } from "zod";
import { randomUUID } from "crypto";
import { readFileSync, unlinkSync } from "fs";
import * as path from "path";

import {
	findMainRepoRoot,
	getMintreeDir,
	getWorktreesDir,
	getCurrentBranch,
	pathExists,
} from "../../lib/git.js";
import { getSessionId, setSessionId, readMetadata } from "../../lib/metadata.js";
import { launchClaude, PERMISSION_MODES, type PermissionMode } from "../../lib/claude.js";

export const description = "Launch Claude in the current worktree (creates or resumes a session)";

export const options = z.object({
	prompt: z
		.string()
		.optional()
		.describe(
			option({
				description: "Initial prompt injected as the first user message (literal, no templating)",
			}),
		),
	promptFile: z
		.string()
		.optional()
		.describe(
			option({
				description:
					"Read prompt from this file (deleted after read). Used by `worktree create --work` to bridge text from the create marker. Mutually exclusive with --prompt.",
			}),
		),
	permissionMode: z
		.enum(PERMISSION_MODES)
		.optional()
		.describe(
			option({
				description: `Claude --permission-mode (one of: ${PERMISSION_MODES.join(", ")}). Defaults to metadata.defaultPermissionMode, else "default".`,
				alias: "m",
			}),
		),
});

type Props = {
	options: z.infer<typeof options>;
};

type Resolved = {
	repoRoot: string;
	worktreePath: string;
	worktreeDirName: string;
	branch: string | null;
	issueId: string;
	sessionId: string;
	resume: boolean;
	permissionMode: PermissionMode;
};

type State =
	| { phase: "loading" }
	| { phase: "error"; message: string; hint?: string }
	| { phase: "launching"; resolved: Resolved };

function resolve(
	cwd: string,
	flagPermissionMode: PermissionMode | undefined,
): { ok: true; data: Resolved } | { ok: false; message: string; hint?: string } {
	const repoRoot = findMainRepoRoot(cwd);
	if (!repoRoot) {
		return {
			ok: false,
			message: "Not in a git repository.",
			hint: "Run `mintree worktree work` from inside a mintree worktree.",
		};
	}

	if (!pathExists(getMintreeDir(repoRoot))) {
		return {
			ok: false,
			message: ".mintree/ not found in this repo.",
			hint: "Run `mintree init` first.",
		};
	}

	const worktreesDir = path.resolve(getWorktreesDir(repoRoot));
	const cwdAbs = path.resolve(cwd);
	const insideMintreeWorktree =
		cwdAbs === worktreesDir ? false : cwdAbs.startsWith(worktreesDir + path.sep);
	if (!insideMintreeWorktree) {
		return {
			ok: false,
			message: "This directory isn't a mintree worktree.",
			hint: "Run `mintree worktree work` from inside `.mintree/worktrees/<issue>-<desc>`.",
		};
	}

	// The worktree path that git knows about is the *root* of this checkout.
	// Walk up from cwd until we land directly under .mintree/worktrees/<name>.
	const segmentBeneathWorktreesDir = cwdAbs.slice(worktreesDir.length + 1).split(path.sep)[0];
	const worktreePath = segmentBeneathWorktreesDir
		? path.join(worktreesDir, segmentBeneathWorktreesDir)
		: cwdAbs;
	const worktreeDirName = path.basename(worktreePath);

	// IssueId comes from the worktree dir name, not the branch — that way
	// detached-HEAD worktrees (the "current branch" path from the dashboard)
	// still resolve their session_id. The dir is named after the bare issue
	// id for both attached and detached creates; the trailing `-` clause still
	// matches legacy `<issueId>-<desc>` worktrees. issueId is either bare
	// digits (GitHub) or `<TEAM>-\d+` (Linear).
	const issueIdMatch = worktreeDirName.match(/^((?:[A-Z][A-Z0-9_]*-)?\d+)(?:-|$)/);
	if (!issueIdMatch || !issueIdMatch[1]) {
		return {
			ok: false,
			message: `Worktree directory '${worktreeDirName}' doesn't start with an issue id.`,
			hint: "Expected the issue id (e.g. 100 or AUTH-6).",
		};
	}
	const issueId = issueIdMatch[1];

	const branch = getCurrentBranch(cwdAbs); // null = detached HEAD, that's fine

	const existing = getSessionId(repoRoot, issueId);
	let sessionId: string;
	let resume: boolean;
	if (existing) {
		sessionId = existing;
		resume = true;
	} else {
		sessionId = randomUUID();
		setSessionId(repoRoot, issueId, sessionId);
		resume = false;
	}

	// Effective permission mode: explicit `--permission-mode` flag wins, else
	// the repo's `metadata.defaultPermissionMode`, else the stricter "default".
	const permissionMode =
		flagPermissionMode ?? readMetadata(repoRoot).defaultPermissionMode ?? "default";

	return {
		ok: true,
		data: {
			repoRoot,
			worktreePath,
			worktreeDirName,
			branch,
			issueId,
			sessionId,
			resume,
			permissionMode,
		},
	};
}

export default function Work({ options }: Props) {
	const [state, setState] = useState<State>({ phase: "loading" });

	useEffect(() => {
		// Defer one tick so the spinner gets to render before sync work starts.
		setTimeout(() => {
			if (options.prompt && options.promptFile) {
				setState({
					phase: "error",
					message: "--prompt and --prompt-file are mutually exclusive.",
				});
				return;
			}
			const result = resolve(process.cwd(), options.permissionMode);
			if (!result.ok) {
				setState({ phase: "error", message: result.message, hint: result.hint });
				return;
			}
			setState({ phase: "launching", resolved: result.data });
		}, 0);
	}, []);

	useEffect(() => {
		if (state.phase !== "launching") return;
		const { resolved } = state;

		// --prompt-file handling: read once, delete the file. The file is the
		// transport between `worktree create --work --prompt` and us — both
		// sides own its cleanup so even a crash mid-handoff doesn't leave junk
		// in /tmp forever (OS sweeps tmpdir eventually anyway).
		let effectivePrompt = options.prompt;
		if (options.promptFile) {
			try {
				effectivePrompt = readFileSync(options.promptFile, "utf-8");
			} catch {
				// Missing/unreadable — fall through with no prompt.
			}
			try {
				unlinkSync(options.promptFile);
			} catch {
				// Cleanup failure is non-fatal.
			}
		}

		try {
			const child = launchClaude({
				permissionMode: resolved.permissionMode,
				sessionId: resolved.sessionId,
				resume: resolved.resume,
				prompt: effectivePrompt,
				cwd: resolved.worktreePath,
				remoteControlName: resolved.worktreeDirName,
			});
			child.on("error", (err: Error) => {
				setState({
					phase: "error",
					message: `Failed to launch claude: ${err.message}`,
				});
			});
			child.on("close", (code: number | null) => {
				process.exit(code ?? 0);
			});
		} catch (err) {
			setState({
				phase: "error",
				message: err instanceof Error ? err.message : String(err),
			});
		}
	}, [state.phase, options.permissionMode, options.prompt]);

	if (state.phase === "loading") {
		return (
			<Box>
				<Text color="cyan">
					<Spinner type="dots" />
				</Text>
				<Text> Resolving worktree...</Text>
			</Box>
		);
	}

	if (state.phase === "error") {
		return (
			<Box flexDirection="column" padding={1}>
				<Text color="red" bold>
					✗ {state.message}
				</Text>
				{state.hint && (
					<Box marginTop={1}>
						<Text color="yellow">↳ {state.hint}</Text>
					</Box>
				)}
			</Box>
		);
	}

	const { resolved } = state;
	const sessionShort = resolved.sessionId.slice(0, 8);
	const action = resolved.resume ? "resuming" : "starting";

	return (
		<Box flexDirection="column" padding={1}>
			<Box marginBottom={1}>
				<Text bold color="cyan">
					mintree worktree work
				</Text>
				<Text dimColor> · {resolved.branch ?? `detached @ ${resolved.worktreeDirName}`}</Text>
			</Box>
			<Box flexDirection="column">
				<Text>
					<Text dimColor>session: </Text>
					<Text>{sessionShort}…</Text>
					<Text dimColor> ({action})</Text>
				</Text>
				<Text>
					<Text dimColor>permission-mode: </Text>
					<Text>{resolved.permissionMode}</Text>
				</Text>
				{options.prompt && (
					<Text>
						<Text dimColor>initial prompt: </Text>
						<Text>"{truncate(options.prompt, 60)}"</Text>
					</Text>
				)}
				<Text>
					<Text dimColor>cwd: </Text>
					<Text dimColor>{resolved.worktreePath}</Text>
				</Text>
			</Box>
			<Box marginTop={1}>
				<Text color="green" bold>
					✓ Launching Claude...
				</Text>
			</Box>
		</Box>
	);
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return s.slice(0, max - 1) + "…";
}

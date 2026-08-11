import React, { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import { option } from "pastel";
import { z } from "zod";
import * as path from "path";

import {
	findMainRepoRoot,
	getMintreeDir,
	getWorktreesDir,
	listWorktrees,
	isDirty,
	removeWorktree,
	pathExists,
	type WorktreeEntry,
} from "../../lib/git.js";
import { fetchPrForBranch, type PrInfo } from "../../lib/pr.js";
import { issueIdFromWorktreeDirName } from "../../lib/branch.js";
import { removeIssue } from "../../lib/metadata.js";

export const description = "Remove worktrees whose PR is merged or closed";

export const options = z.object({
	yes: z
		.boolean()
		.default(false)
		.describe(
			option({
				description: "Skip the confirmation prompt (required for non-interactive shells)",
			}),
		),
	force: z
		.boolean()
		.default(false)
		.describe(
			option({
				description:
					"Include worktrees with uncommitted changes (clean is conservative by default)",
			}),
		),
});

type Props = {
	options: z.infer<typeof options>;
};

type Candidate = {
	worktreePath: string;
	branch: string;
	dirty: boolean;
	pr: PrInfo;
	willClean: boolean;
	reasonSkipped?: string;
};

type State =
	| { phase: "loading"; message: string }
	| { phase: "error"; message: string; hint?: string }
	| { phase: "nothing"; message: string }
	| {
			phase: "prompt";
			repoRoot: string;
			candidates: Candidate[];
	  }
	| {
			phase: "executing";
			repoRoot: string;
			candidates: Candidate[];
	  }
	| {
			phase: "done";
			results: { branch: string; ok: boolean; error?: string }[];
			cancelled: boolean;
	  };

async function loadCandidates(force: boolean): Promise<State> {
	const root = findMainRepoRoot();
	if (!root) {
		return {
			phase: "error",
			message: "Not in a git repository.",
			hint: "Run `git init` and then `mintree init`.",
		};
	}
	if (!pathExists(getMintreeDir(root))) {
		return {
			phase: "error",
			message: ".mintree/ not found in this repo.",
			hint: "Run `mintree init` first.",
		};
	}

	const worktreesDir = getWorktreesDir(root);
	const all = listWorktrees(root);
	const ours = all.filter((w: WorktreeEntry) => {
		if (!w.branch) return false;
		const wAbs = path.resolve(w.path);
		const dirAbs = path.resolve(worktreesDir);
		return wAbs === dirAbs || wAbs.startsWith(dirAbs + path.sep);
	});

	if (ours.length === 0) {
		return { phase: "nothing", message: "No mintree worktrees in this repo. Nothing to clean." };
	}

	const prs = await Promise.all(
		ours.map((w) => fetchPrForBranch(w.branch as string, { withUrl: false })),
	);

	const candidates: Candidate[] = [];
	for (let i = 0; i < ours.length; i++) {
		const w = ours[i];
		const pr = prs[i];
		if (!w || !w.branch) continue;
		if (!pr || pr.state === "OPEN") continue; // only candidates with closed/merged PRs
		const dirty = pathExists(w.path) ? isDirty(w.path) : false;
		const skipForDirty = dirty && !force;
		candidates.push({
			worktreePath: w.path,
			branch: w.branch,
			dirty,
			pr,
			willClean: !skipForDirty,
			reasonSkipped: skipForDirty ? "dirty (pass --force to include)" : undefined,
		});
	}

	if (candidates.length === 0) {
		return {
			phase: "nothing",
			message: "All mintree worktrees still have an open PR (or no PR at all). Nothing to clean.",
		};
	}

	return { phase: "prompt", repoRoot: root, candidates };
}

function executeRemovals(repoRoot: string, candidates: Candidate[]) {
	const toRemove = candidates.filter((c) => c.willClean);
	const results: { branch: string; ok: boolean; error?: string }[] = [];
	for (const c of toRemove) {
		try {
			removeWorktree({ repoRoot, worktreePath: c.worktreePath, force: c.dirty });
			// Unlike `worktree remove` (which preserves metadata so a later
			// re-attach can resume the same Claude session), clean only touches
			// worktrees whose PR is merged/closed — the issue is done, so drop
			// its metadata entry (session_id and all) instead of letting it
			// accumulate. issueId is null for detached-HEAD worktrees; skip those.
			const issueId = issueIdFromWorktreeDirName(path.basename(c.worktreePath));
			if (issueId) removeIssue(repoRoot, issueId);
			results.push({ branch: c.branch, ok: true });
		} catch (err) {
			const stderr =
				err && typeof err === "object" && "stderr" in err
					? String((err as { stderr: Buffer }).stderr).trim()
					: err instanceof Error
						? err.message
						: String(err);
			results.push({ branch: c.branch, ok: false, error: stderr });
		}
	}
	return results;
}

function PrTag({ pr }: { pr: PrInfo }) {
	const color = pr.state === "MERGED" ? "magenta" : pr.state === "CLOSED" ? "yellow" : "green";
	return (
		<Text>
			<Text>#{pr.number}</Text> <Text color={color}>{pr.state}</Text>
		</Text>
	);
}

export default function Clean({ options }: Props) {
	const { exit } = useApp();
	const [state, setState] = useState<State>({
		phase: "loading",
		message: "Inspecting worktrees...",
	});

	useEffect(() => {
		(async () => {
			try {
				const next = await loadCandidates(options.force);
				if (next.phase === "prompt") {
					// In non-interactive environments useInput will never fire, so we
					// require --yes up front rather than hanging the user.
					if (!process.stdin.isTTY && !options.yes) {
						setState({
							phase: "error",
							message: "Confirmation required but stdin is not a TTY (running non-interactive).",
							hint: "Re-run with `--yes` to skip the prompt.",
						});
						return;
					}
					if (options.yes) {
						setState({
							phase: "executing",
							repoRoot: next.repoRoot,
							candidates: next.candidates,
						});
						return;
					}
				}
				setState(next);
			} catch (err) {
				setState({
					phase: "error",
					message: err instanceof Error ? err.message : String(err),
				});
			}
		})();
	}, [options.force, options.yes]);

	useEffect(() => {
		if (state.phase === "executing") {
			const results = executeRemovals(state.repoRoot, state.candidates);
			setState({ phase: "done", results, cancelled: false });
		}
	}, [state.phase]);

	useEffect(() => {
		if (state.phase === "done" || state.phase === "error" || state.phase === "nothing") {
			// Defer one tick so the final UI paints before Ink unmounts.
			const t = setTimeout(() => exit(), 50);
			return () => clearTimeout(t);
		}
		return;
	}, [state.phase, exit]);

	useInput(
		(input, key) => {
			if (state.phase !== "prompt") return;
			if (input === "y" || input === "Y") {
				setState({
					phase: "executing",
					repoRoot: state.repoRoot,
					candidates: state.candidates,
				});
			} else if (input === "n" || input === "N" || key.return || key.escape) {
				setState({ phase: "done", results: [], cancelled: true });
			}
		},
		{ isActive: state.phase === "prompt" },
	);

	if (state.phase === "loading") {
		return (
			<Box>
				<Text color="cyan">
					<Spinner type="dots" />
				</Text>
				<Text> {state.message}</Text>
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

	if (state.phase === "nothing") {
		return (
			<Box padding={1}>
				<Text dimColor>{state.message}</Text>
			</Box>
		);
	}

	if (state.phase === "prompt" || state.phase === "executing") {
		const willCleanCount = state.candidates.filter((c) => c.willClean).length;
		return (
			<Box flexDirection="column" padding={1}>
				<Box marginBottom={1}>
					<Text bold color="cyan">
						mintree worktree clean
					</Text>
					<Text dimColor> · {state.candidates.length} candidate(s)</Text>
				</Box>
				{state.candidates.map((c, i) => (
					<Box key={i}>
						<Text color={c.willClean ? "green" : "yellow"}>{c.willClean ? "✓" : "○"}</Text>
						<Text> </Text>
						<Text color="cyan">{c.branch}</Text>
						<Text> </Text>
						<PrTag pr={c.pr} />
						{c.dirty && <Text color="yellow"> [dirty]</Text>}
						{c.reasonSkipped && <Text dimColor> — {c.reasonSkipped}</Text>}
					</Box>
				))}
				<Box marginTop={1}>
					{state.phase === "prompt" ? (
						<Text>
							Remove {willCleanCount} worktree(s)? <Text bold>[y/N]</Text>
						</Text>
					) : (
						<Box>
							<Text color="cyan">
								<Spinner type="dots" />
							</Text>
							<Text> Removing...</Text>
						</Box>
					)}
				</Box>
			</Box>
		);
	}

	// state.phase === "done"
	if (state.cancelled) {
		return (
			<Box padding={1}>
				<Text dimColor>Cancelled. No worktrees were removed.</Text>
			</Box>
		);
	}
	const okCount = state.results.filter((r) => r.ok).length;
	const failCount = state.results.length - okCount;
	return (
		<Box flexDirection="column" padding={1}>
			<Box marginBottom={1}>
				<Text bold color="cyan">
					mintree worktree clean · done
				</Text>
			</Box>
			{state.results.map((r, i) => (
				<Box key={i}>
					<Text color={r.ok ? "green" : "red"}>{r.ok ? "✓" : "✗"}</Text>
					<Text> </Text>
					<Text color="cyan">{r.branch}</Text>
					{!r.ok && <Text color="red"> — {r.error}</Text>}
				</Box>
			))}
			<Box marginTop={1}>
				<Text>
					Removed {okCount}
					{failCount > 0 && (
						<>
							{", "}
							<Text color="red">{failCount} failed</Text>
						</>
					)}
					. Branches preserved; metadata entries pruned.
				</Text>
			</Box>
		</Box>
	);
}

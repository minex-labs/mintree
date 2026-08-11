import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { option } from "pastel";
import { z } from "zod";
import * as path from "path";

import {
	findMainRepoRoot,
	getWorktreesDir,
	listWorktrees,
	isDirty,
	getAheadBehind,
	pathExists,
	getMintreeDir,
	type AheadBehind,
} from "../../lib/git.js";
import { readMetadata } from "../../lib/metadata.js";
import { fetchPrForBranch, type PrInfo } from "../../lib/pr.js";

export const description = "List mintree-managed worktrees with dirty/ahead/PR status";

export const options = z.object({
	pr: z
		.boolean()
		.default(false)
		.describe(option({ description: "Look up PR status for each branch via `gh` (slower)" })),
});

type Props = {
	options: z.infer<typeof options>;
};

type Row = {
	worktreePath: string;
	branch: string;
	issueId: string | null;
	dirty: boolean;
	ab: AheadBehind | null;
	pr?: PrInfo;
};

type State =
	| { phase: "loading" }
	| { phase: "error"; message: string; hint?: string }
	| { phase: "empty"; repoRoot: string }
	| { phase: "ready"; repoRoot: string; rows: Row[]; checkedPr: boolean };

// Matches the BRANCH_REGEX shape from lib/branch.ts: either `\d+` (GitHub)
// or `<TEAM>-\d+` (Linear). Used to surface FE-123 in the ISSUE column.
const ISSUE_ID_REGEX = /^[a-z]+\/((?:[A-Z][A-Z0-9_]*-)?\d+)-/;

function extractIssueId(branch: string | null): string | null {
	if (!branch) return null;
	const m = branch.match(ISSUE_ID_REGEX);
	return m && m[1] ? m[1] : null;
}

async function load(checkPr: boolean): Promise<State> {
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
	const ours = all.filter((w) => {
		// Filter to worktrees that live under .mintree/worktrees/. macOS reports
		// /private/tmp paths so use a relative-prefix check after resolving both
		// to absolute.
		const wAbs = path.resolve(w.path);
		const dirAbs = path.resolve(worktreesDir);
		return wAbs === dirAbs || wAbs.startsWith(dirAbs + path.sep);
	});

	if (ours.length === 0) {
		return { phase: "empty", repoRoot: root };
	}

	const metadata = readMetadata(root);
	const rows: Row[] = ours.map((w) => {
		const issueId = extractIssueId(w.branch);
		const baseFromMeta = issueId ? metadata.issues[issueId]?.base_branch : undefined;
		return {
			worktreePath: w.path,
			branch: w.branch ?? "(detached)",
			issueId,
			dirty: isDirty(w.path),
			ab: getAheadBehind(w.path, baseFromMeta),
		};
	});

	if (checkPr) {
		const prResults = await Promise.all(
			rows.map((r) =>
				r.branch === "(detached)"
					? Promise.resolve(null)
					: fetchPrForBranch(r.branch, { withUrl: false }),
			),
		);
		rows.forEach((r, i) => {
			const pr = prResults[i];
			if (pr) r.pr = pr;
		});
	}

	return { phase: "ready", repoRoot: root, rows, checkedPr: checkPr };
}

function StatusCell({ dirty }: { dirty: boolean }) {
	return dirty ? <Text color="yellow">dirty</Text> : <Text color="green">clean</Text>;
}

function AheadBehindCell({ ab }: { ab: AheadBehind | null }) {
	if (!ab) return <Text dimColor>—</Text>;
	const isUp = ab.ahead === 0 && ab.behind === 0;
	if (isUp) return <Text dimColor>=</Text>;
	return (
		<Text>
			<Text color={ab.ahead > 0 ? "cyan" : undefined}>+{ab.ahead}</Text>
			<Text dimColor> / </Text>
			<Text color={ab.behind > 0 ? "magenta" : undefined}>-{ab.behind}</Text>
		</Text>
	);
}

function PrCell({ pr, checked }: { pr?: PrInfo; checked: boolean }) {
	if (!checked) return null;
	if (!pr) return <Text dimColor>—</Text>;
	const color = pr.state === "OPEN" ? "green" : pr.state === "MERGED" ? "magenta" : "yellow";
	return (
		<Text>
			<Text>#{pr.number}</Text>
			<Text dimColor> </Text>
			<Text color={color}>{pr.state}</Text>
		</Text>
	);
}

function pad(s: string, width: number): string {
	if (s.length >= width) return s;
	return s + " ".repeat(width - s.length);
}

export default function List({ options }: Props) {
	const [state, setState] = useState<State>({ phase: "loading" });

	useEffect(() => {
		(async () => {
			try {
				setState(await load(options.pr));
			} catch (err) {
				setState({
					phase: "error",
					message: err instanceof Error ? err.message : String(err),
				});
			}
		})();
	}, [options.pr]);

	if (state.phase === "loading") {
		return (
			<Box>
				<Text color="cyan">
					<Spinner type="dots" />
				</Text>
				<Text> Listing worktrees{options.pr ? " (checking PR status)" : ""}...</Text>
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

	if (state.phase === "empty") {
		return (
			<Box flexDirection="column" padding={1}>
				<Text dimColor>No mintree worktrees in {state.repoRoot}.</Text>
				<Box marginTop={1}>
					<Text>
						Create one with <Text bold>mintree worktree create &lt;branch&gt;</Text>.
					</Text>
				</Box>
			</Box>
		);
	}

	const issueWidth = Math.max(5, ...state.rows.map((r) => (r.issueId ?? "—").length));
	const branchWidth = Math.max(6, ...state.rows.map((r) => r.branch.length));

	return (
		<Box flexDirection="column" padding={1}>
			<Box marginBottom={1}>
				<Text bold>{pad("ISSUE", issueWidth)}</Text>
				<Text> </Text>
				<Text bold>{pad("BRANCH", branchWidth)}</Text>
				<Text> </Text>
				<Text bold>STATUS</Text>
				<Text> </Text>
				<Text bold>Δ</Text>
				<Text> </Text>
				{state.checkedPr && <Text bold>PR</Text>}
			</Box>
			{state.rows.map((r, i) => (
				<Box key={i}>
					<Text>{pad(r.issueId ?? "—", issueWidth)}</Text>
					<Text> </Text>
					<Text color="cyan">{pad(r.branch, branchWidth)}</Text>
					<Text> </Text>
					<Box width={9}>
						<StatusCell dirty={r.dirty} />
					</Box>
					<Box width={12}>
						<AheadBehindCell ab={r.ab} />
					</Box>
					<PrCell pr={r.pr} checked={state.checkedPr} />
				</Box>
			))}
		</Box>
	);
}

/**
 * Shared `gh pr list` helpers. The dashboard, `worktree list --pr`, and
 * `worktree clean` all need to look up the PR status of a branch, with the
 * same `gh pr list --head <branch>` shape. Centralising them here avoids
 * three copies of the shell-quote + JSON-parse dance going out of sync.
 *
 * PR detection stays gh-only even when the issue provider is Linear —
 * mintree's worktree branches live on GitHub, and Linear has no concept of
 * git PRs. Callers that aren't sure whether `gh` is available pass through
 * `tryExec`-style failures as `null`, so the dashboard degrades to "no PR"
 * rows instead of erroring.
 */

import { tryExec } from "./exec.js";

export type PrState = "OPEN" | "CLOSED" | "MERGED";

export type PrInfo = {
	number: number;
	state: PrState;
	url?: string;
};

type RawPr = {
	number: number;
	state: string;
	url?: string;
};

function shQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function normaliseState(s: string): PrState | null {
	const u = s.toUpperCase();
	if (u === "OPEN" || u === "CLOSED" || u === "MERGED") return u;
	return null;
}

/**
 * Looks up the most recent PR for a branch (any state). Returns null when
 * there's no PR or `gh` can't reach the API. `withUrl` controls whether the
 * URL field is requested — dashboard wants it for display, list/clean don't.
 */
export async function fetchPrForBranch(
	branch: string,
	{ withUrl = true }: { withUrl?: boolean } = {},
): Promise<PrInfo | null> {
	const fields = withUrl ? "number,state,url" : "number,state";
	const out = await tryExec(
		`gh pr list --head ${shQuote(branch)} --state all --json ${fields} --limit 1 2>/dev/null`,
	);
	if (!out) return null;
	try {
		const arr = JSON.parse(out) as RawPr[];
		if (!Array.isArray(arr) || arr.length === 0 || !arr[0]) return null;
		const first = arr[0];
		const state = normaliseState(first.state);
		if (!state) return null;
		const result: PrInfo = { number: first.number, state };
		if (withUrl && first.url) result.url = first.url;
		return result;
	} catch {
		return null;
	}
}

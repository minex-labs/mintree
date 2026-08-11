/**
 * Thin shell helpers around the `gh` CLI. These are deliberately
 * provider-agnostic — even when mintree's issue provider is Linear, `gh` is
 * still used to look up PR status for worktree branches, so doctor and a
 * couple of dashboard surfaces need to know whether `gh` is reachable.
 *
 * The GitHub issue / Project v2 logic lives in `providers/github.ts` and
 * uses these helpers internally; the Linear provider doesn't touch them.
 */

import { tryExec } from "./exec.js";

export async function ghCliAvailable(): Promise<boolean> {
	const out = await tryExec("which gh");
	return !!out;
}

export async function getGhUserLogin(): Promise<string | null> {
	return tryExec("gh api user --jq .login 2>/dev/null");
}

/**
 * Returns "owner/name" for the GitHub repo of the current working directory,
 * or null if not a GitHub repo / `gh` can't reach the API.
 */
export async function getRepoFullName(): Promise<string | null> {
	return tryExec("gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null");
}

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
export type PrState = "OPEN" | "CLOSED" | "MERGED";
export type PrInfo = {
    number: number;
    state: PrState;
    url?: string;
};
/**
 * Looks up the most recent PR for a branch (any state). Returns null when
 * there's no PR or `gh` can't reach the API. `withUrl` controls whether the
 * URL field is requested — dashboard wants it for display, list/clean don't.
 */
export declare function fetchPrForBranch(branch: string, { withUrl }?: {
    withUrl?: boolean;
}): Promise<PrInfo | null>;

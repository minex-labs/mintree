import { type AheadBehind } from "./git.js";
import { type PrInfo } from "./pr.js";
import type { IssueProjectInfo, LoadOptions, ProviderIssue } from "./providers/types.js";
export type { PrInfo, PrState } from "./pr.js";
export type { ProviderIssue, IssueProjectInfo, IssueId, LoadOptions } from "./providers/types.js";
export type WorktreeInfo = {
    path: string;
    branch: string | null;
    dirty: boolean;
    ab: AheadBehind | null;
    sessionId?: string;
    unregistered?: boolean;
};
export type SessionStateValue = "active" | "idle" | "waiting" | "exited";
export type SessionStateInfo = {
    state: SessionStateValue;
    at: string;
    message: string | null;
};
export type DashboardIssue = {
    issue: ProviderIssue;
    worktree: WorktreeInfo | null;
    session: SessionStateInfo | null;
    pr: PrInfo | null;
    project: IssueProjectInfo | null;
    orphan?: boolean;
};
/**
 * Builds a map from issue id (the canonical string — "100" on GitHub,
 * "FE-123" on Linear) to the matching mintree worktree.
 * IssueId comes from the worktree dir name (`<issue>-<desc>`) rather than
 * the branch, so detached worktrees (created via the dashboard's "current
 * branch" mode) are included alongside the regular branch-based ones.
 * Worktrees outside `.mintree/worktrees/` are skipped.
 *
 * Registered worktrees come from `git worktree list`; the directory scan then
 * adds anything on disk that git has forgotten (see `scanUnregistered`).
 */
export declare function buildWorktreeIndex(repoRoot: string): Map<string, WorktreeInfo>;
/**
 * Top-level loader: enriches each assigned issue with its worktree and
 * session snapshot. Designed to be called on dashboard mount and on every
 * `r` refresh — cheap because all the per-worktree probes are local.
 */
export declare function loadDashboard(repoRoot: string, opts?: LoadOptions): Promise<DashboardIssue[] | null>;

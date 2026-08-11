/**
 * Returns the absolute path of the **main** git repo root (not a worktree's
 * checkout). When invoked from inside a linked worktree, `git rev-parse
 * --show-toplevel` would return the worktree path; we resolve the common git
 * directory instead so callers always get the canonical place where `.mintree/`
 * lives. Returns `null` when not inside a git repository.
 */
export declare function findMainRepoRoot(cwd?: string): string | null;
export declare function getMintreeDir(repoRoot: string): string;
export declare function getMetadataPath(repoRoot: string): string;
export declare function getWorktreesDir(repoRoot: string): string;
export declare function getSessionStatesDir(repoRoot: string): string;
export declare function getInitScriptPath(repoRoot: string): string;
/** Checks whether a path is gitignored according to the repo's rules. */
export declare function isGitIgnored(relativePath: string, cwd: string): boolean;
/**
 * True when the path is currently tracked by git in the repo at `cwd`. A
 * gitignore'd path can still be tracked if it was added before being
 * ignored — in that case `git rm --cached` is required to untrack it.
 */
export declare function isGitTracked(relativePath: string, cwd: string): boolean;
/**
 * Looks for a file or directory in the repo that's likely to document the
 * project's branch / git conventions. The first hit wins — we just want
 * something to point the user at, not an exhaustive scan. Paths returned
 * are relative to `repoRoot` so they're safe to display.
 */
export declare function findBranchConventionDoc(repoRoot: string): string | null;
export declare function pathExists(p: string): boolean;
export declare function isExecutable(p: string): boolean;
/**
 * Appends `entries` to `<repoRoot>/.gitignore`, skipping any entry already
 * matched by the repo's gitignore rules. Creates the file if missing. Returns
 * the entries that were actually appended.
 */
export declare function ensureGitignoreEntries(repoRoot: string, entries: string[]): string[];
/**
 * Best-effort default branch detection. Tries `origin/HEAD` first (the most
 * authoritative source when the repo has a remote), then falls back to `main`
 * and `master` as on-disk heuristics. Returns null only when none of those
 * exist locally or on the remote.
 */
export declare function getDefaultBranch(repoRoot: string): string | null;
export type BranchExistence = "local" | "remote" | null;
export declare function branchExists(repoRoot: string, branch: string): BranchExistence;
/**
 * True when `origin/<branch>` resolves locally. Unlike `branchExists`, this
 * reports the remote-tracking ref even when a local branch of the same name
 * also exists — callers that want to fork from the freshest remote tip need
 * to know the remote ref is there, not just "some ref named X".
 */
export declare function remoteBranchExists(repoRoot: string, branch: string): boolean;
export type FetchResult = {
    ok: boolean;
    reason?: string;
};
/**
 * Best-effort `git fetch origin` so worktrees get created off fresh refs
 * instead of a stale local checkout. Never throws: when there's no `origin`
 * remote or the network is down, returns `{ ok: false, reason }` and callers
 * fall back to whatever refs are already local.
 */
export declare function fetchRemote(repoRoot: string): FetchResult;
/**
 * Returns the absolute path where `branch` is checked out as a worktree, or
 * null when the branch is not checked out anywhere. Parses the porcelain
 * format of `git worktree list --porcelain`.
 */
export declare function worktreeForBranch(repoRoot: string, branch: string): string | null;
/**
 * Creates a git worktree at `worktreePath` checked out on `branch`. Behavior
 * depending on whether `branch` already exists:
 *  - new branch: `git worktree add -b <branch> <path> <base>`
 *  - local branch: `git worktree add <path> <branch>`
 *  - remote-only branch: `git worktree add --track -b <branch> <path>
 *    origin/<branch>` (creates a tracking local)
 *
 * Throws on failure with stderr included so the caller can surface it.
 */
export declare function addWorktree(args: {
    repoRoot: string;
    branch: string;
    worktreePath: string;
    base?: string;
}): void;
/**
 * Removes a worktree via `git worktree remove`. With `force=true`, also
 * removes the worktree even if it has uncommitted changes. Throws on failure.
 */
export declare function removeWorktree(args: {
    repoRoot: string;
    worktreePath: string;
    force?: boolean;
}): void;
/**
 * Runs `git worktree prune` to clean up worktree references whose on-disk
 * directory no longer exists.
 */
export declare function pruneWorktrees(repoRoot: string): void;
export type WorktreeEntry = {
    path: string;
    branch: string | null;
    head: string | null;
};
/**
 * Parses `git worktree list --porcelain` into structured entries. Includes
 * detached HEADs (branch=null) and the main worktree. Caller is responsible
 * for filtering to mintree-managed worktrees.
 */
export declare function listWorktrees(repoRoot: string): WorktreeEntry[];
/** True when the worktree has any uncommitted changes (porcelain non-empty). */
export declare function isDirty(worktreePath: string): boolean;
/**
 * Returns the current branch of the git checkout at `cwd`, or null when in a
 * detached HEAD or outside a git repo.
 */
export declare function getCurrentBranch(cwd: string): string | null;
export type AheadBehind = {
    ahead: number;
    behind: number;
    against: string;
};
/**
 * Returns commits ahead/behind `against` from the worktree's HEAD. `against`
 * is resolved in this priority: explicit param > `@{upstream}` > null.
 * Returns null when no comparison ref is available.
 */
export declare function getAheadBehind(worktreePath: string, against?: string): AheadBehind | null;

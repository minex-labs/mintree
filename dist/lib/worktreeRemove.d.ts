export type RemoveResult = {
    ok: true;
    branch: string;
    worktreePath: string;
    variant: "removed" | "pruned-orphan" | "removed-unregistered";
    wasDirty: boolean;
    prunedIssueId: string | null;
} | {
    ok: false;
    message: string;
    hint?: string;
};
/**
 * Turns a failed `git worktree remove` into a RemoveResult. When the failure
 * is a `Permission denied` deleting files under the worktree, it's almost
 * always a Docker Compose stack still bound to the worktree (`make
 * worktree-up` leaves containers holding the directory; the files they
 * created can't be `rm`'d while the stack is up). Surface that as a hint so
 * the user knows to tear the stack down first — the raw git error gives no
 * clue. Any other error is passed through without a hint.
 */
export declare function removeFailure(stderr: string): Extract<RemoveResult, {
    ok: false;
}>;
/**
 * Removes the worktree backing `branchArg`. Same behavior as the CLI command:
 *  - dirty + !force → refuse
 *  - directory missing on disk → prune the dangling git reference
 *  - otherwise → `git worktree remove` (with --force when asked)
 *
 * The branch is deliberately preserved (it may have an open PR); the issue's
 * metadata entry is pruned — see `pruneMetadataFor`.
 *
 * The branch name is NOT validated against the naming convention here:
 * removal is a cleanup op, and a worktree on a non-canonical branch (e.g.
 * one with a lowercase Linear team key) must still be removable.
 */
export declare function runRemove(branchArg: string, force: boolean): RemoveResult;
/**
 * Path-keyed counterpart to `runRemove`, used for worktrees that don't have
 * a parseable branch (detached HEAD ones created via the dashboard's
 * "current branch" mode). Same dirty/force/prune semantics as runRemove —
 * just skips the `parseBranch` step and reports the worktree by its path.
 */
export declare function runRemoveByPath(worktreePath: string, force: boolean): RemoveResult;

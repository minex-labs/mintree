import * as fs from "fs";
import * as path from "path";

import {
	findMainRepoRoot,
	getMintreeDir,
	getWorktreesDir,
	worktreeForBranch,
	listWorktrees,
	isDirty,
	removeWorktree,
	pruneWorktrees,
	pathExists,
} from "./git.js";
import { issueIdFromWorktreeDirName } from "./branch.js";
import { removeIssue } from "./metadata.js";

export type RemoveResult =
	| {
			ok: true;
			branch: string;
			worktreePath: string;
			// "removed"            → `git worktree remove` on a registered worktree
			// "pruned-orphan"      → git knew it, but the directory was already gone
			// "removed-unregistered" → directory on disk that git no longer tracks
			variant: "removed" | "pruned-orphan" | "removed-unregistered";
			wasDirty: boolean;
			// Issue id whose metadata entry was dropped alongside the worktree, or
			// null when the directory name carried no parseable id (detached
			// worktrees) or there was no entry to begin with.
			prunedIssueId: string | null;
	  }
	| { ok: false; message: string; hint?: string };

/**
 * Turns a failed `git worktree remove` into a RemoveResult. When the failure
 * is a `Permission denied` deleting files under the worktree, it's almost
 * always a Docker Compose stack still bound to the worktree (`make
 * worktree-up` leaves containers holding the directory; the files they
 * created can't be `rm`'d while the stack is up). Surface that as a hint so
 * the user knows to tear the stack down first — the raw git error gives no
 * clue. Any other error is passed through without a hint.
 */
export function removeFailure(stderr: string): Extract<RemoveResult, { ok: false }> {
	const message = `git worktree remove failed: ${stderr}`;
	if (/permission denied/i.test(stderr)) {
		return {
			ok: false,
			message,
			hint: "A Docker Compose stack may still be up on this worktree (from `make worktree-up`). Bring it down first — e.g. `docker compose -p <project> down -v` in the worktree — then remove again.",
		};
	}
	return { ok: false, message };
}

/**
 * Drops the metadata entry for the issue this worktree belonged to. The issue
 * id comes from the directory name (`FE-68`, or the legacy `<id>-<desc>`),
 * which is how `worktree clean` locates it too. Returns the pruned id, or null
 * for a detached worktree whose dir name carries no id, or when there was no
 * entry to remove.
 *
 * Removing a worktree used to preserve the entry so a later re-attach could
 * resume the same Claude session. In practice the entries only ever
 * accumulated — a repo hit ~200 of them against zero live worktrees — so
 * removal now prunes, matching `clean`. The cost is that re-creating a
 * worktree for the same issue starts a fresh Claude session.
 */
function pruneMetadataFor(repoRoot: string, worktreePath: string): string | null {
	const issueId = issueIdFromWorktreeDirName(path.basename(worktreePath));
	if (!issueId) return null;
	return removeIssue(repoRoot, issueId) ? issueId : null;
}

/** True when `git worktree list` still tracks this exact path. */
function isRegisteredWorktree(repoRoot: string, worktreePath: string): boolean {
	const target = path.resolve(worktreePath);
	return listWorktrees(repoRoot).some((w) => path.resolve(w.path) === target);
}

/**
 * Deletes a directory that sits in `.mintree/worktrees/` but that git no longer
 * tracks. These appear when the worktree's admin dir (`.git/worktrees/<id>`)
 * goes away while the checkout stays behind — most often because the repo
 * directory was renamed or moved, which breaks the absolute paths git stores on
 * both ends and makes `git worktree prune` drop the reference. `git worktree
 * remove` refuses to touch them ("is not a working tree"), so the only way out
 * is a plain recursive delete.
 *
 * Two guards, because this is an `rm -rf` with no git safety net:
 *  - the path must live under `.mintree/worktrees/`, so a bad caller can't
 *    delete something outside the mintree-managed area;
 *  - `force` is required, since without a git admin dir there is no way to
 *    check for uncommitted changes first.
 */
function removeUnregistered(
	repoRoot: string,
	worktreePath: string,
	label: string,
	force: boolean,
): RemoveResult {
	const worktreesRoot = path.resolve(getWorktreesDir(repoRoot));
	const target = path.resolve(worktreePath);
	if (!target.startsWith(worktreesRoot + path.sep)) {
		return {
			ok: false,
			message: `Refusing to delete ${worktreePath}: it is not registered with git and lives outside .mintree/worktrees/.`,
		};
	}

	if (!force) {
		return {
			ok: false,
			message: `${label} is not registered with git, so its uncommitted changes can't be checked.`,
			hint: "Deleting it is a plain `rm -rf`. Pass --force (or press Y in the dashboard) to go ahead.",
		};
	}

	try {
		fs.rmSync(target, { recursive: true, force: true });
	} catch (err) {
		return {
			ok: false,
			message: `Failed to delete ${worktreePath}: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	// Clears any reference git may still hold elsewhere (harmless when there
	// is none) and keeps the repo's worktree list tidy.
	try {
		pruneWorktrees(repoRoot);
	} catch {
		// Non-fatal: the directory is gone, which is what the user asked for.
	}

	return {
		ok: true,
		branch: label,
		worktreePath,
		variant: "removed-unregistered",
		wasDirty: false,
		prunedIssueId: pruneMetadataFor(repoRoot, worktreePath),
	};
}

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
export function runRemove(branchArg: string, force: boolean): RemoveResult {
	const root = findMainRepoRoot();
	if (!root) {
		return {
			ok: false,
			message: "Not in a git repository.",
			hint: "Run `git init` and then `mintree init`.",
		};
	}
	if (!pathExists(getMintreeDir(root))) {
		return {
			ok: false,
			message: ".mintree/ not found in this repo.",
			hint: "Run `mintree init` first.",
		};
	}

	const worktreePath = worktreeForBranch(root, branchArg);
	if (!worktreePath) {
		return {
			ok: false,
			message: `No worktree found for branch ${branchArg}.`,
			hint: "Use `mintree worktree list` to see existing worktrees.",
		};
	}

	if (!pathExists(worktreePath)) {
		try {
			pruneWorktrees(root);
		} catch (err) {
			return {
				ok: false,
				message: `git worktree prune failed: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
		return {
			ok: true,
			branch: branchArg,
			worktreePath,
			variant: "pruned-orphan",
			wasDirty: false,
			prunedIssueId: pruneMetadataFor(root, worktreePath),
		};
	}

	const dirty = isDirty(worktreePath);
	if (dirty && !force) {
		return {
			ok: false,
			message: `Worktree at ${worktreePath} has uncommitted changes.`,
			hint: "Commit/stash first, or pass --force to discard them.",
		};
	}

	try {
		removeWorktree({ repoRoot: root, worktreePath, force });
	} catch (err) {
		const stderr =
			err && typeof err === "object" && "stderr" in err
				? String((err as { stderr: Buffer }).stderr).trim()
				: err instanceof Error
					? err.message
					: String(err);
		return removeFailure(stderr);
	}

	return {
		ok: true,
		branch: branchArg,
		worktreePath,
		variant: "removed",
		wasDirty: dirty,
		prunedIssueId: pruneMetadataFor(root, worktreePath),
	};
}

/**
 * Path-keyed counterpart to `runRemove`, used for worktrees that don't have
 * a parseable branch (detached HEAD ones created via the dashboard's
 * "current branch" mode). Same dirty/force/prune semantics as runRemove —
 * just skips the `parseBranch` step and reports the worktree by its path.
 */
export function runRemoveByPath(worktreePath: string, force: boolean): RemoveResult {
	const root = findMainRepoRoot();
	if (!root) {
		return {
			ok: false,
			message: "Not in a git repository.",
			hint: "Run `git init` and then `mintree init`.",
		};
	}
	if (!pathExists(getMintreeDir(root))) {
		return {
			ok: false,
			message: ".mintree/ not found in this repo.",
			hint: "Run `mintree init` first.",
		};
	}

	const label = worktreePath.split("/").pop() ?? worktreePath;

	if (!pathExists(worktreePath)) {
		try {
			pruneWorktrees(root);
		} catch (err) {
			return {
				ok: false,
				message: `git worktree prune failed: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
		return {
			ok: true,
			branch: label,
			worktreePath,
			variant: "pruned-orphan",
			wasDirty: false,
			prunedIssueId: pruneMetadataFor(root, worktreePath),
		};
	}

	// Directory on disk that git no longer tracks — `git worktree remove` would
	// bail with "is not a working tree", so take the rm -rf path instead.
	if (!isRegisteredWorktree(root, worktreePath)) {
		return removeUnregistered(root, worktreePath, label, force);
	}

	const dirty = isDirty(worktreePath);
	if (dirty && !force) {
		return {
			ok: false,
			message: `Worktree at ${worktreePath} has uncommitted changes.`,
			hint: "Commit/stash first, or pass --force to discard them.",
		};
	}

	try {
		removeWorktree({ repoRoot: root, worktreePath, force });
	} catch (err) {
		const stderr =
			err && typeof err === "object" && "stderr" in err
				? String((err as { stderr: Buffer }).stderr).trim()
				: err instanceof Error
					? err.message
					: String(err);
		return removeFailure(stderr);
	}

	return {
		ok: true,
		branch: label,
		worktreePath,
		variant: "removed",
		wasDirty: dirty,
		prunedIssueId: pruneMetadataFor(root, worktreePath),
	};
}

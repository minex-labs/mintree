import * as fs from "fs";
import * as path from "path";

import {
	listWorktrees,
	getWorktreesDir,
	isDirty,
	getAheadBehind,
	type AheadBehind,
} from "./git.js";
import { issueIdFromWorktreeDirName } from "./branch.js";
import { readMetadata } from "./metadata.js";
import { fetchPrForBranch, type PrInfo } from "./pr.js";
import { prioritySortRank } from "./priority.js";
import { createProvider } from "./providers/index.js";
import type { IssueProjectInfo, LoadOptions, ProviderIssue } from "./providers/types.js";

export type { PrInfo, PrState } from "./pr.js";
export type { ProviderIssue, IssueProjectInfo, IssueId, LoadOptions } from "./providers/types.js";

export type WorktreeInfo = {
	path: string;
	// null when the worktree is checked out in detached HEAD (the "current
	// branch" overlay mode in the dashboard creates these). Callers that
	// need to identify the worktree use the path; branch is for display.
	branch: string | null;
	dirty: boolean;
	ab: AheadBehind | null;
	sessionId?: string;
	// True for a directory sitting in `.mintree/worktrees/` that `git worktree
	// list` doesn't know about. Its git metadata is gone, so branch/dirty/ahead
	// can't be read — the dashboard shows it as removable dead weight and the
	// remove flow deletes it outright instead of going through git.
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
	// null when the issue isn't on any project board, or when the project
	// lookup failed (e.g. the gh token lacks the `project` scope). The
	// dashboard falls back to an ungrouped flat list in that case.
	project: IssueProjectInfo | null;
	// True for synthetic rows that represent a worktree on disk whose issueId
	// no longer appears in the assigned-issues list (issue closed, reassigned,
	// renamed, deleted, or just a stale local worktree). These rows have a
	// stub `issue` and live in the "Orphaned Worktrees" group at the end of
	// the list so the user can still see them and `d`elete them.
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
export function buildWorktreeIndex(repoRoot: string): Map<string, WorktreeInfo> {
	const worktreesRoot = path.resolve(getWorktreesDir(repoRoot));
	const index = new Map<string, WorktreeInfo>();

	for (const w of listWorktrees(repoRoot)) {
		const wAbs = path.resolve(w.path);
		if (wAbs !== worktreesRoot && !wAbs.startsWith(worktreesRoot + path.sep)) continue;

		const issueId = issueIdFromWorktreeDirName(path.basename(wAbs));
		if (!issueId) continue;

		index.set(issueId, {
			path: w.path,
			branch: w.branch,
			dirty: isDirty(w.path),
			ab: getAheadBehind(w.path),
		});
	}

	scanUnregistered(worktreesRoot, index);

	return index;
}

/**
 * Adds directories that live in `.mintree/worktrees/` but that git no longer
 * tracks. Until this existed the dashboard derived its worktree list purely
 * from `git worktree list`, so these were invisible — and therefore
 * impossible to remove with `d`, even though they're full checkouts eating
 * disk.
 *
 * They show up when the worktree's git admin dir disappears while the checkout
 * survives. The common cause is renaming or moving the repo directory: git
 * records absolute paths on both ends of a worktree, so the rename breaks the
 * link and the next `git worktree prune` (which git runs on its own during
 * plenty of ordinary commands) drops the reference, stranding the checkout.
 *
 * Only `dirName` is trustworthy for these — branch, dirty and ahead/behind all
 * need the admin dir that's gone — so the entry is flagged `unregistered` and
 * left otherwise blank.
 */
function scanUnregistered(worktreesRoot: string, index: Map<string, WorktreeInfo>): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(worktreesRoot, { withFileTypes: true });
	} catch {
		// No worktrees dir yet (repo never ran a create) — nothing to scan.
		return;
	}

	const registered = new Set(Array.from(index.values(), (w) => path.resolve(w.path)));

	for (const entry of entries) {
		// Skip loose files like .DS_Store; a worktree is always a directory.
		if (!entry.isDirectory()) continue;
		const abs = path.join(worktreesRoot, entry.name);
		if (registered.has(path.resolve(abs))) continue;

		const issueId = issueIdFromWorktreeDirName(entry.name);
		if (!issueId) continue;
		// A registered worktree for this issue wins — same-id collisions would
		// otherwise mask the live one behind a stale directory.
		if (index.has(issueId)) continue;

		index.set(issueId, {
			path: abs,
			branch: null,
			dirty: false,
			ab: null,
			unregistered: true,
		});
	}
}

/**
 * Reads the live state file written by the session-signal hooks. Returns null
 * when the file doesn't exist, can't be parsed, or holds an unrecognised state
 * value — the dashboard treats those as "no live session".
 */
function readSessionState(repoRoot: string, issueId: string): SessionStateInfo | null {
	const file = path.join(repoRoot, ".mintree", "session-states", `${issueId}.json`);
	if (!fs.existsSync(file)) return null;
	try {
		const data = JSON.parse(fs.readFileSync(file, "utf-8"));
		const state = data?.state;
		if (!isSessionState(state)) return null;
		return {
			state,
			at: typeof data.at === "string" ? data.at : "",
			message: typeof data.message === "string" ? data.message : null,
		};
	} catch {
		return null;
	}
}

function isSessionState(v: unknown): v is SessionStateValue {
	return v === "active" || v === "idle" || v === "waiting" || v === "exited";
}

/**
 * Orders the flat issue list so issues are contiguous by project, then by
 * Status (board column order), then newest issue first. The dashboard derives
 * its group headers by walking this already-ordered array.
 *
 * Project group order: a config-pinned project first, then other projects
 * alphabetically, then issues with no project ("Sin proyecto"), then orphan
 * worktrees last.
 */
function sortGroupedIssues(
	issues: DashboardIssue[],
	configuredUrl: string | null,
): DashboardIssue[] {
	const projectTier = (d: DashboardIssue): number => {
		if (d.orphan) return 3;
		if (!d.project) return 2;
		if (configuredUrl && d.project.projectUrl === configuredUrl) return 0;
		return 1;
	};
	return [...issues].sort((a, b) => {
		const ta = projectTier(a);
		const tb = projectTier(b);
		if (ta !== tb) return ta - tb;
		if (a.project && b.project) {
			const byTitle = a.project.projectTitle.localeCompare(b.project.projectTitle);
			if (byTitle !== 0) return byTitle;
			if (a.project.statusOrder !== b.project.statusOrder) {
				return a.project.statusOrder - b.project.statusOrder;
			}
		}
		// Within a status group, surface higher-priority issues first
		// (Urgent → Low; "no priority" sinks to the bottom). Orphans and
		// GitHub rows have null priority and so fall through to the date sort.
		const pa = prioritySortRank(a.issue.priority);
		const pb = prioritySortRank(b.issue.priority);
		if (pa !== pb) return pa - pb;
		// Newest-first for issues — id is a numeric-or-prefixed string. Numeric
		// compare falls back to localeCompare for non-numeric ids (Linear's
		// "FE-123" form).
		const an = Number(a.issue.id);
		const bn = Number(b.issue.id);
		if (Number.isFinite(an) && Number.isFinite(bn)) return bn - an;
		return b.issue.id.localeCompare(a.issue.id);
	});
}

/**
 * Synthetic DashboardIssue rows for worktrees on disk whose issueId isn't in
 * the provider's assigned-issues list. These end up grouped under "Orphaned
 * Worktrees" at the bottom of the dashboard so the user can find and `d`elete
 * them.
 *
 * The `issue` stub uses the worktree directory name as the title — the bare
 * issue id (e.g. "FE-123"), or the legacy "<id>-<desc>" suffix for older
 * worktrees — so the row is identifiable even when there's no live issue to
 * fetch a title from.
 */
function buildOrphanRows(
	worktreesByIssue: Map<string, WorktreeInfo>,
	assignedIds: Set<string>,
	sessionLookup: (issueId: string) => SessionStateInfo | null,
	prByBranch: Map<string, PrInfo>,
	metadataSessionId: (issueId: string) => string | undefined,
): DashboardIssue[] {
	const orphans: DashboardIssue[] = [];
	for (const [issueId, w] of worktreesByIssue) {
		if (assignedIds.has(issueId)) continue;
		const dirName = path.basename(w.path);
		// Strip the leading "<issueId>-" — that leaves the kebab description
		// that originally seeded the branch name.
		const desc = dirName.startsWith(`${issueId}-`) ? dirName.slice(issueId.length + 1) : dirName;
		const sessionId = metadataSessionId(issueId);
		const worktree = { ...w, sessionId };
		const pr = w.branch ? (prByBranch.get(w.branch) ?? null) : null;
		orphans.push({
			issue: {
				id: issueId,
				title: desc || dirName,
				state: "UNKNOWN",
				url: "",
				labels: [],
				body: "",
				createdAt: "",
				updatedAt: "",
				priority: null,
			},
			worktree,
			session: sessionLookup(issueId),
			pr,
			project: {
				projectTitle: "Orphaned Worktrees",
				projectUrl: "",
				projectNumber: 0,
				status: "Orphaned",
				statusColor: "gray",
				statusOrder: 9999,
			},
			orphan: true,
		});
	}
	return orphans;
}

/**
 * Top-level loader: enriches each assigned issue with its worktree and
 * session snapshot. Designed to be called on dashboard mount and on every
 * `r` refresh — cheap because all the per-worktree probes are local.
 */
export async function loadDashboard(
	repoRoot: string,
	opts?: LoadOptions,
): Promise<DashboardIssue[] | null> {
	const provider = createProvider(repoRoot);
	const issues = await provider.listAssignedIssues(opts);
	if (!issues) return null;

	const worktreesByIssue = buildWorktreeIndex(repoRoot);
	const metadata = readMetadata(repoRoot);
	const projectCfg = metadata.project ?? {};
	const configuredUrl = projectCfg.url ?? null;

	// Fetch PRs in parallel for branches that actually have a worktree —
	// issues without one wouldn't have a branch on this user's repo, so we
	// skip the per-issue gh call for them. Detached worktrees (branch=null)
	// have no PR by definition.
	const prByBranch = new Map<string, PrInfo>();
	const prFetches = Array.from(worktreesByIssue.values())
		.filter((w): w is WorktreeInfo & { branch: string } => w.branch !== null)
		.map(async (w) => {
			const pr = await fetchPrForBranch(w.branch);
			if (pr) prByBranch.set(w.branch, pr);
		});

	// Project membership comes from the provider in a single call; fetch it
	// alongside the per-branch PR probes so neither blocks the other.
	const [, projectByIssue] = await Promise.all([
		Promise.all(prFetches),
		provider.fetchProjectAssignments(opts),
	]);

	// Provider signals total failure (vs no projects configured) with null —
	// treat as a partial load failure so the caller's resilient refresh
	// keeps the last-good state instead of regressing to a flat list.
	if (projectByIssue === null) return null;

	const enriched: DashboardIssue[] = issues.map((issue) => {
		const worktreeRaw = worktreesByIssue.get(issue.id) ?? null;
		const sessionId = metadata.issues[issue.id]?.session_id;
		const worktree = worktreeRaw ? { ...worktreeRaw, sessionId } : null;
		const pr = worktree && worktree.branch ? (prByBranch.get(worktree.branch) ?? null) : null;
		return {
			issue,
			worktree,
			session: readSessionState(repoRoot, issue.id),
			pr,
			project: projectByIssue.get(issue.id) ?? null,
		};
	});

	const assignedIds = new Set(issues.map((i) => i.id));
	const orphans = buildOrphanRows(
		worktreesByIssue,
		assignedIds,
		(id) => readSessionState(repoRoot, id),
		prByBranch,
		(id) => metadata.issues[id]?.session_id,
	);

	return sortGroupedIssues([...enriched, ...orphans], configuredUrl);
}

/**
 * Shared types and the IssueProvider interface implemented by the
 * github/linear providers. Keeping these in one file lets the dashboard and
 * worktree commands talk to issues abstractly while each provider owns its
 * own transport details.
 *
 * `IssueId` is a string in both providers — for GitHub it's the issue number
 * stringified ("100"); for Linear it's the team-prefixed identifier
 * ("FE-123"). The branch convention encodes this same string verbatim, so
 * worktree dir names round-trip through the IssueId without re-parsing.
 */

export type IssueId = string;

/**
 * Options shared by the read methods of IssueProvider. `forceRefresh` tells a
 * provider that keeps a snapshot cache (Linear) to bypass it and re-fetch from
 * the source. The dashboard sets it for the manual `r` refresh so a change made
 * seconds ago (e.g. an issue just assigned to the user) shows up immediately,
 * instead of waiting out the cache TTL. Providers without a cache (GitHub)
 * ignore it.
 */
export type LoadOptions = {
	forceRefresh?: boolean;
};

/**
 * A workflow issue normalised across providers. Shape mirrors what the GH
 * `gh issue list --json` payload exposes minus the GH-specific `number`
 * field, which is replaced by the universal `id` string.
 */
export type ProviderIssue = {
	id: IssueId;
	title: string;
	state: string;
	url: string;
	labels: { name: string }[];
	body: string;
	createdAt: string;
	updatedAt: string;
	// Linear's native priority on the 0-4 scale (0=none, 1=urgent … 4=low).
	// GitHub has no native priority, so its provider yields null. See
	// lib/priority.ts for the glyph/sort mapping.
	priority: number | null;
	// Linear's suggested git branch name (the issue's `branchName`/gitBranchName,
	// e.g. "jdoe/fe-68-landing-page"). Present only for the Linear
	// provider; when set, the worktree-create flow uses it verbatim instead of
	// synthesising a `<type>/<issue>-<desc>` branch. GitHub leaves it undefined.
	branchName?: string;
};

/**
 * The issue's membership on a project board (GitHub Projects v2 / Linear
 * team), used to group the dashboard list. `status` is the workflow
 * state's display name (null when the issue is on the board but no state is
 * set). `statusOrder` gives the column index so the dashboard can order
 * sub-groups the same way the board does. `statusColor` is an Ink-renderable
 * colour string — a 16-colour name for GitHub's enum, or a #rrggbb hex for
 * Linear states.
 */
export type IssueProjectInfo = {
	projectTitle: string;
	projectUrl: string;
	projectNumber: number;
	status: string | null;
	statusColor: string;
	statusOrder: number;
};

/**
 * Result of transitionIssueToInProgress. Discriminated so the caller can
 * render a precise status message without inventing one. Provider-agnostic:
 * the github and linear implementations both yield these shapes.
 */
export type TransitionResult =
	| {
			kind: "transitioned";
			projectTitle: string;
			from: string | null;
			to: string;
	  }
	| { kind: "noop-already"; projectTitle: string }
	| { kind: "noop-protected"; projectTitle: string; current: string }
	| { kind: "skip-no-repo" }
	| { kind: "skip-no-issue" }
	| { kind: "skip-no-project" }
	| { kind: "skip-ambiguous"; projects: string[] }
	| { kind: "skip-no-status-field"; projects: string[] }
	| { kind: "skip-no-in-progress-option"; projects: string[] }
	| { kind: "error"; message: string; hint?: string };

export interface IssueProvider {
	readonly kind: "github" | "linear";

	/**
	 * Lists open issues assigned to the current user, scoped to whatever the
	 * provider considers the active context (GH: the current repo on origin;
	 * Linear: the configured workspace/teams). Returns null on transient
	 * failure (auth, network) — the dashboard renders an error hint.
	 */
	listAssignedIssues(opts?: LoadOptions): Promise<ProviderIssue[] | null>;

	/**
	 * Returns project/board membership for the assigned issues (same scope as
	 * listAssignedIssues — typically a single round-trip). The dashboard uses
	 * this to group rows by project → status.
	 *
	 * Return shapes:
	 *   - non-empty map: the lookup succeeded and found project membership
	 *   - empty map: the lookup succeeded but no issue is on any project
	 *   - null: the lookup failed for ALL projects (transient API error,
	 *     auth missing). Distinct from empty so the dashboard can treat
	 *     null as a partial load failure and keep its last-good state.
	 */
	fetchProjectAssignments(opts?: LoadOptions): Promise<Map<IssueId, IssueProjectInfo> | null>;

	/**
	 * Moves the issue to its project's "In Progress" workflow state. Idempotent
	 * by design (returns noop-already when already there) and conservative on
	 * later stages (returns noop-protected when the issue is past In Progress,
	 * e.g. "In Review" / "Done").
	 */
	transitionIssueToInProgress(issueId: IssueId): Promise<TransitionResult>;
}

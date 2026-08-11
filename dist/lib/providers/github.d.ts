/**
 * GithubProvider — implements IssueProvider against GitHub Issues + Projects
 * v2 via the `gh` CLI. All the GraphQL plumbing that previously lived in
 * dashboard.ts (project assignment lookup) and githubProject.ts (status
 * transition) is consolidated here so the rest of mintree can talk to issues
 * through a stable, provider-agnostic interface.
 *
 * Stays gh-CLI-driven (not raw octokit) because gh transparently handles
 * auth tokens, scope refresh, and the user's preferred login — mintree's
 * doctor already validates that flow, and not having a second auth path
 * means there's only one thing to break.
 */
import type { IssueId, IssueProjectInfo, IssueProvider, ProviderIssue, TransitionResult } from "./types.js";
export declare class GithubProvider implements IssueProvider {
    private readonly repoRoot;
    readonly kind: "github";
    constructor(repoRoot: string);
    private readProjectConfig;
    listAssignedIssues(): Promise<ProviderIssue[] | null>;
    fetchProjectAssignments(): Promise<Map<IssueId, IssueProjectInfo> | null>;
    transitionIssueToInProgress(issueId: IssueId): Promise<TransitionResult>;
}
/**
 * Returns the gh CLI token scopes for github.com, or null when `gh` can't be
 * called / the user isn't authenticated. `gh auth status` writes the scopes
 * line to stderr; we capture both streams and grep for it.
 *
 * Kept as a standalone export (not part of IssueProvider) because it's
 * consumed by doctor for the Project v2 scope row — a doctor-side concern,
 * not part of the runtime issue flow.
 */
export declare function getGhTokenScopes(): Promise<string[] | null>;
export declare function hasProjectScope(scopes: string[]): boolean;

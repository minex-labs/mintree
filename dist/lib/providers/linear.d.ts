/**
 * LinearProvider — implements IssueProvider against Linear's GraphQL API
 * (https://api.linear.app/graphql).
 *
 * One POST per dashboard refresh: a single GraphQL query pulls viewer +
 * teams (with states) + assigned issues in one shot. Transitions add a
 * second call for the `issueUpdate` mutation.
 *
 * Auth resolution order: `LINEAR_API_KEY` env var → `~/.mintree/
 * credentials.json` (`{ linear: { apiKey: "..." } }`). Never reads or
 * writes credentials to the repo's `.mintree/` directory — personal API
 * keys are user-scoped, not repo-scoped.
 *
 * Linear personal API keys (`lin_api_...`) go directly into the
 * Authorization header with no `Bearer` prefix.
 */
import type { IssueId, IssueProjectInfo, IssueProvider, LoadOptions, ProviderIssue, TransitionResult } from "./types.js";
type RawLinearIssue = {
    id: string;
    identifier: string;
    title: string;
    description?: string;
    url: string;
    branchName?: string;
    priority?: number;
    createdAt?: string;
    updatedAt?: string;
    team?: {
        id?: string;
        key?: string;
        name?: string;
    };
    state?: {
        id?: string;
        name?: string;
        color?: string;
        type?: string;
        position?: number;
    };
    labels?: {
        nodes?: Array<{
            name?: string;
        }>;
    };
    project?: {
        id?: string;
        name?: string;
    } | null;
    inverseRelations?: {
        nodes?: RawLinearRelation[];
    };
};
type RawLinearRelationEnd = {
    identifier?: string;
    title?: string;
    state?: {
        name?: string;
        type?: string;
    };
};
type RawLinearRelation = {
    type?: string;
    issue?: RawLinearRelationEnd | null;
    relatedIssue?: RawLinearRelationEnd | null;
};
/**
 * Returns the identifiers of the issues that currently block `wi`.
 *
 * A blocker only counts while it is still open: once it reaches a protected
 * state type (completed/canceled/duplicate) the work it gated is unblocked, so
 * the issue is workable again. A blocker whose state we couldn't read is
 * treated as open — hiding a workable ticket is worse than showing a blocked
 * one, but a missing state is far more likely to mean "still open" than "done".
 *
 * Linear stores A-blocks-B once, on A, and B reads it via `inverseRelations`.
 * Which end of the relation carries the blocker isn't worth relying on (the API
 * has swapped the perspective of `issue`/`relatedIssue` between the two
 * directions), so we take whichever end isn't the issue itself.
 */
export declare function blockersOf(wi: RawLinearIssue, protectedTypes: Set<string>): string[];
export declare class LinearProvider implements IssueProvider {
    private readonly repoRoot;
    readonly kind: "linear";
    private snapshotPromise;
    constructor(repoRoot: string);
    private getConfig;
    /**
     * Single source of truth for the dashboard's data. Both listAssignedIssues
     * and fetchProjectAssignments call this so we never double-fetch within a
     * load. Per-instance promise memoisation handles the back-to-back call;
     * the module-level cache handles refreshes within the TTL.
     *
     * `forceRefresh` skips the module-level cache read so the live GraphQL query
     * runs again (it still writes the result back to the cache). The per-instance
     * promise is kept either way, so the two callers within one load share the
     * single forced fetch instead of issuing two.
     */
    private loadSnapshot;
    listAssignedIssues(opts?: LoadOptions): Promise<ProviderIssue[] | null>;
    fetchProjectAssignments(opts?: LoadOptions): Promise<Map<IssueId, IssueProjectInfo> | null>;
    transitionIssueToInProgress(issueId: IssueId): Promise<TransitionResult>;
}
/**
 * Doctor-side snapshot of the Linear integration's health. Bundles API-key
 * resolution, `viewer` ping, and per-configured-team existence check into
 * one async call so the doctor row can render everything in one pass.
 */
export type LinearSetupCheck = {
    configured: boolean;
    hasApiKey: boolean;
    authOk: boolean;
    user?: string;
    workspaceSlug?: string;
    apiUrl?: string;
    teams: Array<{
        key: string;
        name?: string;
        ok: boolean;
        error?: string;
    }>;
    hint?: string;
};
export declare function checkLinearSetup(repoRoot: string): Promise<LinearSetupCheck>;
export {};

import { type PermissionMode } from "./claude.js";
export type IssueMeta = {
    base_branch?: string;
    session_id?: string;
    init_failed?: boolean;
};
export type LinkFileMode = "copy" | "link";
export type LinkFileEntry = {
    path: string;
    mode: LinkFileMode;
};
export type ProjectMeta = {
    url?: string;
    statusField?: string;
    inProgressOption?: string;
    protectedStatuses?: string[];
};
export type ProviderKind = "github" | "linear";
export type LinearTeamRef = {
    key: string;
    name?: string;
};
export type LinearMeta = {
    apiUrl?: string;
    workspaceSlug: string;
    teams: LinearTeamRef[];
    inProgressStateName?: string;
    protectedStateTypes?: string[];
};
export type Metadata = {
    version: 1;
    provider?: ProviderKind;
    issues: Record<string, IssueMeta>;
    project?: ProjectMeta;
    linear?: LinearMeta;
    defaultPermissionMode?: PermissionMode;
    promptTemplate?: string;
    orchestratorPromptTemplate?: string;
    linkFiles?: LinkFileEntry[];
};
export declare function readMetadata(repoRoot: string): Metadata;
export declare function writeMetadata(repoRoot: string, data: Metadata): void;
/**
 * Merges `partial` into the metadata entry for `issueId`, creating the entry
 * if missing. Persists the result. Existing fields not present in `partial`
 * are preserved.
 */
export declare function upsertIssue(repoRoot: string, issueId: string, partial: IssueMeta): Metadata;
/**
 * Removes the metadata entry for `issueId` entirely (session_id included) and
 * persists the result. No-op — and no rewrite — when there's no such entry, so
 * callers can invoke it unconditionally. Returns true when an entry was
 * actually removed. Used by `worktree clean`, where the worktree's PR is
 * merged/closed and the issue is done, so keeping the entry (and its stale
 * session_id) around would only let it accumulate forever.
 */
export declare function removeIssue(repoRoot: string, issueId: string): boolean;
/**
 * Records whether this issue's worktree finished its post-create `init.sh`.
 * Writes the flag on failure and REMOVES it on success, so the mere presence of
 * `init_failed` means "this worktree is not initialised" — callers can test the
 * key without having to distinguish false from absent. No-op when clearing an
 * entry that was already clean, to avoid rewriting metadata on every create.
 */
export declare function setInitFailed(repoRoot: string, issueId: string, failed: boolean): void;
export declare function getSessionId(repoRoot: string, issueId: string): string | undefined;
export declare function setSessionId(repoRoot: string, issueId: string, sessionId: string): void;

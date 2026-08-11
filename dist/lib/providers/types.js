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
export {};

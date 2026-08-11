/**
 * Branch convention enforced by mintree:
 *
 *     <type>/<issue>-<kebab-desc>
 *
 * `<type>` is one of the 11 conventional prefixes; `<issue>` is either a
 * bare digit run (GitHub issue number — "100") or a team-prefixed Linear
 * identifier ("FE-100"); `<desc>` is lower-case kebab-case.
 *
 * The Linear team key is normalized to upper-case: `feat/be-256-x` is
 * accepted and rewritten to `feat/BE-256-x` (issueId "BE-256"). Linear's
 * canonical identifier is always upper-case, so this just rescues a branch
 * a human (or a target-repo skill) typed in the wrong case.
 *
 * Examples that PARSE: feat/100-readme-update, fix/55-upload-timeout,
 *                      feat/BACK-100-readme-update, fix/WEB-7-modal,
 *                      feat/back-100-x (normalized to feat/BACK-100-x)
 * Examples that REJECT: feat/abc-foo, /100-foo, gh-100-foo, feat/100,
 *                       feat/100-FooBar, Feat/BE-1-x (upper-case type)
 */
export declare const ALLOWED_TYPES: readonly ["feat", "fix", "docs", "chore", "refactor", "test", "build", "ci", "perf", "style", "revert"];
export type BranchType = (typeof ALLOWED_TYPES)[number];
export type ParsedBranch = {
    branch: string;
    issueId: string;
    worktreeDirName: string;
    type?: BranchType;
    desc?: string;
};
export type ParseError = {
    error: string;
    hint: string;
};
export declare function parseBranch(branch: string): ParsedBranch | ParseError;
export declare function isParseError(result: ParsedBranch | ParseError): result is ParseError;
/**
 * Extracts the issue id (`100`, `FE-123`) from a worktree directory *name*
 * (not a path — pass `path.basename(dir)`). Returns null when the name doesn't
 * start with a recognisable issue id (e.g. a detached-HEAD "current branch"
 * worktree). Used to locate the metadata entry to prune on `worktree clean`.
 */
export declare function issueIdFromWorktreeDirName(dirName: string): string | null;
/**
 * Pulls the Linear issue identifier (`<TEAM>-<n>`) out of a Linear-style
 * branch name. Linear's `branchName` looks like `<user>/<team>-<n>-<slug>`
 * (or just `<team>-<n>-<slug>` when the workspace has no user prefix), with
 * the identifier lower-cased. We locate `<team>-<digits>` as a delimited token
 * and return it upper-cased so it matches the canonical issue id everywhere
 * else in mintree.
 *
 * `teamKeys` narrows the search to the repo's configured teams (the robust
 * path); when empty — a mis-configured repo — we fall back to the first
 * `<letters>-<digits>` token, which is still correct for the common single-
 * identifier branch shape.
 */
export declare function extractLinearIssueId(branch: string, teamKeys: string[]): string | null;
/**
 * Resolves a Linear `branchName` into a ParsedBranch. The branch is kept
 * verbatim (only trimmed) — git refs are case-sensitive and Linear's value is
 * the exact ref GitHub/Linear will link against, so we must not rewrite it.
 * Only the extracted `issueId` is normalised to upper-case. The worktree dir
 * is the bare issue id (`FE-68`), matching the convention path and the
 * dir-name recovery regexes elsewhere.
 */
export declare function parseLinearBranch(rawBranch: string, teamKeys: string[]): ParsedBranch | ParseError;

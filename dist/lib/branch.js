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
export const ALLOWED_TYPES = [
    "feat",
    "fix",
    "docs",
    "chore",
    "refactor",
    "test",
    "build",
    "ci",
    "perf",
    "style",
    "revert",
];
// `<type>/<issueId>-<desc>` where issueId is either `\d+` (GitHub) or
// `<TEAM_PREFIX>-\d+` (Linear). The TEAM_PREFIX is letters/digits/underscores
// starting with a letter, mirroring Linear's team-key constraints. Both cases
// are accepted here and the captured team key is upper-cased on the way out
// (see `parseBranch`), so the worktree dir name and the created branch stay
// canonical regardless of how the caller typed it.
const BRANCH_REGEX = /^([a-z]+)\/((?:[A-Za-z][A-Za-z0-9_]*-)?\d+)-([a-z0-9][a-z0-9-]*)$/;
export function parseBranch(branch) {
    const match = BRANCH_REGEX.exec(branch);
    if (!match) {
        return {
            error: `Invalid branch name: ${branch}`,
            hint: "Expected `<type>/<issue>-<kebab-desc>`. Examples: feat/100-claude-md-inicial, feat/BACK-100-claude-md-inicial",
        };
    }
    const [, type, rawIssueId, desc] = match;
    if (!type || !rawIssueId || !desc) {
        return {
            error: `Invalid branch name: ${branch}`,
            hint: "Expected `<type>/<issue>-<kebab-desc>`. Examples: feat/100-claude-md-inicial, feat/BACK-100-claude-md-inicial",
        };
    }
    if (!ALLOWED_TYPES.includes(type)) {
        return {
            error: `Unknown branch type \`${type}\``,
            hint: `Allowed types: ${ALLOWED_TYPES.join(", ")}`,
        };
    }
    // Normalize the Linear team key to upper-case. `toUpperCase()` is a no-op
    // for a bare-digit GitHub id ("256") and only touches the team prefix of a
    // Linear id ("be-256" → "BE-256"). The returned `branch` is rebuilt from
    // the normalized id so callers create/look up the canonical branch name.
    const issueId = rawIssueId.toUpperCase();
    const normalizedBranch = `${type}/${issueId}-${desc}`;
    return {
        branch: normalizedBranch,
        type: type,
        issueId,
        desc,
        // Worktree dir is the bare issue id (e.g. "100" or "FE-123"). The desc
        // only seeds the branch name, not the directory.
        worktreeDirName: issueId,
    };
}
export function isParseError(result) {
    return "error" in result;
}
// Recovers the issue id from a worktree directory name. The dir name is the
// bare issue id (`100`, `FE-123`); the trailing `-` clause keeps matching the
// legacy `<id>-<desc>` worktrees still on disk. Mirrors the issueId capture of
// BRANCH_REGEX. Sole source of truth — `buildWorktreeIndex` (dashboard.ts) and
// the remove/clean flows all go through `issueIdFromWorktreeDirName`.
const WORKTREE_DIRNAME_REGEX = /^((?:[A-Z][A-Z0-9_]*-)?\d+)(?:-|$)/;
/**
 * Extracts the issue id (`100`, `FE-123`) from a worktree directory *name*
 * (not a path — pass `path.basename(dir)`). Returns null when the name doesn't
 * start with a recognisable issue id (e.g. a detached-HEAD "current branch"
 * worktree). Used to locate the metadata entry to prune on `worktree clean`.
 */
export function issueIdFromWorktreeDirName(dirName) {
    const m = dirName.match(WORKTREE_DIRNAME_REGEX);
    return m && m[1] ? m[1] : null;
}
// Chars that make a string an invalid (or risky) git ref. Linear's
// `branchName` never contains these, but this entry point is also reachable
// from the CLI (`mintree worktree create <branch>`), so junk input is rejected
// rather than handed to `git worktree add`.
const GIT_REF_INVALID = /[\s~^:?*[\]\\]/;
function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
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
export function extractLinearIssueId(branch, teamKeys) {
    const keys = teamKeys.filter((k) => k.length > 0);
    // The identifier must sit on a token boundary (start, or after `/ _ -`) and
    // be followed by one (end, or before `/ _ -`) so we don't match a team key
    // buried inside a slug word.
    const keyAlt = keys.length > 0 ? keys.map(escapeRegex).join("|") : "[A-Za-z][A-Za-z0-9_]*";
    const re = new RegExp(`(?:^|[/_-])(${keyAlt})-(\\d+)(?=$|[/_-])`, "i");
    const m = re.exec(branch);
    if (!m || !m[1] || !m[2])
        return null;
    return `${m[1].toUpperCase()}-${m[2]}`;
}
/**
 * Resolves a Linear `branchName` into a ParsedBranch. The branch is kept
 * verbatim (only trimmed) — git refs are case-sensitive and Linear's value is
 * the exact ref GitHub/Linear will link against, so we must not rewrite it.
 * Only the extracted `issueId` is normalised to upper-case. The worktree dir
 * is the bare issue id (`FE-68`), matching the convention path and the
 * dir-name recovery regexes elsewhere.
 */
export function parseLinearBranch(rawBranch, teamKeys) {
    const branch = rawBranch.trim();
    if (!branch) {
        return {
            error: "Empty branch name",
            hint: "Linear should provide a `branchName` like `jdoe/fe-68-landing-page`.",
        };
    }
    if (GIT_REF_INVALID.test(branch) || branch.startsWith("/") || branch.endsWith("/")) {
        return {
            error: `Invalid branch name: ${rawBranch}`,
            hint: "A Linear branch must be a valid git ref (no spaces or ~^:?*[]\\).",
        };
    }
    const issueId = extractLinearIssueId(branch, teamKeys);
    if (!issueId) {
        const hint = teamKeys.length > 0
            ? `Expected a Linear identifier for one of: ${teamKeys.join(", ")} (e.g. ${teamKeys[0]}-123). Got \`${branch}\`.`
            : `Expected a Linear identifier like \`team-123\` somewhere in the branch. Got \`${branch}\`.`;
        return { error: `Could not find a Linear issue id in branch \`${branch}\``, hint };
    }
    return {
        branch,
        issueId,
        worktreeDirName: issueId,
    };
}
/**
 * True when the branch name IS the issue identifier and nothing else
 * (`VAL-920`, `val-920`) — no `<type>/` prefix, no description, no user
 * namespace.
 *
 * Why this matters: Linear auto-transitions an issue to Done when a branch
 * *named after it* merges, independently of the PR body's magic words. A
 * branch called `VAL-920` therefore closes VAL-920 on merge even when the PR
 * only says "Part of". Both branch shapes mintree documents
 * (`<type>/<issue>-<desc>` and Linear's own `<user>/<team>-<n>-<slug>`)
 * carry the identifier *inside* a longer name and are unaffected — only the
 * bare form is.
 *
 * The test is an equality against the already-parsed identifier, not a fresh
 * regex: the caller has, by construction, resolved `issueId` against the
 * repo's configured Linear team keys, so this can't fire on a branch like
 * `release_mt-2` or `integration-1` that merely looks id-shaped.
 */
export function isBareIssueIdBranch(parsed) {
    if (parsed.type)
        return false;
    return parsed.branch.toUpperCase() === parsed.issueId.toUpperCase();
}

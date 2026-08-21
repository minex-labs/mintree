import { type ParsedBranch } from "./branch.js";
import { type BranchNameLookup } from "./providers/linear.js";
import type { PermissionMode } from "./claude.js";
export type CreateStepKind = "ok" | "skip" | "warn" | "error";
export type CreateStep = {
    kind: CreateStepKind;
    label: string;
    detail?: string;
};
/**
 * Optional progress callbacks used by the dashboard overlay to render a
 * live setup log (santree-style). `onPending(label)` highlights the
 * currently running blocking operation (rendered with a spinner); call
 * `onPending(null)` when it ends. `onStep(step)` appends a completed step
 * to the log. Between every emission the implementation yields the event
 * loop for one frame so Ink can paint before the next blocking section.
 */
export type ProgressCallbacks = {
    onStep?: (step: CreateStep) => void;
    onPending?: (label: string | null) => void;
};
export type CreateOpts = {
    base?: string;
    work: boolean;
    exact?: boolean;
    prompt?: string;
    permissionMode?: PermissionMode;
    progress?: ProgressCallbacks;
};
/**
 * Set when the branch argument was the bare Linear issue identifier
 * (`VAL-920`) — the shape that makes Linear close the issue on merge. Present
 * whether the name was corrected or kept, so the caller can report both
 * outcomes; `resolvedTo` distinguishes them.
 */
export type BareIssueBranchInfo = {
    requested: string;
    resolvedTo?: string;
    reason?: string;
};
export type CreateResult = {
    ok: true;
    steps: CreateStep[];
    worktreePath: string;
    branch: string;
    issueId: string;
    base?: string;
    work: boolean;
    initFailed: boolean;
    initError?: string;
    promptFile?: string;
    permissionMode?: PermissionMode;
    bareIssueBranch?: BareIssueBranchInfo;
} | {
    ok: false;
    message: string;
    hint?: string;
};
/**
 * Stashes a `--prompt` value into a temp file so the shell wrapper can hand
 * it back to `worktree work` via `--prompt-file`. Plain stdout markers can't
 * carry multi-line / shell-special text safely, hence the file.
 */
export declare function writePromptFile(prompt: string): string;
/**
 * The whole `worktree create` flow as a pure function — same code path used
 * by the CLI command and by the dashboard's `w` overlay. Validates input,
 * resolves a base branch, runs `git worktree add`, persists metadata, runs
 * the optional `.mintree/init.sh`, and stages the --prompt to a temp file
 * for the work hand-off when relevant.
 *
 * Async only because progress callbacks need event-loop yields between
 * blocking sections; without them the dashboard overlay would freeze.
 */
/**
 * The bare-issue-id guard.
 *
 * Linear transitions an issue to Done when a branch *named after it* merges —
 * independently of the PR body, so `Part of VAL-924` in the description does
 * not hold it back. That makes `mintree worktree create VAL-920` (the form
 * everyone reaches for, because the identifier is what you have in hand when
 * you pick up a ticket) create a branch that silently closes its ticket on
 * merge, possibly with half the ticket's scope unshipped.
 *
 * Neither documented branch shape is affected: `<type>/<issue>-<desc>` and
 * Linear's own `<user>/<team>-<n>-<slug>` both bury the identifier inside a
 * longer name, so `isBareIssueIdBranch` is false and this returns the parse
 * untouched, with no step, no network call and no output.
 *
 * When it does fire we prefer to *correct* rather than to nag: Linear knows
 * the canonical branch name for the identifier, so we ask for it and build
 * that branch instead. The lookup needs an API key and one ~250ms round-trip;
 * when either is missing we keep the branch as typed and warn — never block,
 * since a branch named after an issue is a legitimate (if rare) thing to want,
 * and `--exact` says so explicitly.
 *
 * `lookup` is injected for tests; production always uses the real provider.
 */
export declare function resolveBareIssueBranch(args: {
    repoRoot: string;
    parsed: ParsedBranch;
    teamKeys: string[];
    exact: boolean;
    lookup?: (repoRoot: string, issueId: string) => Promise<BranchNameLookup>;
}): Promise<{
    parsed: ParsedBranch;
    info?: BareIssueBranchInfo;
    step?: CreateStep;
}>;
export declare function runCreate(branchArg: string, opts: CreateOpts): Promise<CreateResult>;
export type CreateDetachedOpts = {
    issueId: string;
    descKebab: string;
    work: boolean;
    prompt?: string;
    permissionMode?: PermissionMode;
    progress?: ProgressCallbacks;
};
/**
 * Variant of `runCreate` that doesn't create a new branch — the worktree is
 * checked out in detached HEAD at the tip of the main repo's current branch.
 * Used by the dashboard's "current branch" overlay mode: lets the user spin
 * up a worktree off whatever they're on (typically `main`) without forcing
 * the `<type>/<issue>-<desc>` convention upfront. They can `git switch -c`
 * later if/when the work warrants a branch.
 *
 * Worktree dir naming follows the same bare-issueId shape as the
 * branch-based flow so `worktree work` can still recover the issueId from
 * the dir name (where it can't read it from the branch).
 */
export declare function runCreateDetached(opts: CreateDetachedOpts): Promise<CreateResult>;

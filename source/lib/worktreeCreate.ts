import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";

import {
	parseBranch,
	parseLinearBranch,
	isBareIssueIdBranch,
	isParseError,
	type ParsedBranch,
	type ParseError,
} from "./branch.js";
import {
	findMainRepoRoot,
	getMintreeDir,
	getWorktreesDir,
	getInitScriptPath,
	getDefaultBranch,
	getCurrentBranch,
	branchExists,
	remoteBranchExists,
	fetchRemote,
	worktreeForBranch,
	addWorktree,
	pathExists,
	isExecutable,
} from "./git.js";
import { readMetadata, upsertIssue, setInitFailed, type LinkFileEntry } from "./metadata.js";
import { fetchIssueBranchName, type BranchNameLookup } from "./providers/linear.js";
import type { PermissionMode } from "./claude.js";

/**
 * Resolves the branch arg into a ParsedBranch, choosing the parser by
 * provider. The convention parser (`<type>/<issue>-<desc>`) is tried first for
 * every provider — a Linear repo can still use convention branches. When that
 * fails AND the repo is on the Linear provider, we fall back to parsing the
 * arg as a Linear `branchName` (`<user>/<team>-<n>-<slug>`), keyed off the
 * configured team keys. GitHub repos never reach the Linear branch, so their
 * behaviour is unchanged.
 */
function resolveCreateBranch(repoRoot: string, branchArg: string): ParsedBranch | ParseError {
	const conv = parseBranch(branchArg);
	if (!isParseError(conv)) return conv;

	const meta = readMetadata(repoRoot);
	if (meta.provider === "linear" && meta.linear) {
		const teamKeys = meta.linear.teams.map((t) => t.key);
		const linear = parseLinearBranch(branchArg, teamKeys);
		// On a Linear repo the Linear-branch error is the more useful one to
		// surface, so return it whether it parsed or not.
		return linear;
	}
	return conv;
}

// "error" is distinct from "warn": a warn is something the create survived
// (no remote to fetch, an ignored flag), an error is a step that failed and
// left the worktree in a state the user must act on before working in it.
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
	// Escape hatch for the bare-issue-id guard: create the branch exactly as
	// typed, without asking Linear for the issue's canonical branch name. The
	// guard corrects a name the caller almost never meant to ask for; `exact`
	// is how you say you did mean it.
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
	// The identifier exactly as the caller typed it.
	requested: string;
	// Linear's canonical branch name, when the lookup resolved it. Absent when
	// the bare name was kept.
	resolvedTo?: string;
	// Why the bare name was kept (lookup unavailable, or `--exact`). Absent
	// when the name was corrected.
	reason?: string;
};

export type CreateResult =
	| {
			ok: true;
			steps: CreateStep[];
			worktreePath: string;
			branch: string;
			issueId: string;
			base?: string;
			// EFFECTIVE work, not the requested one: false when --work was asked
			// for but the init hook failed. Callers drive the Claude hand-off off
			// this, so a worktree that never got initialised is never handed to an
			// agent. Check `initFailed` to tell the two falses apart.
			work: boolean;
			// The post-create hook ran and failed. The worktree exists and is
			// usable, but is NOT initialised — whatever isolation init.sh was
			// responsible for is absent.
			initFailed: boolean;
			initError?: string;
			promptFile?: string;
			permissionMode?: PermissionMode;
			// See BareIssueBranchInfo. Undefined for every branch shape mintree
			// documents — only a bare identifier populates it.
			bareIssueBranch?: BareIssueBranchInfo;
	  }
	| { ok: false; message: string; hint?: string };

// How much of the hook's own output to carry into the failure detail. Enough
// to identify the failure without letting a chatty script flood the step list.
const INIT_ERROR_MAX_LINES = 3;
const INIT_ERROR_MAX_CHARS = 300;

/**
 * Turns an execSync failure into something the user can act on. `err.message`
 * is only "Command failed: <path>" — the hook's own diagnostics go to the piped
 * stderr, which the default message drops exactly when it matters most. Prefers
 * stderr, falls back to stdout for scripts that report on stdout, and always
 * states the exit status so a silent non-zero exit is still legible.
 */
function describeInitFailure(err: unknown): string {
	const e = err as { status?: number | null; stderr?: Buffer | string; stdout?: Buffer | string };
	const asText = (v: Buffer | string | undefined): string =>
		typeof v === "string" ? v.trim() : v ? v.toString("utf-8").trim() : "";
	const status = typeof e?.status === "number" ? `exit ${e.status}` : "did not exit cleanly";
	const output = asText(e?.stderr) || asText(e?.stdout);
	if (!output) return status;
	let tail = output.split("\n").slice(-INIT_ERROR_MAX_LINES).join(" · ");
	if (tail.length > INIT_ERROR_MAX_CHARS) tail = `${tail.slice(0, INIT_ERROR_MAX_CHARS)}…`;
	return `${status}: ${tail}`;
}

function tryRunInitScript(
	scriptPath: string,
	worktreePath: string,
	repoRoot: string,
): { ran: boolean; error?: string } {
	if (!pathExists(scriptPath)) return { ran: false };
	if (!isExecutable(scriptPath)) {
		return { ran: false, error: `init.sh exists but is not executable (chmod +x ${scriptPath})` };
	}
	try {
		execSync(scriptPath, {
			cwd: worktreePath,
			env: { ...process.env, MINTREE_WORKTREE_PATH: worktreePath, MINTREE_REPO_ROOT: repoRoot },
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { ran: true };
	} catch (err) {
		return { ran: false, error: describeInitFailure(err) };
	}
}

/**
 * Materialises each `metadata.linkFiles` entry from the main repo into the
 * freshly created worktree. Git worktrees don't share untracked files, so
 * gitignored config like `.env.local` is absent in a new worktree; this brings
 * it in so the worktree's tooling finds the same secrets/config as the main
 * checkout.
 *
 * Per-entry `mode` decides HOW (see `LinkFileMode`): "copy" gives the worktree
 * its own file, "link" symlinks back to the main checkout for a single source
 * of truth. Entries are repo-root-relative (already validated by
 * `sanitizeLinkFiles`). Each entry is best-effort: a missing source or an
 * already-present target is skipped, never fatal — these files are convenience,
 * and a repo whose isolation depends on one should generate it in `init.sh`,
 * whose failure IS fatal to the hand-off.
 */
function materializeLinkFiles(
	repoRoot: string,
	worktreePath: string,
	linkFiles: LinkFileEntry[],
	pushStep: (step: CreateStep) => void,
): void {
	for (const { path: rel, mode } of linkFiles) {
		const verb = mode === "link" ? "link" : "copy";
		const source = path.join(repoRoot, rel);
		const target = path.join(worktreePath, rel);
		if (!pathExists(source)) {
			pushStep({
				kind: "skip",
				label: `skipped ${verb} ${rel}`,
				detail: "not present in repo root",
			});
			continue;
		}
		// lstat (not pathExists) so an existing symlink/file/dir already at the
		// target — e.g. a tracked file git checked out — counts as present and
		// we don't clobber it.
		let targetTaken = false;
		try {
			fs.lstatSync(target);
			targetTaken = true;
		} catch {
			targetTaken = false;
		}
		if (targetTaken) {
			pushStep({
				kind: "skip",
				label: `skipped ${verb} ${rel}`,
				detail: "already present in worktree",
			});
			continue;
		}
		try {
			fs.mkdirSync(path.dirname(target), { recursive: true });
			if (mode === "link") {
				// Relative so the link survives the whole tree being moved or
				// mounted at a different path (containers, network shares).
				fs.symlinkSync(path.relative(path.dirname(target), source), target);
				pushStep({ kind: "ok", label: `linked ${rel}`, detail: `→ ${source}` });
			} else {
				fs.copyFileSync(source, target);
				pushStep({ kind: "ok", label: `copied ${rel}`, detail: `from ${source}` });
			}
		} catch (err) {
			pushStep({
				kind: "warn",
				label: `failed to ${verb} ${rel}`,
				detail: err instanceof Error ? err.message : String(err),
			});
		}
	}
}

/**
 * The shared tail of both create flows: bring in `linkFiles`, run the
 * post-create hook, and record the outcome in metadata. Kept in one place
 * because the two entry points (`runCreate`, `runCreateDetached`) previously
 * carried byte-identical copies of it, and a fix to the failure handling that
 * lands in only one of them is exactly the bug this function prevents.
 *
 * Returns whether the hook FAILED — callers use it to withhold the Claude
 * hand-off, so an agent is never launched into an uninitialised worktree.
 */
async function bootstrapWorktree(
	root: string,
	worktreePath: string,
	issueId: string,
	pushStep: (step: CreateStep) => void,
	progress?: ProgressCallbacks,
): Promise<{ initFailed: boolean; initError?: string }> {
	// Materialise gitignored config (e.g. .env.local) before init.sh, so the
	// hook can rely on those files being present.
	const linkFiles = readMetadata(root).linkFiles;
	if (linkFiles && linkFiles.length > 0) {
		materializeLinkFiles(root, worktreePath, linkFiles, pushStep);
		await nextFrame(progress);
	}

	const initShPath = getInitScriptPath(root);
	if (pathExists(initShPath)) {
		progress?.onPending?.("Running .mintree/init.sh...");
		await nextFrame(progress);
	}
	const initResult = tryRunInitScript(initShPath, worktreePath, root);
	progress?.onPending?.(null);

	const initFailed = Boolean(initResult.error);
	if (initResult.ran) {
		pushStep({ kind: "ok", label: "ran .mintree/init.sh", detail: worktreePath });
	} else if (initResult.error) {
		pushStep({ kind: "error", label: "init.sh failed", detail: initResult.error });
	} else if (!pathExists(initShPath)) {
		pushStep({ kind: "skip", label: "no init.sh (skipping post-create hook)" });
	}
	setInitFailed(root, issueId, initFailed);
	await nextFrame(progress);

	return initFailed ? { initFailed, initError: initResult.error } : { initFailed };
}

/**
 * Stashes a `--prompt` value into a temp file so the shell wrapper can hand
 * it back to `worktree work` via `--prompt-file`. Plain stdout markers can't
 * carry multi-line / shell-special text safely, hence the file.
 */
export function writePromptFile(prompt: string): string {
	const fileName = `mintree-prompt-${process.pid}-${Date.now()}.txt`;
	const filePath = path.join(os.tmpdir(), fileName);
	fs.writeFileSync(filePath, prompt);
	return filePath;
}

// Wait one frame (~16ms) so Ink has time to commit + paint the latest
// state before the next blocking execSync. No-op when no progress
// callbacks are set — CLI invocations skip the cost entirely.
function nextFrame(progress?: ProgressCallbacks): Promise<void> {
	if (!progress || (!progress.onStep && !progress.onPending)) return Promise.resolve();
	return new Promise((resolve) => setTimeout(resolve, 16));
}

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
export async function resolveBareIssueBranch(args: {
	repoRoot: string;
	parsed: ParsedBranch;
	// The repo's configured Linear team keys. EMPTY DISABLES THE GUARD: without
	// them `parseLinearBranch` falls back to a loose `<word>-<digits>` match,
	// which hits real branch names (`release_mt-2`, `integration-1`) that have
	// nothing to do with Linear.
	teamKeys: string[];
	exact: boolean;
	lookup?: (repoRoot: string, issueId: string) => Promise<BranchNameLookup>;
}): Promise<{ parsed: ParsedBranch; info?: BareIssueBranchInfo; step?: CreateStep }> {
	const { repoRoot, parsed, teamKeys, exact } = args;
	if (teamKeys.length === 0) return { parsed };
	if (!isBareIssueIdBranch(parsed)) return { parsed };

	const requested = parsed.branch;
	const closesWarning = `\`${requested}\` will close the Linear issue when merged`;

	if (exact) {
		return {
			parsed,
			info: { requested, reason: "--exact" },
			step: {
				kind: "skip",
				label: "kept branch name verbatim",
				detail: `--exact; ${closesWarning}`,
			},
		};
	}

	const lookup = args.lookup ?? fetchIssueBranchName;
	const found = await lookup(repoRoot, parsed.issueId);

	// Not a Linear issue at all — the argument only *looked* id-shaped. Nothing
	// to correct and nothing to warn about, so stay quiet.
	if (found.kind === "not-found") return { parsed };

	if (found.kind === "resolved" && found.branchName.toUpperCase() !== requested.toUpperCase()) {
		const reparsed = parseLinearBranch(found.branchName, teamKeys);
		if (!isParseError(reparsed)) {
			return {
				parsed: reparsed,
				info: { requested, resolvedTo: reparsed.branch },
				step: {
					kind: "warn",
					label: "used Linear's branch name",
					detail: `${requested} → ${reparsed.branch}; a branch named after the issue closes it on merge`,
				},
			};
		}
	}

	const reason =
		found.kind === "unavailable"
			? found.reason
			: `Linear's own branch name for ${parsed.issueId} is ${requested}`;
	return {
		parsed,
		info: { requested, reason },
		step: {
			kind: "warn",
			label: "branch is a bare issue id",
			detail: `${closesWarning} (${reason})`,
		},
	};
}

export async function runCreate(branchArg: string, opts: CreateOpts): Promise<CreateResult> {
	const progress = opts.progress;
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

	const parsedArg = resolveCreateBranch(root, branchArg);
	if (isParseError(parsedArg)) {
		return { ok: false, message: parsedArg.error, hint: parsedArg.hint };
	}

	// Runs before the already-checked-out / dir-exists checks below so those
	// look at the branch we're actually going to create, not the one that was
	// typed. Costs nothing (no I/O, no step) unless the arg is a bare
	// identifier on a Linear repo with configured teams.
	const meta = readMetadata(root);
	const linearTeamKeys =
		meta.provider === "linear" ? (meta.linear?.teams ?? []).map((t) => t.key) : [];
	if (linearTeamKeys.length > 0 && isBareIssueIdBranch(parsedArg) && !opts.exact) {
		progress?.onPending?.("Resolving branch name from Linear...");
		await nextFrame(progress);
	}
	const guard = await resolveBareIssueBranch({
		repoRoot: root,
		parsed: parsedArg,
		teamKeys: linearTeamKeys,
		exact: opts.exact ?? false,
	});
	progress?.onPending?.(null);
	const parsed = guard.parsed;

	const existingWorktree = worktreeForBranch(root, parsed.branch);
	if (existingWorktree) {
		return {
			ok: false,
			message: `Branch ${parsed.branch} is already checked out at ${existingWorktree}`,
			hint: "Use `mintree worktree work` to resume, or `mintree worktree remove` to delete.",
		};
	}

	const worktreePath = path.join(getWorktreesDir(root), parsed.worktreeDirName);
	if (pathExists(worktreePath)) {
		return {
			ok: false,
			message: `Worktree directory already exists: ${worktreePath}`,
			hint: "Remove it first or pick a different branch description.",
		};
	}

	const steps: CreateStep[] = [];
	const pushStep = (step: CreateStep) => {
		steps.push(step);
		progress?.onStep?.(step);
	};

	pushStep({
		kind: "ok",
		label: "parsed branch",
		detail: parsed.type
			? `type=${parsed.type}, issue=${parsed.issueId}, desc=${parsed.desc}`
			: `issue=${parsed.issueId}, branch=${parsed.branch}`,
	});
	await nextFrame(progress);

	if (guard.step) {
		pushStep(guard.step);
		await nextFrame(progress);
	}

	// Fetch before resolving refs so the worktree forks from fresh code, not a
	// stale local checkout. Best-effort: offline / no-remote just warns and we
	// fall back to whatever is already local.
	progress?.onPending?.("Fetching origin...");
	await nextFrame(progress);
	const fetch = fetchRemote(root);
	progress?.onPending?.(null);
	pushStep(
		fetch.ok
			? { kind: "ok", label: "fetched origin", detail: "refs up to date" }
			: { kind: "warn", label: "skipped git fetch", detail: fetch.reason },
	);
	await nextFrame(progress);

	const existence = branchExists(root, parsed.branch);
	let base: string | undefined;
	if (existence === null) {
		base = opts.base ?? getDefaultBranch(root) ?? undefined;
		if (!base) {
			return {
				ok: false,
				message: "Could not determine a base branch (no origin/HEAD, no main/master).",
				hint: "Pass --base <branch> explicitly.",
			};
		}
		if (branchExists(root, base) === null) {
			return {
				ok: false,
				message: `Base branch \`${base}\` does not exist locally or on origin.`,
				hint: "Pick a different --base or fetch the missing branch first.",
			};
		}
	}

	// For a brand-new branch, fork from the freshly fetched `origin/<base>`
	// tip when origin has it — that's the whole point of the fetch above.
	// Without a successful fetch (or origin ref) we fork from the local base.
	let baseRef = base;
	if (existence === null && base && fetch.ok && remoteBranchExists(root, base)) {
		baseRef = `origin/${base}`;
	}

	progress?.onPending?.("Creating worktree...");
	await nextFrame(progress);
	try {
		addWorktree({ repoRoot: root, branch: parsed.branch, worktreePath, base: baseRef });
	} catch (err) {
		progress?.onPending?.(null);
		const stderr =
			err && typeof err === "object" && "stderr" in err
				? String((err as { stderr: Buffer }).stderr).trim()
				: err instanceof Error
					? err.message
					: String(err);
		return { ok: false, message: `git worktree add failed: ${stderr}` };
	}
	progress?.onPending?.(null);

	if (existence === "remote") {
		pushStep({
			kind: "ok",
			label: "checked out tracking branch",
			detail: `from origin/${parsed.branch}`,
		});
	} else if (existence === "local") {
		pushStep({
			kind: "ok",
			label: "checked out existing local branch",
			detail: parsed.branch,
		});
	} else {
		pushStep({
			kind: "ok",
			label: "created new branch",
			detail: `${parsed.branch} (from ${baseRef})`,
		});
	}
	await nextFrame(progress);

	pushStep({ kind: "ok", label: "worktree created", detail: worktreePath });
	await nextFrame(progress);

	upsertIssue(root, parsed.issueId, base ? { base_branch: base } : {});
	pushStep({ kind: "ok", label: "metadata updated", detail: `issue ${parsed.issueId}` });
	await nextFrame(progress);

	const { initFailed, initError } = await bootstrapWorktree(
		root,
		worktreePath,
		parsed.issueId,
		pushStep,
		progress,
	);

	// An uninitialised worktree is exactly the state that must NOT be handed to
	// an agent: it looks healthy while its tooling still points at the main
	// checkout. Withhold the hand-off and say so.
	const work = opts.work && !initFailed;
	if (opts.work && initFailed) {
		pushStep({
			kind: "error",
			label: "not launching Claude (worktree is not initialised)",
			detail: "fix init.sh, then run `mintree worktree work` in the worktree",
		});
		await nextFrame(progress);
	}

	let promptFile: string | undefined;
	if (work && opts.prompt && opts.prompt.length > 0) {
		try {
			promptFile = writePromptFile(opts.prompt);
		} catch (err) {
			pushStep({
				kind: "warn",
				label: "failed to stage --prompt for hand-off",
				detail: err instanceof Error ? err.message : String(err),
			});
		}
	}

	if (!opts.work && (opts.prompt || opts.permissionMode)) {
		pushStep({
			kind: "warn",
			label: "ignoring --prompt / --permission-mode (only meaningful with --work)",
		});
	}

	return {
		ok: true,
		steps,
		worktreePath,
		branch: parsed.branch,
		issueId: parsed.issueId,
		base,
		work,
		initFailed,
		...(initError ? { initError } : {}),
		promptFile,
		permissionMode: opts.permissionMode,
		...(guard.info ? { bareIssueBranch: guard.info } : {}),
	};
}

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
export async function runCreateDetached(opts: CreateDetachedOpts): Promise<CreateResult> {
	const progress = opts.progress;
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

	// Same shape as BRANCH_REGEX's issueId capture: bare digits (GitHub) or
	// `<TEAM>-\d+` (Linear). Otherwise the detached-worktree flow rejects
	// valid Linear ids like "FE-123" when they reach this entry point.
	if (!/^(?:[A-Z][A-Z0-9_]*-)?\d+$/.test(opts.issueId)) {
		return { ok: false, message: `Invalid issueId: ${opts.issueId}` };
	}
	if (!/^[a-z0-9][a-z0-9-]*$/.test(opts.descKebab)) {
		return {
			ok: false,
			message: `Invalid desc: ${opts.descKebab}`,
			hint: "Expected kebab-case starting with [a-z0-9].",
		};
	}

	const currentBranch = getCurrentBranch(root);
	if (!currentBranch) {
		return {
			ok: false,
			message: "Main repo is in detached HEAD — can't determine current branch to fork from.",
			hint: "Switch the main repo to a branch first (`git switch main`) and try again.",
		};
	}

	const worktreeDirName = opts.issueId;
	const worktreePath = path.join(getWorktreesDir(root), worktreeDirName);
	if (pathExists(worktreePath)) {
		return {
			ok: false,
			message: `Worktree directory already exists: ${worktreePath}`,
			hint: "Remove it first or pick a different description.",
		};
	}

	const steps: CreateStep[] = [];
	const pushStep = (step: CreateStep) => {
		steps.push(step);
		progress?.onStep?.(step);
	};

	pushStep({
		kind: "ok",
		label: "detached worktree",
		detail: `issue=${opts.issueId}, base=${currentBranch}`,
	});
	await nextFrame(progress);

	// Fetch so the detached worktree forks from the fresh remote tip of the
	// current branch instead of a stale local checkout. Best-effort.
	progress?.onPending?.("Fetching origin...");
	await nextFrame(progress);
	const fetch = fetchRemote(root);
	progress?.onPending?.(null);
	pushStep(
		fetch.ok
			? { kind: "ok", label: "fetched origin", detail: "refs up to date" }
			: { kind: "warn", label: "skipped git fetch", detail: fetch.reason },
	);
	await nextFrame(progress);
	const baseRef =
		fetch.ok && remoteBranchExists(root, currentBranch) ? `origin/${currentBranch}` : currentBranch;

	progress?.onPending?.("Creating worktree...");
	await nextFrame(progress);
	try {
		execSync(
			`git worktree add --detach '${worktreePath.replace(/'/g, `'\\''`)}' '${baseRef.replace(/'/g, `'\\''`)}'`,
			{ cwd: root, stdio: ["ignore", "pipe", "pipe"] },
		);
	} catch (err) {
		progress?.onPending?.(null);
		const stderr =
			err && typeof err === "object" && "stderr" in err
				? String((err as { stderr: Buffer }).stderr).trim()
				: err instanceof Error
					? err.message
					: String(err);
		return { ok: false, message: `git worktree add --detach failed: ${stderr}` };
	}
	progress?.onPending?.(null);

	pushStep({
		kind: "ok",
		label: "checked out detached HEAD",
		detail: `at tip of ${baseRef}`,
	});
	await nextFrame(progress);
	pushStep({ kind: "ok", label: "worktree created", detail: worktreePath });
	await nextFrame(progress);

	upsertIssue(root, opts.issueId, { base_branch: currentBranch });
	pushStep({ kind: "ok", label: "metadata updated", detail: `issue ${opts.issueId}` });
	await nextFrame(progress);

	const { initFailed, initError } = await bootstrapWorktree(
		root,
		worktreePath,
		opts.issueId,
		pushStep,
		progress,
	);

	const work = opts.work && !initFailed;
	if (opts.work && initFailed) {
		pushStep({
			kind: "error",
			label: "not launching Claude (worktree is not initialised)",
			detail: "fix init.sh, then run `mintree worktree work` in the worktree",
		});
		await nextFrame(progress);
	}

	let promptFile: string | undefined;
	if (work && opts.prompt && opts.prompt.length > 0) {
		try {
			promptFile = writePromptFile(opts.prompt);
		} catch (err) {
			pushStep({
				kind: "warn",
				label: "failed to stage --prompt for hand-off",
				detail: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return {
		ok: true,
		steps,
		worktreePath,
		branch: `detached @ ${currentBranch}`,
		issueId: opts.issueId,
		base: currentBranch,
		work,
		initFailed,
		...(initError ? { initError } : {}),
		promptFile,
		permissionMode: opts.permissionMode,
	};
}

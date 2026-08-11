import { execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
/**
 * Returns the absolute path of the **main** git repo root (not a worktree's
 * checkout). When invoked from inside a linked worktree, `git rev-parse
 * --show-toplevel` would return the worktree path; we resolve the common git
 * directory instead so callers always get the canonical place where `.mintree/`
 * lives. Returns `null` when not inside a git repository.
 */
export function findMainRepoRoot(cwd = process.cwd()) {
    try {
        const commonDir = execSync("git rev-parse --git-common-dir", {
            cwd,
            stdio: ["ignore", "pipe", "ignore"],
        })
            .toString()
            .trim();
        const absoluteCommonDir = path.isAbsolute(commonDir) ? commonDir : path.resolve(cwd, commonDir);
        // `--git-common-dir` points at `<root>/.git` in a normal repo. Its parent
        // is the working tree root we want.
        if (path.basename(absoluteCommonDir) === ".git") {
            return path.dirname(absoluteCommonDir);
        }
        // Bare repos or unusual setups: fall back to --show-toplevel.
        const top = execSync("git rev-parse --show-toplevel", {
            cwd,
            stdio: ["ignore", "pipe", "ignore"],
        })
            .toString()
            .trim();
        return top || null;
    }
    catch {
        return null;
    }
}
export function getMintreeDir(repoRoot) {
    return path.join(repoRoot, ".mintree");
}
export function getMetadataPath(repoRoot) {
    return path.join(getMintreeDir(repoRoot), "metadata.json");
}
export function getWorktreesDir(repoRoot) {
    return path.join(getMintreeDir(repoRoot), "worktrees");
}
export function getSessionStatesDir(repoRoot) {
    return path.join(getMintreeDir(repoRoot), "session-states");
}
export function getInitScriptPath(repoRoot) {
    return path.join(getMintreeDir(repoRoot), "init.sh");
}
/** Checks whether a path is gitignored according to the repo's rules. */
export function isGitIgnored(relativePath, cwd) {
    try {
        execSync(`git check-ignore -q "${relativePath}"`, { cwd, stdio: "ignore" });
        return true;
    }
    catch {
        return false;
    }
}
/**
 * True when the path is currently tracked by git in the repo at `cwd`. A
 * gitignore'd path can still be tracked if it was added before being
 * ignored — in that case `git rm --cached` is required to untrack it.
 */
export function isGitTracked(relativePath, cwd) {
    try {
        execSync(`git ls-files --error-unmatch "${relativePath}"`, {
            cwd,
            stdio: "ignore",
        });
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Looks for a file or directory in the repo that's likely to document the
 * project's branch / git conventions. The first hit wins — we just want
 * something to point the user at, not an exhaustive scan. Paths returned
 * are relative to `repoRoot` so they're safe to display.
 */
export function findBranchConventionDoc(repoRoot) {
    const candidates = [
        "docs/conventions/git-workflow.md",
        "docs/git-workflow.md",
        "docs/branching.md",
        "BRANCHING.md",
        "CONTRIBUTING.md",
        ".claude/skills",
    ];
    for (const c of candidates) {
        if (fs.existsSync(path.join(repoRoot, c)))
            return c;
    }
    return null;
}
export function pathExists(p) {
    return fs.existsSync(p);
}
export function isExecutable(p) {
    try {
        fs.accessSync(p, fs.constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Appends `entries` to `<repoRoot>/.gitignore`, skipping any entry already
 * matched by the repo's gitignore rules. Creates the file if missing. Returns
 * the entries that were actually appended.
 */
export function ensureGitignoreEntries(repoRoot, entries) {
    const gitignorePath = path.join(repoRoot, ".gitignore");
    const toAdd = entries.filter((entry) => !isGitIgnored(entry, repoRoot));
    if (toAdd.length === 0)
        return [];
    const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf-8") : "";
    const parts = [];
    if (existing.length > 0 && !existing.endsWith("\n"))
        parts.push("\n");
    if (existing.length > 0)
        parts.push("\n");
    parts.push("# mintree\n");
    parts.push(toAdd.join("\n") + "\n");
    fs.appendFileSync(gitignorePath, parts.join(""));
    return toAdd;
}
/**
 * Best-effort default branch detection. Tries `origin/HEAD` first (the most
 * authoritative source when the repo has a remote), then falls back to `main`
 * and `master` as on-disk heuristics. Returns null only when none of those
 * exist locally or on the remote.
 */
export function getDefaultBranch(repoRoot) {
    const head = trySh(`git symbolic-ref refs/remotes/origin/HEAD`, repoRoot);
    if (head) {
        // e.g. "refs/remotes/origin/main" -> "main"
        const m = head.match(/refs\/remotes\/origin\/(.+)$/);
        if (m && m[1])
            return m[1];
    }
    for (const candidate of ["main", "master"]) {
        if (branchExists(repoRoot, candidate) !== null)
            return candidate;
    }
    return null;
}
export function branchExists(repoRoot, branch) {
    if (trySh(`git rev-parse --verify --quiet "refs/heads/${branch}"`, repoRoot))
        return "local";
    if (trySh(`git rev-parse --verify --quiet "refs/remotes/origin/${branch}"`, repoRoot))
        return "remote";
    return null;
}
/**
 * True when `origin/<branch>` resolves locally. Unlike `branchExists`, this
 * reports the remote-tracking ref even when a local branch of the same name
 * also exists — callers that want to fork from the freshest remote tip need
 * to know the remote ref is there, not just "some ref named X".
 */
export function remoteBranchExists(repoRoot, branch) {
    return trySh(`git rev-parse --verify --quiet "refs/remotes/origin/${branch}"`, repoRoot) !== null;
}
/**
 * Best-effort `git fetch origin` so worktrees get created off fresh refs
 * instead of a stale local checkout. Never throws: when there's no `origin`
 * remote or the network is down, returns `{ ok: false, reason }` and callers
 * fall back to whatever refs are already local.
 */
export function fetchRemote(repoRoot) {
    if (!trySh("git remote get-url origin", repoRoot)) {
        return { ok: false, reason: "no origin remote" };
    }
    try {
        execSync("git fetch origin", { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
        return { ok: true };
    }
    catch (err) {
        const stderr = err && typeof err === "object" && "stderr" in err
            ? String(err.stderr).trim()
            : err instanceof Error
                ? err.message
                : String(err);
        return { ok: false, reason: stderr || "git fetch failed" };
    }
}
/**
 * Returns the absolute path where `branch` is checked out as a worktree, or
 * null when the branch is not checked out anywhere. Parses the porcelain
 * format of `git worktree list --porcelain`.
 */
export function worktreeForBranch(repoRoot, branch) {
    const output = trySh(`git worktree list --porcelain`, repoRoot);
    if (!output)
        return null;
    const ref = `refs/heads/${branch}`;
    const blocks = output.split(/\n\n+/);
    for (const block of blocks) {
        const lines = block.split("\n");
        let wtPath = null;
        let wtBranch = null;
        for (const line of lines) {
            if (line.startsWith("worktree "))
                wtPath = line.slice("worktree ".length);
            if (line.startsWith("branch "))
                wtBranch = line.slice("branch ".length);
        }
        if (wtPath && wtBranch === ref)
            return wtPath;
    }
    return null;
}
/**
 * Creates a git worktree at `worktreePath` checked out on `branch`. Behavior
 * depending on whether `branch` already exists:
 *  - new branch: `git worktree add -b <branch> <path> <base>`
 *  - local branch: `git worktree add <path> <branch>`
 *  - remote-only branch: `git worktree add --track -b <branch> <path>
 *    origin/<branch>` (creates a tracking local)
 *
 * Throws on failure with stderr included so the caller can surface it.
 */
export function addWorktree(args) {
    const { repoRoot, branch, worktreePath, base } = args;
    const existence = branchExists(repoRoot, branch);
    const safePath = shellQuote(worktreePath);
    const safeBranch = shellQuote(branch);
    let cmd;
    if (existence === "local") {
        cmd = `git worktree add ${safePath} ${safeBranch}`;
    }
    else if (existence === "remote") {
        cmd = `git worktree add --track -b ${safeBranch} ${safePath} ${shellQuote(`origin/${branch}`)}`;
    }
    else {
        if (!base)
            throw new Error(`Cannot create new branch ${branch}: no base branch resolved.`);
        cmd = `git worktree add -b ${safeBranch} ${safePath} ${shellQuote(base)}`;
    }
    execSync(cmd, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
}
/**
 * Removes a worktree via `git worktree remove`. With `force=true`, also
 * removes the worktree even if it has uncommitted changes. Throws on failure.
 */
export function removeWorktree(args) {
    const { repoRoot, worktreePath, force } = args;
    const cmd = `git worktree remove ${force ? "--force " : ""}${shellQuote(worktreePath)}`;
    execSync(cmd, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
}
/**
 * Runs `git worktree prune` to clean up worktree references whose on-disk
 * directory no longer exists.
 */
export function pruneWorktrees(repoRoot) {
    execSync("git worktree prune", { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
}
/**
 * Runs a shell command in `cwd` and returns trimmed stdout, or null if the
 * command exits non-zero. Used for git probes whose absence is meaningful.
 */
function trySh(cmd, cwd) {
    try {
        return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "ignore"] })
            .toString()
            .trim();
    }
    catch {
        return null;
    }
}
/** Single-quote a value for safe inclusion in a shell command line. */
function shellQuote(value) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
/**
 * Parses `git worktree list --porcelain` into structured entries. Includes
 * detached HEADs (branch=null) and the main worktree. Caller is responsible
 * for filtering to mintree-managed worktrees.
 */
export function listWorktrees(repoRoot) {
    const output = trySh("git worktree list --porcelain", repoRoot);
    if (!output)
        return [];
    const entries = [];
    const blocks = output.split(/\n\n+/);
    for (const block of blocks) {
        let entryPath = null;
        let head = null;
        let branch = null;
        for (const line of block.split("\n")) {
            if (line.startsWith("worktree "))
                entryPath = line.slice("worktree ".length);
            else if (line.startsWith("HEAD "))
                head = line.slice("HEAD ".length);
            else if (line.startsWith("branch ")) {
                const ref = line.slice("branch ".length);
                branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
            }
        }
        if (entryPath)
            entries.push({ path: entryPath, branch, head });
    }
    return entries;
}
/** True when the worktree has any uncommitted changes (porcelain non-empty). */
export function isDirty(worktreePath) {
    const out = trySh("git status --porcelain", worktreePath);
    return out !== null && out.length > 0;
}
/**
 * Returns the current branch of the git checkout at `cwd`, or null when in a
 * detached HEAD or outside a git repo.
 */
export function getCurrentBranch(cwd) {
    const out = trySh("git symbolic-ref --short -q HEAD", cwd);
    return out && out.length > 0 ? out : null;
}
/**
 * Returns commits ahead/behind `against` from the worktree's HEAD. `against`
 * is resolved in this priority: explicit param > `@{upstream}` > null.
 * Returns null when no comparison ref is available.
 */
export function getAheadBehind(worktreePath, against) {
    let ref = against;
    if (!ref) {
        const upstream = trySh("git rev-parse --abbrev-ref --symbolic-full-name @{upstream}", worktreePath);
        if (upstream)
            ref = upstream;
    }
    if (!ref)
        return null;
    const counts = trySh(`git rev-list --left-right --count HEAD...${shellQuote(ref)}`, worktreePath);
    if (!counts)
        return null;
    const parts = counts.split(/\s+/);
    if (parts.length < 2)
        return null;
    const ahead = Number(parts[0]);
    const behind = Number(parts[1]);
    if (Number.isNaN(ahead) || Number.isNaN(behind))
        return null;
    return { ahead, behind, against: ref };
}

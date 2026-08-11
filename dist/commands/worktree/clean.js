import { jsxs as _jsxs, jsx as _jsx, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import { option } from "pastel";
import { z } from "zod";
import * as path from "path";
import { findMainRepoRoot, getMintreeDir, getWorktreesDir, listWorktrees, isDirty, removeWorktree, pathExists, } from "../../lib/git.js";
import { fetchPrForBranch } from "../../lib/pr.js";
import { issueIdFromWorktreeDirName } from "../../lib/branch.js";
import { removeIssue } from "../../lib/metadata.js";
export const description = "Remove worktrees whose PR is merged or closed";
export const options = z.object({
    yes: z
        .boolean()
        .default(false)
        .describe(option({
        description: "Skip the confirmation prompt (required for non-interactive shells)",
    })),
    force: z
        .boolean()
        .default(false)
        .describe(option({
        description: "Include worktrees with uncommitted changes (clean is conservative by default)",
    })),
});
async function loadCandidates(force) {
    const root = findMainRepoRoot();
    if (!root) {
        return {
            phase: "error",
            message: "Not in a git repository.",
            hint: "Run `git init` and then `mintree init`.",
        };
    }
    if (!pathExists(getMintreeDir(root))) {
        return {
            phase: "error",
            message: ".mintree/ not found in this repo.",
            hint: "Run `mintree init` first.",
        };
    }
    const worktreesDir = getWorktreesDir(root);
    const all = listWorktrees(root);
    const ours = all.filter((w) => {
        if (!w.branch)
            return false;
        const wAbs = path.resolve(w.path);
        const dirAbs = path.resolve(worktreesDir);
        return wAbs === dirAbs || wAbs.startsWith(dirAbs + path.sep);
    });
    if (ours.length === 0) {
        return { phase: "nothing", message: "No mintree worktrees in this repo. Nothing to clean." };
    }
    const prs = await Promise.all(ours.map((w) => fetchPrForBranch(w.branch, { withUrl: false })));
    const candidates = [];
    for (let i = 0; i < ours.length; i++) {
        const w = ours[i];
        const pr = prs[i];
        if (!w || !w.branch)
            continue;
        if (!pr || pr.state === "OPEN")
            continue; // only candidates with closed/merged PRs
        const dirty = pathExists(w.path) ? isDirty(w.path) : false;
        const skipForDirty = dirty && !force;
        candidates.push({
            worktreePath: w.path,
            branch: w.branch,
            dirty,
            pr,
            willClean: !skipForDirty,
            reasonSkipped: skipForDirty ? "dirty (pass --force to include)" : undefined,
        });
    }
    if (candidates.length === 0) {
        return {
            phase: "nothing",
            message: "All mintree worktrees still have an open PR (or no PR at all). Nothing to clean.",
        };
    }
    return { phase: "prompt", repoRoot: root, candidates };
}
function executeRemovals(repoRoot, candidates) {
    const toRemove = candidates.filter((c) => c.willClean);
    const results = [];
    for (const c of toRemove) {
        try {
            removeWorktree({ repoRoot, worktreePath: c.worktreePath, force: c.dirty });
            // Unlike `worktree remove` (which preserves metadata so a later
            // re-attach can resume the same Claude session), clean only touches
            // worktrees whose PR is merged/closed — the issue is done, so drop
            // its metadata entry (session_id and all) instead of letting it
            // accumulate. issueId is null for detached-HEAD worktrees; skip those.
            const issueId = issueIdFromWorktreeDirName(path.basename(c.worktreePath));
            if (issueId)
                removeIssue(repoRoot, issueId);
            results.push({ branch: c.branch, ok: true });
        }
        catch (err) {
            const stderr = err && typeof err === "object" && "stderr" in err
                ? String(err.stderr).trim()
                : err instanceof Error
                    ? err.message
                    : String(err);
            results.push({ branch: c.branch, ok: false, error: stderr });
        }
    }
    return results;
}
function PrTag({ pr }) {
    const color = pr.state === "MERGED" ? "magenta" : pr.state === "CLOSED" ? "yellow" : "green";
    return (_jsxs(Text, { children: [_jsxs(Text, { children: ["#", pr.number] }), " ", _jsx(Text, { color: color, children: pr.state })] }));
}
export default function Clean({ options }) {
    const { exit } = useApp();
    const [state, setState] = useState({
        phase: "loading",
        message: "Inspecting worktrees...",
    });
    useEffect(() => {
        (async () => {
            try {
                const next = await loadCandidates(options.force);
                if (next.phase === "prompt") {
                    // In non-interactive environments useInput will never fire, so we
                    // require --yes up front rather than hanging the user.
                    if (!process.stdin.isTTY && !options.yes) {
                        setState({
                            phase: "error",
                            message: "Confirmation required but stdin is not a TTY (running non-interactive).",
                            hint: "Re-run with `--yes` to skip the prompt.",
                        });
                        return;
                    }
                    if (options.yes) {
                        setState({
                            phase: "executing",
                            repoRoot: next.repoRoot,
                            candidates: next.candidates,
                        });
                        return;
                    }
                }
                setState(next);
            }
            catch (err) {
                setState({
                    phase: "error",
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        })();
    }, [options.force, options.yes]);
    useEffect(() => {
        if (state.phase === "executing") {
            const results = executeRemovals(state.repoRoot, state.candidates);
            setState({ phase: "done", results, cancelled: false });
        }
    }, [state.phase]);
    useEffect(() => {
        if (state.phase === "done" || state.phase === "error" || state.phase === "nothing") {
            // Defer one tick so the final UI paints before Ink unmounts.
            const t = setTimeout(() => exit(), 50);
            return () => clearTimeout(t);
        }
        return;
    }, [state.phase, exit]);
    useInput((input, key) => {
        if (state.phase !== "prompt")
            return;
        if (input === "y" || input === "Y") {
            setState({
                phase: "executing",
                repoRoot: state.repoRoot,
                candidates: state.candidates,
            });
        }
        else if (input === "n" || input === "N" || key.return || key.escape) {
            setState({ phase: "done", results: [], cancelled: true });
        }
    }, { isActive: state.phase === "prompt" });
    if (state.phase === "loading") {
        return (_jsxs(Box, { children: [_jsx(Text, { color: "cyan", children: _jsx(Spinner, { type: "dots" }) }), _jsxs(Text, { children: [" ", state.message] })] }));
    }
    if (state.phase === "error") {
        return (_jsxs(Box, { flexDirection: "column", padding: 1, children: [_jsxs(Text, { color: "red", bold: true, children: ["\u2717 ", state.message] }), state.hint && (_jsx(Box, { marginTop: 1, children: _jsxs(Text, { color: "yellow", children: ["\u21B3 ", state.hint] }) }))] }));
    }
    if (state.phase === "nothing") {
        return (_jsx(Box, { padding: 1, children: _jsx(Text, { dimColor: true, children: state.message }) }));
    }
    if (state.phase === "prompt" || state.phase === "executing") {
        const willCleanCount = state.candidates.filter((c) => c.willClean).length;
        return (_jsxs(Box, { flexDirection: "column", padding: 1, children: [_jsxs(Box, { marginBottom: 1, children: [_jsx(Text, { bold: true, color: "cyan", children: "mintree worktree clean" }), _jsxs(Text, { dimColor: true, children: [" \u00B7 ", state.candidates.length, " candidate(s)"] })] }), state.candidates.map((c, i) => (_jsxs(Box, { children: [_jsx(Text, { color: c.willClean ? "green" : "yellow", children: c.willClean ? "✓" : "○" }), _jsx(Text, { children: " " }), _jsx(Text, { color: "cyan", children: c.branch }), _jsx(Text, { children: " " }), _jsx(PrTag, { pr: c.pr }), c.dirty && _jsx(Text, { color: "yellow", children: " [dirty]" }), c.reasonSkipped && _jsxs(Text, { dimColor: true, children: [" \u2014 ", c.reasonSkipped] })] }, i))), _jsx(Box, { marginTop: 1, children: state.phase === "prompt" ? (_jsxs(Text, { children: ["Remove ", willCleanCount, " worktree(s)? ", _jsx(Text, { bold: true, children: "[y/N]" })] })) : (_jsxs(Box, { children: [_jsx(Text, { color: "cyan", children: _jsx(Spinner, { type: "dots" }) }), _jsx(Text, { children: " Removing..." })] })) })] }));
    }
    // state.phase === "done"
    if (state.cancelled) {
        return (_jsx(Box, { padding: 1, children: _jsx(Text, { dimColor: true, children: "Cancelled. No worktrees were removed." }) }));
    }
    const okCount = state.results.filter((r) => r.ok).length;
    const failCount = state.results.length - okCount;
    return (_jsxs(Box, { flexDirection: "column", padding: 1, children: [_jsx(Box, { marginBottom: 1, children: _jsx(Text, { bold: true, color: "cyan", children: "mintree worktree clean \u00B7 done" }) }), state.results.map((r, i) => (_jsxs(Box, { children: [_jsx(Text, { color: r.ok ? "green" : "red", children: r.ok ? "✓" : "✗" }), _jsx(Text, { children: " " }), _jsx(Text, { color: "cyan", children: r.branch }), !r.ok && _jsxs(Text, { color: "red", children: [" \u2014 ", r.error] })] }, i))), _jsx(Box, { marginTop: 1, children: _jsxs(Text, { children: ["Removed ", okCount, failCount > 0 && (_jsxs(_Fragment, { children: [", ", _jsxs(Text, { color: "red", children: [failCount, " failed"] })] })), ". Branches preserved; metadata entries pruned."] }) })] }));
}

import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { option } from "pastel";
import { z } from "zod";
import * as path from "path";
import { findMainRepoRoot, getWorktreesDir, listWorktrees, isDirty, getAheadBehind, pathExists, getMintreeDir, } from "../../lib/git.js";
import { readMetadata } from "../../lib/metadata.js";
import { fetchPrForBranch } from "../../lib/pr.js";
export const description = "List mintree-managed worktrees with dirty/ahead/PR status";
export const options = z.object({
    pr: z
        .boolean()
        .default(false)
        .describe(option({ description: "Look up PR status for each branch via `gh` (slower)" })),
});
// Matches the BRANCH_REGEX shape from lib/branch.ts: either `\d+` (GitHub)
// or `<TEAM>-\d+` (Linear). Used to surface FE-123 in the ISSUE column.
const ISSUE_ID_REGEX = /^[a-z]+\/((?:[A-Z][A-Z0-9_]*-)?\d+)-/;
function extractIssueId(branch) {
    if (!branch)
        return null;
    const m = branch.match(ISSUE_ID_REGEX);
    return m && m[1] ? m[1] : null;
}
async function load(checkPr) {
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
        // Filter to worktrees that live under .mintree/worktrees/. macOS reports
        // /private/tmp paths so use a relative-prefix check after resolving both
        // to absolute.
        const wAbs = path.resolve(w.path);
        const dirAbs = path.resolve(worktreesDir);
        return wAbs === dirAbs || wAbs.startsWith(dirAbs + path.sep);
    });
    if (ours.length === 0) {
        return { phase: "empty", repoRoot: root };
    }
    const metadata = readMetadata(root);
    const rows = ours.map((w) => {
        const issueId = extractIssueId(w.branch);
        const baseFromMeta = issueId ? metadata.issues[issueId]?.base_branch : undefined;
        return {
            worktreePath: w.path,
            branch: w.branch ?? "(detached)",
            issueId,
            dirty: isDirty(w.path),
            ab: getAheadBehind(w.path, baseFromMeta),
        };
    });
    if (checkPr) {
        const prResults = await Promise.all(rows.map((r) => r.branch === "(detached)"
            ? Promise.resolve(null)
            : fetchPrForBranch(r.branch, { withUrl: false })));
        rows.forEach((r, i) => {
            const pr = prResults[i];
            if (pr)
                r.pr = pr;
        });
    }
    return { phase: "ready", repoRoot: root, rows, checkedPr: checkPr };
}
function StatusCell({ dirty }) {
    return dirty ? _jsx(Text, { color: "yellow", children: "dirty" }) : _jsx(Text, { color: "green", children: "clean" });
}
function AheadBehindCell({ ab }) {
    if (!ab)
        return _jsx(Text, { dimColor: true, children: "\u2014" });
    const isUp = ab.ahead === 0 && ab.behind === 0;
    if (isUp)
        return _jsx(Text, { dimColor: true, children: "=" });
    return (_jsxs(Text, { children: [_jsxs(Text, { color: ab.ahead > 0 ? "cyan" : undefined, children: ["+", ab.ahead] }), _jsx(Text, { dimColor: true, children: " / " }), _jsxs(Text, { color: ab.behind > 0 ? "magenta" : undefined, children: ["-", ab.behind] })] }));
}
function PrCell({ pr, checked }) {
    if (!checked)
        return null;
    if (!pr)
        return _jsx(Text, { dimColor: true, children: "\u2014" });
    const color = pr.state === "OPEN" ? "green" : pr.state === "MERGED" ? "magenta" : "yellow";
    return (_jsxs(Text, { children: [_jsxs(Text, { children: ["#", pr.number] }), _jsx(Text, { dimColor: true, children: " " }), _jsx(Text, { color: color, children: pr.state })] }));
}
function pad(s, width) {
    if (s.length >= width)
        return s;
    return s + " ".repeat(width - s.length);
}
export default function List({ options }) {
    const [state, setState] = useState({ phase: "loading" });
    useEffect(() => {
        (async () => {
            try {
                setState(await load(options.pr));
            }
            catch (err) {
                setState({
                    phase: "error",
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        })();
    }, [options.pr]);
    if (state.phase === "loading") {
        return (_jsxs(Box, { children: [_jsx(Text, { color: "cyan", children: _jsx(Spinner, { type: "dots" }) }), _jsxs(Text, { children: [" Listing worktrees", options.pr ? " (checking PR status)" : "", "..."] })] }));
    }
    if (state.phase === "error") {
        return (_jsxs(Box, { flexDirection: "column", padding: 1, children: [_jsxs(Text, { color: "red", bold: true, children: ["\u2717 ", state.message] }), state.hint && (_jsx(Box, { marginTop: 1, children: _jsxs(Text, { color: "yellow", children: ["\u21B3 ", state.hint] }) }))] }));
    }
    if (state.phase === "empty") {
        return (_jsxs(Box, { flexDirection: "column", padding: 1, children: [_jsxs(Text, { dimColor: true, children: ["No mintree worktrees in ", state.repoRoot, "."] }), _jsx(Box, { marginTop: 1, children: _jsxs(Text, { children: ["Create one with ", _jsx(Text, { bold: true, children: "mintree worktree create <branch>" }), "."] }) })] }));
    }
    const issueWidth = Math.max(5, ...state.rows.map((r) => (r.issueId ?? "—").length));
    const branchWidth = Math.max(6, ...state.rows.map((r) => r.branch.length));
    return (_jsxs(Box, { flexDirection: "column", padding: 1, children: [_jsxs(Box, { marginBottom: 1, children: [_jsx(Text, { bold: true, children: pad("ISSUE", issueWidth) }), _jsx(Text, { children: " " }), _jsx(Text, { bold: true, children: pad("BRANCH", branchWidth) }), _jsx(Text, { children: " " }), _jsx(Text, { bold: true, children: "STATUS" }), _jsx(Text, { children: " " }), _jsx(Text, { bold: true, children: "\u0394" }), _jsx(Text, { children: " " }), state.checkedPr && _jsx(Text, { bold: true, children: "PR" })] }), state.rows.map((r, i) => (_jsxs(Box, { children: [_jsx(Text, { children: pad(r.issueId ?? "—", issueWidth) }), _jsx(Text, { children: " " }), _jsx(Text, { color: "cyan", children: pad(r.branch, branchWidth) }), _jsx(Text, { children: " " }), _jsx(Box, { width: 9, children: _jsx(StatusCell, { dirty: r.dirty }) }), _jsx(Box, { width: 12, children: _jsx(AheadBehindCell, { ab: r.ab }) }), _jsx(PrCell, { pr: r.pr, checked: state.checkedPr })] }, i)))] }));
}

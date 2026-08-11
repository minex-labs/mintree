import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { argument, option } from "pastel";
import { z } from "zod";
import { runRemove } from "../../lib/worktreeRemove.js";
export const description = "Remove a worktree (the branch and metadata are preserved so you can re-attach later)";
export const args = z.tuple([
    z.string().describe(argument({
        name: "branch",
        description: "Branch whose worktree should be removed (in the same `<type>/<issue>-<desc>` format)",
    })),
]);
export const options = z.object({
    force: z
        .boolean()
        .default(false)
        .describe(option({
        description: "Remove even if the worktree has uncommitted changes",
    })),
});
export default function Remove({ args, options }) {
    const [branch] = args;
    const [result, setResult] = useState(null);
    useEffect(() => {
        setTimeout(() => {
            try {
                setResult(runRemove(branch, options.force));
            }
            catch (err) {
                setResult({
                    ok: false,
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        }, 0);
    }, [branch, options.force]);
    if (!result) {
        return (_jsxs(Box, { children: [_jsx(Text, { color: "cyan", children: _jsx(Spinner, { type: "dots" }) }), _jsxs(Text, { children: [" Removing worktree for ", branch, "..."] })] }));
    }
    if (!result.ok) {
        return (_jsxs(Box, { flexDirection: "column", padding: 1, children: [_jsxs(Text, { color: "red", bold: true, children: ["\u2717 ", result.message] }), result.hint && (_jsx(Box, { marginTop: 1, children: _jsxs(Text, { color: "yellow", children: ["\u21B3 ", result.hint] }) }))] }));
    }
    return (_jsxs(Box, { flexDirection: "column", padding: 1, children: [_jsxs(Box, { marginBottom: 1, children: [_jsx(Text, { bold: true, color: "cyan", children: "mintree worktree remove" }), _jsxs(Text, { dimColor: true, children: [" \u00B7 ", result.branch] })] }), result.variant === "pruned-orphan" ? (_jsxs(Text, { children: [_jsx(Text, { color: "yellow", children: "!" }), " worktree directory was already deleted; pruned the dangling reference"] })) : result.variant === "removed-unregistered" ? (_jsx(Box, { flexDirection: "column", children: _jsxs(Text, { children: [_jsx(Text, { color: "yellow", children: "!" }), " directory was not registered with git; deleted it", _jsxs(Text, { dimColor: true, children: [" (", result.worktreePath, ")"] })] }) })) : (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { children: [_jsx(Text, { color: "green", children: "\u2713" }), " removed ", _jsxs(Text, { dimColor: true, children: ["(", result.worktreePath, ")"] })] }), result.wasDirty && _jsx(Text, { color: "yellow", children: "\u21B3 forced past uncommitted changes" })] })), _jsxs(Box, { marginTop: 1, flexDirection: "column", children: [_jsxs(Text, { dimColor: true, children: ["Branch ", _jsx(Text, { color: "cyan", children: result.branch }), " was preserved (use `git branch -D", " ", result.branch, "` to delete it)."] }), result.prunedIssueId ? (_jsxs(Text, { dimColor: true, children: ["Metadata entry for ", _jsx(Text, { color: "cyan", children: result.prunedIssueId }), " (incl. session_id) was pruned."] })) : (_jsx(Text, { dimColor: true, children: "No metadata entry to prune." }))] })] }));
}

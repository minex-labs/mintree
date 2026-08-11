import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { argument, option } from "pastel";
import { z } from "zod";
import { PERMISSION_MODES } from "../../lib/claude.js";
import { runCreate } from "../../lib/worktreeCreate.js";
import { buildCreateMarkers, emitMarkers } from "../../lib/markers.js";
import { findMainRepoRoot } from "../../lib/git.js";
import { createProvider, describeTransition } from "../../lib/providers/index.js";
export const description = "Create a worktree for an issue branch";
export const args = z.tuple([
    z.string().describe(argument({
        name: "branch",
        description: "Branch in `<type>/<issue>-<kebab-desc>` format (e.g. feat/100-claude-md-inicial). On a Linear repo you can instead pass the issue's Linear branch name (e.g. jdoe/fe-68-landing-page).",
    })),
]);
export const options = z.object({
    base: z
        .string()
        .optional()
        .describe(option({
        description: "Base branch to fork from (defaults to origin/HEAD or main/master)",
    })),
    work: z
        .boolean()
        .default(false)
        .describe(option({
        description: "After creating, launch Claude in the new worktree (requires the shell wrapper)",
    })),
    prompt: z
        .string()
        .optional()
        .describe(option({
        description: "Initial prompt to inject into Claude (only meaningful with --work; literal injection)",
    })),
    permissionMode: z
        .enum(PERMISSION_MODES)
        .optional()
        .describe(option({
        description: `Claude --permission-mode passed through to --work (one of: ${PERMISSION_MODES.join(", ")})`,
        alias: "m",
    })),
});
function StepIcon({ kind }) {
    if (kind === "ok")
        return _jsx(Text, { color: "green", children: "\u2713" });
    if (kind === "warn")
        return _jsx(Text, { color: "yellow", children: "!" });
    if (kind === "error")
        return _jsx(Text, { color: "red", children: "\u2717" });
    return _jsx(Text, { color: "cyan", children: "\u25CB" });
}
export default function Create({ args, options }) {
    const [branch] = args;
    const [result, setResult] = useState(null);
    const [transition, setTransition] = useState("idle");
    useEffect(() => {
        (async () => {
            try {
                const r = await runCreate(branch, {
                    base: options.base,
                    work: options.work,
                    prompt: options.prompt,
                    permissionMode: options.permissionMode,
                });
                setResult(r);
            }
            catch (err) {
                setResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
            }
        })();
    }, [branch, options.base, options.work, options.prompt, options.permissionMode]);
    // Kick the Project v2 transition once the worktree is in place. Only when
    // --work was on — non-work creates leave status untouched. Errors from the
    // GraphQL call surface as a step but never block the worktree hand-off.
    useEffect(() => {
        if (!result || !result.ok)
            return;
        if (!result.work) {
            setTransition("skipped");
            return;
        }
        setTransition("running");
        let cancelled = false;
        (async () => {
            const root = findMainRepoRoot();
            if (!root) {
                if (!cancelled)
                    setTransition("skipped");
                return;
            }
            try {
                const provider = createProvider(root);
                const r = await provider.transitionIssueToInProgress(result.issueId);
                if (!cancelled)
                    setTransition(r);
            }
            catch (err) {
                if (cancelled)
                    return;
                setTransition({
                    kind: "error",
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [result]);
    // A create that hard-failed, or one whose init hook failed, must not look
    // like a success to whatever ran mintree. Ink owns stdout so this sets the
    // exit code rather than calling process.exit, which would cut the render.
    useEffect(() => {
        if (!result)
            return;
        if (!result.ok || result.initFailed)
            process.exitCode = 1;
    }, [result]);
    // Emit shell-wrapper markers when create succeeded AND the transition has
    // settled (run or skipped). Goes through the emitMarkers helper so it
    // lands in MINTREE_MARKER_FILE if set, otherwise stdout. Bypasses Ink so
    // word-wrap can't split a long path mid-marker.
    useEffect(() => {
        if (!result || !result.ok)
            return;
        if (transition === "idle" || transition === "running")
            return;
        emitMarkers(buildCreateMarkers({
            worktreePath: result.worktreePath,
            work: result.work,
            promptFile: result.promptFile,
            permissionMode: result.permissionMode,
        }));
    }, [result, transition]);
    if (!result) {
        return (_jsxs(Box, { children: [_jsx(Text, { color: "cyan", children: _jsx(Spinner, { type: "dots" }) }), _jsxs(Text, { children: [" Creating worktree for ", branch, "..."] })] }));
    }
    if (!result.ok) {
        return (_jsxs(Box, { flexDirection: "column", padding: 1, children: [_jsxs(Text, { color: "red", bold: true, children: ["\u2717 ", result.message] }), result.hint && (_jsx(Box, { marginTop: 1, children: _jsxs(Text, { color: "yellow", children: ["\u21B3 ", result.hint] }) }))] }));
    }
    return (_jsxs(Box, { flexDirection: "column", padding: 1, children: [_jsxs(Box, { marginBottom: 1, children: [_jsx(Text, { bold: true, color: "cyan", children: "mintree worktree create" }), _jsxs(Text, { dimColor: true, children: [" \u00B7 ", result.branch] })] }), result.steps.map((step, i) => (_jsxs(Box, { children: [_jsx(StepIcon, { kind: step.kind }), _jsx(Text, { children: " " }), _jsx(Text, { children: step.label }), step.detail && _jsxs(Text, { dimColor: true, children: [" (", step.detail, ")"] })] }, i))), transition === "running" && (_jsxs(Box, { children: [_jsx(Text, { color: "cyan", children: _jsx(Spinner, { type: "dots" }) }), _jsx(Text, { children: " Updating issue status..." })] })), typeof transition === "object" &&
                (() => {
                    const step = describeTransition(transition);
                    return (_jsxs(Box, { children: [_jsx(StepIcon, { kind: step.kind }), _jsx(Text, { children: " " }), _jsx(Text, { children: step.label }), step.detail && _jsxs(Text, { dimColor: true, children: [" (", step.detail, ")"] })] }));
                })(), result.initFailed ? (_jsxs(Box, { marginTop: 1, flexDirection: "column", children: [_jsx(Text, { color: "red", bold: true, children: "\u2717 Worktree created but NOT initialised \u2014 .mintree/init.sh failed" }), result.initError && _jsxs(Text, { color: "red", children: [" ", result.initError] }), _jsxs(Text, { dimColor: true, children: [" at ", result.worktreePath] }), _jsx(Box, { marginTop: 1, children: _jsx(Text, { color: "yellow", children: "\u21B3 Whatever init.sh sets up (isolation, per-worktree config) is missing. Fix the hook and re-run it in the worktree before working there." }) })] })) : (_jsxs(Box, { marginTop: 1, flexDirection: "column", children: [_jsxs(Text, { color: "green", children: ["Worktree ready at ", _jsx(Text, { bold: true, children: result.worktreePath })] }), _jsx(Text, { dimColor: true, children: result.work
                            ? "Launching Claude in the new worktree..."
                            : "Next: `mt worktree work` to start a Claude session, or `cd` and run `claude` directly." })] }))] }));
}

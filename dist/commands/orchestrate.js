import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { argument, option } from "pastel";
import { z } from "zod";
import { randomUUID } from "crypto";
import { readFileSync, unlinkSync } from "fs";
import { findMainRepoRoot, getMintreeDir, pathExists } from "../lib/git.js";
import { readMetadata } from "../lib/metadata.js";
import { launchClaude, PERMISSION_MODES } from "../lib/claude.js";
import { defaultOrchestratorPrompt, renderOrchestratorTemplate } from "../lib/promptTemplate.js";
import { buildOrchestratorRcName } from "../lib/orchestrate.js";
export const description = "Launch a Claude orchestrator in the repo root to resolve a batch of tickets";
export const args = z
    .array(z.string())
    .default([])
    .describe(argument({
    name: "ids",
    description: "Ticket ids to orchestrate (e.g. FE-81 FE-84). Renders the orchestratorPromptTemplate (or the built-in default). Ignored when --prompt / --prompt-file is given. Optional: the dashboard hands the prompt over via --prompt-file with no positional ids.",
}));
export const options = z.object({
    prompt: z
        .string()
        .optional()
        .describe(option({
        description: "Literal orchestrator message (overrides the template/ids).",
    })),
    promptFile: z
        .string()
        .optional()
        .describe(option({
        description: "Read the orchestrator message from this file (deleted after read). Used by the dashboard's Orchestrate tab. Mutually exclusive with --prompt.",
    })),
    permissionMode: z
        .enum(PERMISSION_MODES)
        .optional()
        .describe(option({
        description: `Claude --permission-mode (one of: ${PERMISSION_MODES.join(", ")}). Defaults to metadata.defaultPermissionMode, else "default".`,
        alias: "m",
    })),
    rcName: z
        .string()
        .optional()
        .describe(option({
        description: "Remote Control name for the session. Defaults to orchestrator-<ids> derived from the positional ids (used by the dashboard, which has no positional ids), else orchestrator-<session-hash>.",
    })),
});
function resolve(cwd, ids, opts) {
    if (opts.prompt && opts.promptFile) {
        return { ok: false, message: "--prompt and --prompt-file are mutually exclusive." };
    }
    const repoRoot = findMainRepoRoot(cwd);
    if (!repoRoot) {
        return {
            ok: false,
            message: "Not in a git repository.",
            hint: "Run `mintree orchestrate` from inside a mintree-enabled repo.",
        };
    }
    if (!pathExists(getMintreeDir(repoRoot))) {
        return {
            ok: false,
            message: ".mintree/ not found in this repo.",
            hint: "Run `mintree init` first.",
        };
    }
    // Resolve the orchestrator message. Priority: --prompt-file (the dashboard
    // path) > --prompt (literal) > render the template from the ticket ids.
    let prompt;
    if (opts.promptFile) {
        try {
            prompt = readFileSync(opts.promptFile, "utf-8");
        }
        catch {
            return {
                ok: false,
                message: `Could not read --prompt-file ${opts.promptFile}.`,
            };
        }
        try {
            unlinkSync(opts.promptFile);
        }
        catch {
            // Cleanup failure is non-fatal.
        }
    }
    else if (opts.prompt) {
        prompt = opts.prompt;
    }
    else if (ids.length > 0) {
        const idList = ids.join(", ");
        const template = readMetadata(repoRoot).orchestratorPromptTemplate;
        prompt = template
            ? renderOrchestratorTemplate(template, { ids: idList, count: ids.length })
            : defaultOrchestratorPrompt(idList);
    }
    if (!prompt || prompt.trim().length === 0) {
        return {
            ok: false,
            message: "Nothing to orchestrate.",
            hint: "Pass ticket ids (e.g. `mintree orchestrate FE-81 FE-84`) or a --prompt.",
        };
    }
    const permissionMode = opts.permissionMode ?? readMetadata(repoRoot).defaultPermissionMode ?? "default";
    const sessionId = randomUUID();
    // RC name priority: explicit --rc-name (the dashboard passes the
    // ids-derived name this way) > derive from positional ids > session hash
    // fallback for the prompt-only path with no tickets to name after.
    const remoteControlName = opts.rcName ?? buildOrchestratorRcName(ids) ?? `orchestrator-${sessionId.slice(0, 8)}`;
    return {
        ok: true,
        data: { repoRoot, sessionId, permissionMode, prompt, remoteControlName },
    };
}
export default function Orchestrate({ args: ids, options }) {
    const [state, setState] = useState({ phase: "loading" });
    useEffect(() => {
        setTimeout(() => {
            const result = resolve(process.cwd(), ids, options);
            if (!result.ok) {
                setState({ phase: "error", message: result.message, hint: result.hint });
                return;
            }
            setState({ phase: "launching", resolved: result.data });
        }, 0);
    }, []);
    useEffect(() => {
        if (state.phase !== "launching")
            return;
        const { resolved } = state;
        try {
            const child = launchClaude({
                permissionMode: resolved.permissionMode,
                sessionId: resolved.sessionId,
                resume: false,
                prompt: resolved.prompt,
                cwd: resolved.repoRoot,
                // Name the RC session after the tickets it covers
                // (orchestrator-FE-12_BE-16_FE-3) so it's identifiable in the RC
                // UI. Falls back to a session hash when there are no ids. Note:
                // re-launching the exact same batch reuses the name, which can
                // collide with a still-registered prior session.
                remoteControlName: resolved.remoteControlName,
            });
            child.on("error", (err) => {
                setState({ phase: "error", message: `Failed to launch claude: ${err.message}` });
            });
            child.on("close", (code) => {
                process.exit(code ?? 0);
            });
        }
        catch (err) {
            setState({
                phase: "error",
                message: err instanceof Error ? err.message : String(err),
            });
        }
    }, [state.phase]);
    if (state.phase === "loading") {
        return (_jsxs(Box, { children: [_jsx(Text, { color: "cyan", children: _jsx(Spinner, { type: "dots" }) }), _jsx(Text, { children: " Resolving repo..." })] }));
    }
    if (state.phase === "error") {
        return (_jsxs(Box, { flexDirection: "column", padding: 1, children: [_jsxs(Text, { color: "red", bold: true, children: ["\u2717 ", state.message] }), state.hint && (_jsx(Box, { marginTop: 1, children: _jsxs(Text, { color: "yellow", children: ["\u21B3 ", state.hint] }) }))] }));
    }
    const { resolved } = state;
    const sessionShort = resolved.sessionId.slice(0, 8);
    return (_jsxs(Box, { flexDirection: "column", padding: 1, children: [_jsxs(Box, { marginBottom: 1, children: [_jsx(Text, { bold: true, color: "cyan", children: "mintree orchestrate" }), _jsxs(Text, { dimColor: true, children: [" \u00B7 ", resolved.repoRoot] })] }), _jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { children: [_jsx(Text, { dimColor: true, children: "session: " }), _jsxs(Text, { children: [sessionShort, "\u2026"] }), _jsx(Text, { dimColor: true, children: " (starting)" })] }), _jsxs(Text, { children: [_jsx(Text, { dimColor: true, children: "rc: " }), _jsx(Text, { children: resolved.remoteControlName })] }), _jsxs(Text, { children: [_jsx(Text, { dimColor: true, children: "permission-mode: " }), _jsx(Text, { children: resolved.permissionMode })] }), _jsxs(Text, { children: [_jsx(Text, { dimColor: true, children: "prompt: " }), _jsxs(Text, { children: ["\"", truncate(resolved.prompt.replace(/\n/g, " "), 60), "\""] })] })] }), _jsx(Box, { marginTop: 1, children: _jsx(Text, { color: "green", bold: true, children: "\u2713 Launching Claude orchestrator..." }) })] }));
}
function truncate(s, max) {
    if (s.length <= max)
        return s;
    return s.slice(0, max - 1) + "…";
}

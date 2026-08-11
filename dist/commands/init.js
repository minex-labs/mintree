import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import * as fs from "fs";
import { option } from "pastel";
import { z } from "zod";
import { findMainRepoRoot, getMintreeDir, getMetadataPath, getWorktreesDir, getSessionStatesDir, ensureGitignoreEntries, isGitTracked, } from "../lib/git.js";
export const description = "Initialize the current repo for mintree (creates .mintree/, updates .gitignore)";
export const options = z.object({
    provider: z
        .enum(["github", "linear"])
        .default("github")
        .describe(option({
        description: "Issue provider to scaffold for (default: github)",
    })),
    workspace: z
        .string()
        .optional()
        .describe(option({
        description: "Linear workspace URL key (required when --provider linear)",
    })),
    team: z
        .array(z.string())
        .optional()
        .describe(option({
        description: "Linear team key (repeatable, e.g. --team FE --team BE)",
    })),
    apiUrl: z
        .string()
        .optional()
        .describe(option({
        description: "Linear GraphQL endpoint (default: https://api.linear.app/graphql; override only for self-hosted/proxy)",
    })),
});
function buildMetadataTemplate(opts) {
    const base = {
        version: 1,
        provider: opts.provider,
        issues: {},
    };
    if (opts.provider === "linear") {
        const teams = (opts.team ?? []).map((key) => ({ key }));
        base["linear"] = {
            apiUrl: opts.apiUrl ?? "https://api.linear.app/graphql",
            workspaceSlug: opts.workspace ?? "FILL-IN-WORKSPACE-SLUG",
            // Empty by default unless --team was passed — user fills in their
            // teams before mintree can list assigned work items. Doctor will
            // surface this gap.
            teams,
        };
    }
    return base;
}
function ensureDir(p, label, steps) {
    if (fs.existsSync(p)) {
        steps.push({ kind: "exists", label });
    }
    else {
        fs.mkdirSync(p, { recursive: true });
        steps.push({ kind: "created", label });
    }
}
function ensureMetadata(metadataPath, opts, steps) {
    if (fs.existsSync(metadataPath)) {
        steps.push({ kind: "exists", label: ".mintree/metadata.json" });
        return;
    }
    const template = buildMetadataTemplate(opts);
    fs.writeFileSync(metadataPath, JSON.stringify(template, null, 2) + "\n");
    steps.push({ kind: "created", label: ".mintree/metadata.json" });
}
function runInit(opts) {
    const root = findMainRepoRoot();
    if (!root) {
        return {
            ok: false,
            message: "Not in a git repository.",
            hint: "Run `git init` first, then re-run `mintree init`.",
        };
    }
    if (opts.provider === "linear" && (!opts.workspace || opts.workspace.length === 0)) {
        // Allow it to proceed with a FILL-IN placeholder so the user gets a
        // working scaffold to edit, but flag it loudly via a warn step below.
    }
    const steps = [];
    const mintreeDir = getMintreeDir(root);
    const worktreesDir = getWorktreesDir(root);
    const sessionStatesDir = getSessionStatesDir(root);
    const metadataPath = getMetadataPath(root);
    ensureDir(mintreeDir, ".mintree/", steps);
    ensureDir(worktreesDir, ".mintree/worktrees/", steps);
    ensureDir(sessionStatesDir, ".mintree/session-states/", steps);
    ensureMetadata(metadataPath, opts, steps);
    // metadata.json holds the per-issue session_id, which is local-only by
    // nature (each dev gets their own UUIDs from `claude`). Versioning it
    // would only generate noise + merge conflicts, so it's gitignored along
    // with the worktrees and session-states directories.
    const ignoreCandidates = [
        ".mintree/worktrees/",
        ".mintree/session-states/",
        ".mintree/metadata.json",
    ];
    const added = ensureGitignoreEntries(root, ignoreCandidates);
    for (const entry of ignoreCandidates) {
        steps.push({
            kind: added.includes(entry) ? "added" : "ignored",
            label: `${entry} → .gitignore`,
        });
    }
    // If metadata.json was committed before being gitignored (likely on a
    // repo that ran an earlier mintree version), gitignore alone won't
    // stop git from tracking it. Surface an actionable hint so the user
    // knows exactly what to run.
    if (isGitTracked(".mintree/metadata.json", root)) {
        steps.push({
            kind: "warn",
            label: ".mintree/metadata.json is currently tracked by git",
            hint: "Run: git rm --cached .mintree/metadata.json && git commit -m 'chore: untrack mintree metadata'",
        });
    }
    // Linear scaffolds may be incomplete — workspaceSlug could be a placeholder
    // and teams[] empty if no --team flags were passed. Tell the user exactly
    // what to fix before doctor will pass.
    if (opts.provider === "linear") {
        const needs = [];
        if (!opts.workspace || opts.workspace.length === 0) {
            needs.push("workspaceSlug");
        }
        if (!opts.team || opts.team.length === 0) {
            needs.push("teams[] (add at least one { key, name? })");
        }
        if (needs.length > 0) {
            steps.push({
                kind: "warn",
                label: "Linear scaffold needs manual edits",
                hint: `Edit ${metadataPath} and fill in: ${needs.join(", ")}`,
            });
        }
    }
    return { ok: true, repoRoot: root, provider: opts.provider, steps };
}
function StepIcon({ kind }) {
    switch (kind) {
        case "created":
        case "added":
            return _jsx(Text, { color: "green", children: "\u2713" });
        case "exists":
        case "ignored":
            return _jsx(Text, { color: "cyan", children: "\u25CB" });
        case "warn":
            return _jsx(Text, { color: "yellow", children: "!" });
    }
}
function stepDetail(kind) {
    switch (kind) {
        case "created":
            return "created";
        case "exists":
            return "already exists";
        case "added":
            return "added";
        case "ignored":
            return "already ignored";
        case "warn":
            return null;
    }
}
export default function Init({ options: opts }) {
    const [result, setResult] = useState(null);
    useEffect(() => {
        // Defer one tick so the initial render with the spinner gets to paint.
        setTimeout(() => {
            try {
                setResult(runInit({
                    provider: opts.provider,
                    workspace: opts.workspace,
                    team: opts.team,
                    apiUrl: opts.apiUrl,
                }));
            }
            catch (err) {
                setResult({
                    ok: false,
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        }, 0);
    }, [opts.provider, opts.workspace, opts.team, opts.apiUrl]);
    if (!result) {
        return (_jsxs(Box, { children: [_jsx(Text, { color: "cyan", children: _jsx(Spinner, { type: "dots" }) }), _jsx(Text, { children: " Initializing mintree..." })] }));
    }
    if (!result.ok) {
        return (_jsxs(Box, { flexDirection: "column", padding: 1, children: [_jsxs(Text, { color: "red", bold: true, children: ["\u2717 ", result.message] }), result.hint && (_jsx(Box, { marginTop: 1, children: _jsxs(Text, { color: "yellow", children: ["\u21B3 ", result.hint] }) }))] }));
    }
    const anyChange = result.steps.some((s) => s.kind === "created" || s.kind === "added");
    return (_jsxs(Box, { flexDirection: "column", padding: 1, children: [_jsxs(Box, { marginBottom: 1, children: [_jsx(Text, { bold: true, color: "cyan", children: "mintree init" }), _jsx(Text, { dimColor: true, children: ` · ${result.repoRoot}` }), _jsx(Text, { dimColor: true, children: ` · provider=${result.provider}` })] }), result.steps.map((step, i) => {
                const detail = stepDetail(step.kind);
                return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { children: [_jsx(StepIcon, { kind: step.kind }), _jsx(Text, { children: " " }), _jsx(Text, { children: step.label }), detail && _jsxs(Text, { dimColor: true, children: [" (", detail, ")"] })] }), step.hint && (_jsx(Box, { marginLeft: 2, children: _jsxs(Text, { color: "yellow", children: ["\u21B3 ", step.hint] }) }))] }, i));
            }), _jsx(Box, { marginTop: 1, children: anyChange ? (_jsxs(Text, { color: "green", children: ["mintree initialized. Run ", _jsx(Text, { bold: true, children: "mintree doctor" }), " to verify the rest of your setup."] })) : (_jsx(Text, { color: "cyan", children: "mintree was already initialized \u2014 nothing to do." })) })] }));
}

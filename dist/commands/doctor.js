import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import * as fs from "fs";
import * as path from "path";
import { createRequire } from "module";
import { tryExec, getPath } from "../lib/exec.js";
import { ghCliAvailable, getGhUserLogin, getRepoFullName } from "../lib/gh.js";
import { getGhTokenScopes, hasProjectScope } from "../lib/providers/github.js";
import { checkLinearSetup } from "../lib/providers/linear.js";
import { readMetadata } from "../lib/metadata.js";
import { resolveClaudeBinary } from "../lib/claude.js";
import { findMainRepoRoot, getMintreeDir, getInitScriptPath, isGitIgnored, isExecutable, pathExists, } from "../lib/git.js";
const require = createRequire(import.meta.url);
const { version } = require("../../package.json");
export const description = "Check system requirements and Claude Code integrations";
async function checkTool(name, description, required, versionCommand, hint) {
    const binPath = await getPath(name);
    if (!binPath) {
        return { name, description, required, installed: false, hint };
    }
    const ver = await tryExec(versionCommand);
    return {
        name,
        description,
        required,
        installed: true,
        version: ver || "unknown",
        path: binPath,
    };
}
async function checkClaude() {
    const resolved = resolveClaudeBinary();
    if (!resolved) {
        return {
            name: "claude",
            description: "Claude Code CLI",
            required: true,
            installed: false,
            hint: "Install: npm install -g @anthropic-ai/claude-code",
        };
    }
    const ver = await tryExec(`"${resolved}" --version 2>/dev/null | head -1`);
    return {
        name: "claude",
        description: "Claude Code CLI",
        required: true,
        installed: true,
        version: ver || "unknown",
        path: resolved,
    };
}
async function checkGh(provider) {
    // When provider=linear, gh is only used for PR detection on worktree
    // branches — still useful, but not strictly required for the issue flow.
    const description = provider === "linear"
        ? "GitHub CLI (for PR status on worktrees)"
        : "GitHub CLI for issues + PRs";
    const required = provider !== "linear";
    const binPath = await getPath("gh");
    if (!binPath) {
        return {
            name: "gh",
            description,
            required,
            installed: false,
            hint: "Install: brew install gh && gh auth login",
        };
    }
    const ver = await tryExec("gh --version | head -1");
    const login = await getGhUserLogin();
    if (!login) {
        return {
            name: "gh",
            description,
            required,
            installed: true,
            version: ver || "unknown",
            path: binPath,
            hint: "Run: gh auth login",
        };
    }
    return {
        name: "gh",
        description,
        required,
        installed: true,
        version: ver || "unknown",
        path: binPath,
        authStatus: `Authenticated as ${login}`,
    };
}
async function checkGithubIssues() {
    const inGitRepo = findMainRepoRoot() !== null;
    if (!(await ghCliAvailable())) {
        return {
            authenticated: false,
            inGitRepo,
            hint: "Install: brew install gh && gh auth login",
        };
    }
    const login = await getGhUserLogin();
    if (!login) {
        return { authenticated: false, inGitRepo, hint: "Run: gh auth login" };
    }
    if (!inGitRepo) {
        // Auth is fine; we're just not in a repo. Don't flag this as a failure.
        return { authenticated: true, accountName: login, inGitRepo, repoName: null };
    }
    const repoName = await getRepoFullName();
    return {
        authenticated: true,
        accountName: login,
        repoName,
        inGitRepo,
        hint: !repoName
            ? "Current repo is not on GitHub (gh repo view failed in this directory)"
            : undefined,
    };
}
async function checkProjectScope() {
    const scopes = await getGhTokenScopes();
    if (scopes === null) {
        // Auth/install issue — surfaced by the gh row already.
        return { scopes: null, hasScope: false };
    }
    const ok = hasProjectScope(scopes);
    return {
        scopes,
        hasScope: ok,
        hint: ok ? undefined : "Run: gh auth refresh -s project",
    };
}
function checkRemoteControl() {
    const home = process.env["HOME"] || "";
    const configPath = path.join(home, ".claude.json");
    try {
        if (fs.existsSync(configPath)) {
            const content = fs.readFileSync(configPath, "utf-8");
            const config = JSON.parse(content);
            if (config.remoteControlAtStartup === true) {
                return { enabled: true };
            }
        }
    }
    catch {
        // JSON parse error or read error — fall through to disabled.
    }
    return {
        enabled: false,
        hint: 'Run /config in Claude Code and enable "Enable Remote Control for all sessions"',
    };
}
function checkSessionSignalHooks() {
    const home = process.env["HOME"] || "";
    const settingsPath = path.join(home, ".claude", "settings.json");
    const requiredEvents = ["Notification", "Stop", "UserPromptSubmit", "SessionEnd"];
    const missing = [];
    try {
        if (!fs.existsSync(settingsPath)) {
            return {
                configured: false,
                missingHooks: requiredEvents,
                hint: "Run: mintree helpers session-signal install",
            };
        }
        const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
        const hooks = settings.hooks || {};
        for (const event of requiredEvents) {
            const eventHooks = hooks[event];
            if (!Array.isArray(eventHooks)) {
                missing.push(event);
                continue;
            }
            const found = eventHooks.some((entry) => {
                const inner = entry.hooks || [];
                return inner.some((h) => typeof h.command === "string" && h.command.includes("mintree helpers session-signal"));
            });
            if (!found)
                missing.push(event);
        }
    }
    catch {
        return {
            configured: false,
            missingHooks: requiredEvents,
            hint: "Could not parse ~/.claude/settings.json. Run: mintree helpers session-signal install",
        };
    }
    if (missing.length === 0) {
        return { configured: true, missingHooks: [] };
    }
    return {
        configured: false,
        missingHooks: missing,
        hint: "Run: mintree helpers session-signal install",
    };
}
function checkShellIntegration() {
    const shellEnv = process.env["SHELL"] || "";
    const shell = shellEnv.includes("zsh") ? "zsh" : shellEnv.includes("bash") ? "bash" : null;
    const configured = process.env["MINTREE_SHELL_INTEGRATION"] === "1";
    return { configured, shell };
}
function checkMintreeSetup() {
    const root = findMainRepoRoot();
    if (!root) {
        return {
            isGitRepo: false,
            mintreeFolderExists: false,
            metadataExists: false,
            initShExists: false,
            initShExecutable: false,
            worktreesIgnored: false,
            sessionStatesIgnored: false,
            hints: ["Not in a git repository — run `git init` first, then `mintree init`."],
        };
    }
    const mintreeDir = getMintreeDir(root);
    const metadataPath = path.join(mintreeDir, "metadata.json");
    const initShPath = getInitScriptPath(root);
    const mintreeFolderExists = pathExists(mintreeDir);
    const metadataExists = pathExists(metadataPath);
    const initShExists = pathExists(initShPath);
    const initShExecutable = initShExists && isExecutable(initShPath);
    const worktreesIgnored = isGitIgnored(".mintree/worktrees", root);
    const sessionStatesIgnored = isGitIgnored(".mintree/session-states", root);
    const hints = [];
    if (!mintreeFolderExists) {
        hints.push("Run: mintree init");
    }
    else {
        if (!metadataExists)
            hints.push("Missing .mintree/metadata.json — run: mintree init");
        if (!worktreesIgnored)
            hints.push("Add `.mintree/worktrees/` to .gitignore");
        if (!sessionStatesIgnored)
            hints.push("Add `.mintree/session-states/` to .gitignore");
        if (initShExists && !initShExecutable) {
            hints.push(`Make init.sh executable: chmod +x ${initShPath}`);
        }
    }
    return {
        isGitRepo: true,
        mainRepoRoot: root,
        mintreeFolderExists,
        metadataExists,
        initShExists,
        initShExecutable,
        worktreesIgnored,
        sessionStatesIgnored,
        hints,
    };
}
function StatusIcon({ ok, required }) {
    if (ok)
        return _jsx(Text, { color: "green", children: "\u2713" });
    return required ? _jsx(Text, { color: "red", children: "\u2717" }) : _jsx(Text, { color: "yellow", children: "\u25CB" });
}
function ToolRow({ tool }) {
    return (_jsxs(Box, { flexDirection: "column", marginBottom: 1, children: [_jsxs(Box, { children: [_jsx(StatusIcon, { ok: tool.installed && !tool.hint, required: tool.required }), _jsx(Text, { children: " " }), _jsx(Text, { bold: true, children: tool.name }), _jsxs(Text, { dimColor: true, children: [" - ", tool.description] }), !tool.required && _jsx(Text, { dimColor: true, children: " (optional)" })] }), tool.installed ? (_jsxs(Box, { marginLeft: 2, flexDirection: "column", children: [_jsxs(Text, { dimColor: true, children: ["Version: ", tool.version] }), tool.path && _jsxs(Text, { dimColor: true, children: ["Path: ", tool.path] }), tool.authStatus && _jsxs(Text, { dimColor: true, children: ["Auth: ", tool.authStatus] }), tool.hint && _jsxs(Text, { color: "yellow", children: ["\u21B3 ", tool.hint] })] })) : (_jsx(Box, { marginLeft: 2, children: _jsxs(Text, { color: "yellow", children: ["\u21B3 ", tool.hint] }) }))] }));
}
function ProjectScopeRow({ status }) {
    // Optional — auto-discovery still works for the "list issues" path even
    // without the `project` scope; the scope only matters when we need to
    // write status back to a Project v2 board (the `w` flow does this).
    if (status.scopes === null) {
        // gh not installed / not authenticated — handled by the gh row.
        return null;
    }
    return (_jsxs(Box, { flexDirection: "column", marginBottom: 1, children: [_jsxs(Box, { children: [_jsx(StatusIcon, { ok: status.hasScope, required: false }), _jsx(Text, { children: " " }), _jsx(Text, { bold: true, children: "GitHub Project v2 Scope" }), _jsx(Text, { dimColor: true, children: " - lets `w` move the issue to In Progress" }), _jsx(Text, { dimColor: true, children: " (optional)" })] }), _jsxs(Box, { marginLeft: 2, flexDirection: "column", children: [_jsxs(Text, { dimColor: true, children: ["Token scopes: ", status.scopes.join(", ") || "(none)"] }), status.hint && _jsxs(Text, { color: "yellow", children: ["\u21B3 ", status.hint] })] })] }));
}
function LinearRow({ status }) {
    const ok = status.configured &&
        status.hasApiKey &&
        status.authOk &&
        status.teams.length > 0 &&
        status.teams.every((t) => t.ok);
    const required = status.configured;
    return (_jsxs(Box, { flexDirection: "column", marginBottom: 1, children: [_jsxs(Box, { children: [_jsx(StatusIcon, { ok: ok, required: required }), _jsx(Text, { children: " " }), _jsx(Text, { bold: true, children: "Linear" }), _jsx(Text, { dimColor: true, children: " - issue listing + In Progress transition" })] }), _jsxs(Box, { marginLeft: 2, flexDirection: "column", children: [_jsxs(Text, { dimColor: true, children: ["API key: ", status.hasApiKey ? "loaded" : "missing", status.authOk && status.user ? ` · user: ${status.user}` : ""] }), status.workspaceSlug && (_jsxs(Text, { dimColor: true, children: ["Workspace: ", status.workspaceSlug, status.apiUrl ? ` (${status.apiUrl})` : ""] })), status.teams.length > 0 ? (status.teams.map((t) => (_jsxs(Text, { dimColor: true, children: [t.ok ? "✓" : "✗", " team ", t.key, t.name ? ` (${t.name})` : "", t.error ? ` — ${t.error}` : ""] }, t.key)))) : (_jsx(Text, { dimColor: true, children: "No teams configured" })), status.hint && _jsxs(Text, { color: "yellow", children: ["\u21B3 ", status.hint] })] })] }));
}
function GithubIssuesRow({ gh }) {
    // Required only when we're inside a git repo. Outside one, the row is
    // purely informational (auth check) so doctor can stay green when run
    // from $HOME or any non-repo directory.
    const required = gh.inGitRepo;
    const ok = required ? gh.authenticated && !!gh.repoName : gh.authenticated;
    return (_jsxs(Box, { flexDirection: "column", marginBottom: 1, children: [_jsxs(Box, { children: [_jsx(StatusIcon, { ok: ok, required: required }), _jsx(Text, { children: " " }), _jsx(Text, { bold: true, children: "GitHub Issues" }), _jsx(Text, { dimColor: true, children: " - issue listing + PR ops" }), !required && _jsx(Text, { dimColor: true, children: " (no repo here)" })] }), _jsxs(Box, { marginLeft: 2, flexDirection: "column", children: [gh.authenticated ? (_jsxs(_Fragment, { children: [_jsxs(Text, { dimColor: true, children: ["User: ", gh.accountName] }), required && _jsxs(Text, { dimColor: true, children: ["Repo: ", gh.repoName ?? "(not a GitHub repo)"] })] })) : (_jsx(Text, { dimColor: true, children: "Not authenticated" })), gh.hint && _jsxs(Text, { color: "yellow", children: ["\u21B3 ", gh.hint] })] })] }));
}
function ShellRow({ status }) {
    return (_jsxs(Box, { flexDirection: "column", marginBottom: 1, children: [_jsxs(Box, { children: [_jsx(StatusIcon, { ok: status.configured, required: true }), _jsx(Text, { children: " " }), _jsx(Text, { bold: true, children: "Shell Integration" }), _jsx(Text, { dimColor: true, children: " - enables `cd` into worktrees" })] }), _jsx(Box, { marginLeft: 2, flexDirection: "column", children: status.configured ? (_jsxs(Text, { dimColor: true, children: ["Shell: ", status.shell ?? "unknown", " (MINTREE_SHELL_INTEGRATION=1)"] })) : status.shell ? (_jsx(Text, { color: "yellow", children: `↳ Add to ~/.${status.shell}rc: eval "$(mintree helpers shell-init ${status.shell})"` })) : (_jsx(Text, { color: "yellow", children: "\u21B3 Unsupported shell. mintree shell integration supports zsh and bash." })) })] }));
}
function RemoteControlRow({ status }) {
    return (_jsxs(Box, { flexDirection: "column", marginBottom: 1, children: [_jsxs(Box, { children: [_jsx(StatusIcon, { ok: status.enabled, required: false }), _jsx(Text, { children: " " }), _jsx(Text, { bold: true, children: "Remote Control" }), _jsx(Text, { dimColor: true, children: " - resume Claude sessions from any device" }), _jsx(Text, { dimColor: true, children: " (optional)" })] }), _jsxs(Box, { marginLeft: 2, flexDirection: "column", children: [_jsxs(Text, { dimColor: true, children: ["Enabled: ", status.enabled ? "yes" : "no"] }), status.hint && _jsxs(Text, { color: "yellow", children: ["\u21B3 ", status.hint] })] })] }));
}
function SessionSignalRow({ status }) {
    return (_jsxs(Box, { flexDirection: "column", marginBottom: 1, children: [_jsxs(Box, { children: [_jsx(StatusIcon, { ok: status.configured, required: false }), _jsx(Text, { children: " " }), _jsx(Text, { bold: true, children: "Session Signal Hooks" }), _jsx(Text, { dimColor: true, children: " - live session state for the dashboard" }), _jsx(Text, { dimColor: true, children: " (optional)" })] }), _jsxs(Box, { marginLeft: 2, flexDirection: "column", children: [status.configured ? (_jsx(Text, { dimColor: true, children: "All 4 hooks configured" })) : (_jsxs(Text, { dimColor: true, children: ["Missing: ", status.missingHooks.join(", ")] })), status.hint && _jsxs(Text, { color: "yellow", children: ["\u21B3 ", status.hint] })] })] }));
}
function MintreeSetupRow({ status }) {
    if (!status.isGitRepo) {
        return (_jsxs(Box, { flexDirection: "column", marginBottom: 1, children: [_jsxs(Box, { children: [_jsx(StatusIcon, { ok: false, required: false }), _jsx(Text, { children: " " }), _jsx(Text, { bold: true, children: "Repo Setup" }), _jsx(Text, { dimColor: true, children: " - .mintree/ configuration" }), _jsx(Text, { dimColor: true, children: " (optional)" })] }), _jsxs(Box, { marginLeft: 2, flexDirection: "column", children: [_jsx(Text, { dimColor: true, children: "Not in a git repository" }), status.hints.map((h, i) => (_jsxs(Text, { color: "yellow", children: ["\u21B3 ", h] }, i)))] })] }));
    }
    const ok = status.mintreeFolderExists &&
        status.metadataExists &&
        status.worktreesIgnored &&
        status.sessionStatesIgnored &&
        (!status.initShExists || status.initShExecutable);
    return (_jsxs(Box, { flexDirection: "column", marginBottom: 1, children: [_jsxs(Box, { children: [_jsx(StatusIcon, { ok: ok, required: false }), _jsx(Text, { children: " " }), _jsx(Text, { bold: true, children: "Repo Setup" }), _jsx(Text, { dimColor: true, children: " - .mintree/ configuration" }), _jsx(Text, { dimColor: true, children: " (optional)" })] }), _jsxs(Box, { marginLeft: 2, flexDirection: "column", children: [_jsxs(Text, { dimColor: true, children: ["Main repo: ", status.mainRepoRoot] }), _jsxs(Text, { dimColor: true, children: [".mintree/: ", status.mintreeFolderExists ? "exists" : "missing"] }), status.mintreeFolderExists && (_jsxs(_Fragment, { children: [_jsxs(Text, { dimColor: true, children: ["metadata.json: ", status.metadataExists ? "exists" : "missing"] }), _jsxs(Text, { dimColor: true, children: ["init.sh:", " ", status.initShExists
                                        ? status.initShExecutable
                                            ? "executable"
                                            : "not executable"
                                        : "not present (optional)"] }), _jsxs(Text, { dimColor: true, children: [".mintree/worktrees ignored: ", status.worktreesIgnored ? "yes" : "no"] }), _jsxs(Text, { dimColor: true, children: [".mintree/session-states ignored: ", status.sessionStatesIgnored ? "yes" : "no"] })] })), status.hints.map((h, i) => (_jsxs(Text, { color: "yellow", children: ["\u21B3 ", h] }, i)))] })] }));
}
export default function Doctor() {
    const [tools, setTools] = useState(null);
    const [gh, setGh] = useState(null);
    const [projectScope, setProjectScope] = useState(null);
    const [linear, setLinear] = useState(null);
    const [rc, setRc] = useState(null);
    const [hooks, setHooks] = useState(null);
    const [setup, setSetup] = useState(null);
    const [shell, setShell] = useState(null);
    // Provider drives which integration rows appear + tweaks the gh row's
    // description/required flag. Read once on mount; doctor doesn't react to
    // metadata changes mid-run.
    const [provider, setProvider] = useState(null);
    useEffect(() => {
        (async () => {
            const root = findMainRepoRoot();
            const resolvedProvider = root
                ? (readMetadata(root).provider ?? "github")
                : "github";
            setProvider(resolvedProvider);
            const toolResults = await Promise.all([
                checkTool("git", "Version control", true, "git --version | head -1", "Install: brew install git"),
                checkGh(resolvedProvider),
                checkClaude(),
                checkTool("tmux", "Open worktrees in separate windows", false, "tmux -V", "Install: brew install tmux"),
            ]);
            const mintreeRow = {
                name: "mintree",
                description: "this CLI",
                required: true,
                installed: true,
                version,
            };
            toolResults.unshift(mintreeRow);
            const nodeRow = {
                name: "node",
                description: "Node.js runtime (≥ 20)",
                required: true,
                installed: true,
                version: process.version,
            };
            toolResults.unshift(nodeRow);
            // GH-specific probes only matter when provider=github. For linear we
            // still need *some* value in state so the loading guard resolves, but
            // the row is hidden — populate with a default and skip the network.
            const ghRes = resolvedProvider === "github"
                ? await checkGithubIssues()
                : { authenticated: false, inGitRepo: false };
            const projectScopeRes = resolvedProvider === "github"
                ? await checkProjectScope()
                : { scopes: null, hasScope: false };
            // Linear probes only run when provider=linear. Always set state so the
            // loading guard resolves.
            const linearRes = resolvedProvider === "linear" && root
                ? await checkLinearSetup(root)
                : { configured: false, hasApiKey: false, authOk: false, teams: [] };
            setTools(toolResults);
            setGh(ghRes);
            setProjectScope(projectScopeRes);
            setLinear(linearRes);
            setRc(checkRemoteControl());
            setHooks(checkSessionSignalHooks());
            setSetup(checkMintreeSetup());
            setShell(checkShellIntegration());
        })();
    }, []);
    const loading = !tools || !gh || !projectScope || !linear || !rc || !hooks || !setup || !shell || !provider;
    if (loading) {
        return (_jsxs(Box, { children: [_jsx(Text, { color: "cyan", children: _jsx(Spinner, { type: "dots" }) }), _jsx(Text, { children: " Checking system requirements..." })] }));
    }
    const requiredMissing = tools.filter((t) => t.required && (!t.installed || t.hint));
    const optionalMissing = tools.filter((t) => !t.required && !t.installed);
    // Provider-specific OK check: when provider=github, the GH integration row
    // must pass (auth + repo); when provider=linear, the Linear row must pass
    // (api key + auth + at least one reachable team).
    const providerOk = provider === "linear"
        ? linear.configured &&
            linear.hasApiKey &&
            linear.authOk &&
            linear.teams.length > 0 &&
            linear.teams.every((t) => t.ok)
        : gh.inGitRepo
            ? gh.authenticated && !!gh.repoName
            : true;
    const shellOk = shell.configured;
    const allRequired = requiredMissing.length === 0 && providerOk && shellOk;
    const requiredFailing = requiredMissing.length + (providerOk ? 0 : 1) + (shellOk ? 0 : 1);
    return (_jsxs(Box, { flexDirection: "column", padding: 1, children: [_jsxs(Box, { marginBottom: 1, children: [_jsx(Text, { bold: true, color: "cyan", children: "Mintree Doctor" }), _jsxs(Text, { dimColor: true, children: [" v", version] })] }), _jsx(Box, { marginBottom: 1, flexDirection: "column", children: _jsx(Text, { bold: true, underline: true, children: "CLI Tools" }) }), tools.map((t) => (_jsx(ToolRow, { tool: t }, t.name))), _jsx(Box, { marginBottom: 1, marginTop: 1, flexDirection: "column", children: _jsx(Text, { bold: true, underline: true, children: "Integrations" }) }), provider === "linear" ? (_jsx(LinearRow, { status: linear })) : (_jsxs(_Fragment, { children: [_jsx(GithubIssuesRow, { gh: gh }), _jsx(ProjectScopeRow, { status: projectScope })] })), _jsx(ShellRow, { status: shell }), _jsx(MintreeSetupRow, { status: setup }), _jsx(Box, { marginBottom: 1, marginTop: 1, flexDirection: "column", children: _jsx(Text, { bold: true, underline: true, children: "Claude Code" }) }), _jsx(RemoteControlRow, { status: rc }), _jsx(SessionSignalRow, { status: hooks }), _jsx(Box, { marginTop: 1, borderStyle: "single", borderColor: allRequired ? "green" : "yellow", paddingX: 2, children: allRequired ? (_jsx(Text, { color: "green", children: "All required checks pass. mintree is ready to use." })) : (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { color: "yellow", children: [requiredFailing, " required item(s) need attention"] }), optionalMissing.length > 0 && (_jsxs(Text, { dimColor: true, children: [optionalMissing.length, " optional item(s) not installed"] }))] })) })] }));
}

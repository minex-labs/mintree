import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import * as fs from "fs";
import * as path from "path";
import { createRequire } from "module";

import { tryExec, getPath } from "../lib/exec.js";
import { ghCliAvailable, getGhUserLogin, getRepoFullName } from "../lib/gh.js";
import { getGhTokenScopes, hasProjectScope } from "../lib/providers/github.js";
import { checkLinearSetup, type LinearSetupCheck } from "../lib/providers/linear.js";
import { readMetadata, type ProviderKind } from "../lib/metadata.js";
import { resolveClaudeBinary } from "../lib/claude.js";
import {
	findMainRepoRoot,
	getMintreeDir,
	getInitScriptPath,
	isGitIgnored,
	isExecutable,
	pathExists,
} from "../lib/git.js";

const require = createRequire(import.meta.url);
const { version } = require("../../package.json");

export const description = "Check system requirements and Claude Code integrations";

type ToolStatus = {
	name: string;
	description: string;
	required: boolean;
	installed: boolean;
	version?: string;
	path?: string;
	authStatus?: string;
	hint?: string;
};

type GithubIssuesStatus = {
	authenticated: boolean;
	accountName?: string;
	repoName?: string | null;
	// True when the current cwd lives inside a git repo. When false the row is
	// shown as informational rather than a hard requirement — `mintree doctor`
	// should produce a green summary when run from an arbitrary directory if
	// the toolchain is otherwise healthy.
	inGitRepo: boolean;
	hint?: string;
};

type RemoteControlStatus = {
	enabled: boolean;
	hint?: string;
};

type ProjectScopeStatus = {
	// null when gh isn't installed / authenticated — the gh row above covers
	// those cases, so this row just stays informational.
	scopes: string[] | null;
	hasScope: boolean;
	hint?: string;
};

type SessionSignalStatus = {
	configured: boolean;
	missingHooks: string[];
	hint?: string;
};

type MintreeSetupStatus = {
	isGitRepo: boolean;
	mainRepoRoot?: string;
	mintreeFolderExists: boolean;
	metadataExists: boolean;
	initShExists: boolean;
	initShExecutable: boolean;
	worktreesIgnored: boolean;
	sessionStatesIgnored: boolean;
	hints: string[];
};

type ShellIntegrationStatus = {
	configured: boolean;
	shell: "zsh" | "bash" | null;
};

async function checkTool(
	name: string,
	description: string,
	required: boolean,
	versionCommand: string,
	hint: string,
): Promise<ToolStatus> {
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

async function checkClaude(): Promise<ToolStatus> {
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

async function checkGh(provider: ProviderKind): Promise<ToolStatus> {
	// When provider=linear, gh is only used for PR detection on worktree
	// branches — still useful, but not strictly required for the issue flow.
	const description =
		provider === "linear"
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

async function checkGithubIssues(): Promise<GithubIssuesStatus> {
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

async function checkProjectScope(): Promise<ProjectScopeStatus> {
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

function checkRemoteControl(): RemoteControlStatus {
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
	} catch {
		// JSON parse error or read error — fall through to disabled.
	}
	return {
		enabled: false,
		hint: 'Run /config in Claude Code and enable "Enable Remote Control for all sessions"',
	};
}

function checkSessionSignalHooks(): SessionSignalStatus {
	const home = process.env["HOME"] || "";
	const settingsPath = path.join(home, ".claude", "settings.json");

	const requiredEvents = ["Notification", "Stop", "UserPromptSubmit", "SessionEnd"];
	const missing: string[] = [];

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
			const found = eventHooks.some((entry: { hooks?: { command?: string }[] }) => {
				const inner = entry.hooks || [];
				return inner.some(
					(h) =>
						typeof h.command === "string" && h.command.includes("mintree helpers session-signal"),
				);
			});
			if (!found) missing.push(event);
		}
	} catch {
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

function checkShellIntegration(): ShellIntegrationStatus {
	const shellEnv = process.env["SHELL"] || "";
	const shell = shellEnv.includes("zsh") ? "zsh" : shellEnv.includes("bash") ? "bash" : null;
	const configured = process.env["MINTREE_SHELL_INTEGRATION"] === "1";
	return { configured, shell };
}

function checkMintreeSetup(): MintreeSetupStatus {
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

	const hints: string[] = [];
	if (!mintreeFolderExists) {
		hints.push("Run: mintree init");
	} else {
		if (!metadataExists) hints.push("Missing .mintree/metadata.json — run: mintree init");
		if (!worktreesIgnored) hints.push("Add `.mintree/worktrees/` to .gitignore");
		if (!sessionStatesIgnored) hints.push("Add `.mintree/session-states/` to .gitignore");
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

function StatusIcon({ ok, required }: { ok: boolean; required: boolean }) {
	if (ok) return <Text color="green">✓</Text>;
	return required ? <Text color="red">✗</Text> : <Text color="yellow">○</Text>;
}

function ToolRow({ tool }: { tool: ToolStatus }) {
	return (
		<Box flexDirection="column" marginBottom={1}>
			<Box>
				<StatusIcon ok={tool.installed && !tool.hint} required={tool.required} />
				<Text> </Text>
				<Text bold>{tool.name}</Text>
				<Text dimColor> - {tool.description}</Text>
				{!tool.required && <Text dimColor> (optional)</Text>}
			</Box>
			{tool.installed ? (
				<Box marginLeft={2} flexDirection="column">
					<Text dimColor>Version: {tool.version}</Text>
					{tool.path && <Text dimColor>Path: {tool.path}</Text>}
					{tool.authStatus && <Text dimColor>Auth: {tool.authStatus}</Text>}
					{tool.hint && <Text color="yellow">↳ {tool.hint}</Text>}
				</Box>
			) : (
				<Box marginLeft={2}>
					<Text color="yellow">↳ {tool.hint}</Text>
				</Box>
			)}
		</Box>
	);
}

function ProjectScopeRow({ status }: { status: ProjectScopeStatus }) {
	// Optional — auto-discovery still works for the "list issues" path even
	// without the `project` scope; the scope only matters when we need to
	// write status back to a Project v2 board (the `w` flow does this).
	if (status.scopes === null) {
		// gh not installed / not authenticated — handled by the gh row.
		return null;
	}
	return (
		<Box flexDirection="column" marginBottom={1}>
			<Box>
				<StatusIcon ok={status.hasScope} required={false} />
				<Text> </Text>
				<Text bold>GitHub Project v2 Scope</Text>
				<Text dimColor> - lets `w` move the issue to In Progress</Text>
				<Text dimColor> (optional)</Text>
			</Box>
			<Box marginLeft={2} flexDirection="column">
				<Text dimColor>Token scopes: {status.scopes.join(", ") || "(none)"}</Text>
				{status.hint && <Text color="yellow">↳ {status.hint}</Text>}
			</Box>
		</Box>
	);
}

function LinearRow({ status }: { status: LinearSetupCheck }) {
	const ok =
		status.configured &&
		status.hasApiKey &&
		status.authOk &&
		status.teams.length > 0 &&
		status.teams.every((t) => t.ok);
	const required = status.configured;
	return (
		<Box flexDirection="column" marginBottom={1}>
			<Box>
				<StatusIcon ok={ok} required={required} />
				<Text> </Text>
				<Text bold>Linear</Text>
				<Text dimColor> - issue listing + In Progress transition</Text>
			</Box>
			<Box marginLeft={2} flexDirection="column">
				<Text dimColor>
					API key: {status.hasApiKey ? "loaded" : "missing"}
					{status.authOk && status.user ? ` · user: ${status.user}` : ""}
				</Text>
				{status.workspaceSlug && (
					<Text dimColor>
						Workspace: {status.workspaceSlug}
						{status.apiUrl ? ` (${status.apiUrl})` : ""}
					</Text>
				)}
				{status.teams.length > 0 ? (
					status.teams.map((t) => (
						<Text key={t.key} dimColor>
							{t.ok ? "✓" : "✗"} team {t.key}
							{t.name ? ` (${t.name})` : ""}
							{t.error ? ` — ${t.error}` : ""}
						</Text>
					))
				) : (
					<Text dimColor>No teams configured</Text>
				)}
				{status.hint && <Text color="yellow">↳ {status.hint}</Text>}
			</Box>
		</Box>
	);
}

function GithubIssuesRow({ gh }: { gh: GithubIssuesStatus }) {
	// Required only when we're inside a git repo. Outside one, the row is
	// purely informational (auth check) so doctor can stay green when run
	// from $HOME or any non-repo directory.
	const required = gh.inGitRepo;
	const ok = required ? gh.authenticated && !!gh.repoName : gh.authenticated;
	return (
		<Box flexDirection="column" marginBottom={1}>
			<Box>
				<StatusIcon ok={ok} required={required} />
				<Text> </Text>
				<Text bold>GitHub Issues</Text>
				<Text dimColor> - issue listing + PR ops</Text>
				{!required && <Text dimColor> (no repo here)</Text>}
			</Box>
			<Box marginLeft={2} flexDirection="column">
				{gh.authenticated ? (
					<>
						<Text dimColor>User: {gh.accountName}</Text>
						{required && <Text dimColor>Repo: {gh.repoName ?? "(not a GitHub repo)"}</Text>}
					</>
				) : (
					<Text dimColor>Not authenticated</Text>
				)}
				{gh.hint && <Text color="yellow">↳ {gh.hint}</Text>}
			</Box>
		</Box>
	);
}

function ShellRow({ status }: { status: ShellIntegrationStatus }) {
	return (
		<Box flexDirection="column" marginBottom={1}>
			<Box>
				<StatusIcon ok={status.configured} required={true} />
				<Text> </Text>
				<Text bold>Shell Integration</Text>
				<Text dimColor> - enables `cd` into worktrees</Text>
			</Box>
			<Box marginLeft={2} flexDirection="column">
				{status.configured ? (
					<Text dimColor>Shell: {status.shell ?? "unknown"} (MINTREE_SHELL_INTEGRATION=1)</Text>
				) : status.shell ? (
					<Text color="yellow">
						{`↳ Add to ~/.${status.shell}rc: eval "$(mintree helpers shell-init ${status.shell})"`}
					</Text>
				) : (
					<Text color="yellow">
						↳ Unsupported shell. mintree shell integration supports zsh and bash.
					</Text>
				)}
			</Box>
		</Box>
	);
}

function RemoteControlRow({ status }: { status: RemoteControlStatus }) {
	return (
		<Box flexDirection="column" marginBottom={1}>
			<Box>
				<StatusIcon ok={status.enabled} required={false} />
				<Text> </Text>
				<Text bold>Remote Control</Text>
				<Text dimColor> - resume Claude sessions from any device</Text>
				<Text dimColor> (optional)</Text>
			</Box>
			<Box marginLeft={2} flexDirection="column">
				<Text dimColor>Enabled: {status.enabled ? "yes" : "no"}</Text>
				{status.hint && <Text color="yellow">↳ {status.hint}</Text>}
			</Box>
		</Box>
	);
}

function SessionSignalRow({ status }: { status: SessionSignalStatus }) {
	return (
		<Box flexDirection="column" marginBottom={1}>
			<Box>
				<StatusIcon ok={status.configured} required={false} />
				<Text> </Text>
				<Text bold>Session Signal Hooks</Text>
				<Text dimColor> - live session state for the dashboard</Text>
				<Text dimColor> (optional)</Text>
			</Box>
			<Box marginLeft={2} flexDirection="column">
				{status.configured ? (
					<Text dimColor>All 4 hooks configured</Text>
				) : (
					<Text dimColor>Missing: {status.missingHooks.join(", ")}</Text>
				)}
				{status.hint && <Text color="yellow">↳ {status.hint}</Text>}
			</Box>
		</Box>
	);
}

function MintreeSetupRow({ status }: { status: MintreeSetupStatus }) {
	if (!status.isGitRepo) {
		return (
			<Box flexDirection="column" marginBottom={1}>
				<Box>
					<StatusIcon ok={false} required={false} />
					<Text> </Text>
					<Text bold>Repo Setup</Text>
					<Text dimColor> - .mintree/ configuration</Text>
					<Text dimColor> (optional)</Text>
				</Box>
				<Box marginLeft={2} flexDirection="column">
					<Text dimColor>Not in a git repository</Text>
					{status.hints.map((h, i) => (
						<Text key={i} color="yellow">
							↳ {h}
						</Text>
					))}
				</Box>
			</Box>
		);
	}
	const ok =
		status.mintreeFolderExists &&
		status.metadataExists &&
		status.worktreesIgnored &&
		status.sessionStatesIgnored &&
		(!status.initShExists || status.initShExecutable);
	return (
		<Box flexDirection="column" marginBottom={1}>
			<Box>
				<StatusIcon ok={ok} required={false} />
				<Text> </Text>
				<Text bold>Repo Setup</Text>
				<Text dimColor> - .mintree/ configuration</Text>
				<Text dimColor> (optional)</Text>
			</Box>
			<Box marginLeft={2} flexDirection="column">
				<Text dimColor>Main repo: {status.mainRepoRoot}</Text>
				<Text dimColor>.mintree/: {status.mintreeFolderExists ? "exists" : "missing"}</Text>
				{status.mintreeFolderExists && (
					<>
						<Text dimColor>metadata.json: {status.metadataExists ? "exists" : "missing"}</Text>
						<Text dimColor>
							init.sh:{" "}
							{status.initShExists
								? status.initShExecutable
									? "executable"
									: "not executable"
								: "not present (optional)"}
						</Text>
						<Text dimColor>
							.mintree/worktrees ignored: {status.worktreesIgnored ? "yes" : "no"}
						</Text>
						<Text dimColor>
							.mintree/session-states ignored: {status.sessionStatesIgnored ? "yes" : "no"}
						</Text>
					</>
				)}
				{status.hints.map((h, i) => (
					<Text key={i} color="yellow">
						↳ {h}
					</Text>
				))}
			</Box>
		</Box>
	);
}

export default function Doctor() {
	const [tools, setTools] = useState<ToolStatus[] | null>(null);
	const [gh, setGh] = useState<GithubIssuesStatus | null>(null);
	const [projectScope, setProjectScope] = useState<ProjectScopeStatus | null>(null);
	const [linear, setLinear] = useState<LinearSetupCheck | null>(null);
	const [rc, setRc] = useState<RemoteControlStatus | null>(null);
	const [hooks, setHooks] = useState<SessionSignalStatus | null>(null);
	const [setup, setSetup] = useState<MintreeSetupStatus | null>(null);
	const [shell, setShell] = useState<ShellIntegrationStatus | null>(null);
	// Provider drives which integration rows appear + tweaks the gh row's
	// description/required flag. Read once on mount; doctor doesn't react to
	// metadata changes mid-run.
	const [provider, setProvider] = useState<ProviderKind | null>(null);

	useEffect(() => {
		(async () => {
			const root = findMainRepoRoot();
			const resolvedProvider: ProviderKind = root
				? (readMetadata(root).provider ?? "github")
				: "github";
			setProvider(resolvedProvider);

			const toolResults = await Promise.all([
				checkTool(
					"git",
					"Version control",
					true,
					"git --version | head -1",
					"Install: brew install git",
				),
				checkGh(resolvedProvider),
				checkClaude(),
				checkTool(
					"tmux",
					"Open worktrees in separate windows",
					false,
					"tmux -V",
					"Install: brew install tmux",
				),
			]);

			const mintreeRow: ToolStatus = {
				name: "mintree",
				description: "this CLI",
				required: true,
				installed: true,
				version,
			};
			toolResults.unshift(mintreeRow);

			const nodeRow: ToolStatus = {
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
			const ghRes =
				resolvedProvider === "github"
					? await checkGithubIssues()
					: ({ authenticated: false, inGitRepo: false } satisfies GithubIssuesStatus);
			const projectScopeRes =
				resolvedProvider === "github"
					? await checkProjectScope()
					: ({ scopes: null, hasScope: false } satisfies ProjectScopeStatus);

			// Linear probes only run when provider=linear. Always set state so the
			// loading guard resolves.
			const linearRes: LinearSetupCheck =
				resolvedProvider === "linear" && root
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

	const loading =
		!tools || !gh || !projectScope || !linear || !rc || !hooks || !setup || !shell || !provider;

	if (loading) {
		return (
			<Box>
				<Text color="cyan">
					<Spinner type="dots" />
				</Text>
				<Text> Checking system requirements...</Text>
			</Box>
		);
	}

	const requiredMissing = tools.filter((t) => t.required && (!t.installed || t.hint));
	const optionalMissing = tools.filter((t) => !t.required && !t.installed);
	// Provider-specific OK check: when provider=github, the GH integration row
	// must pass (auth + repo); when provider=linear, the Linear row must pass
	// (api key + auth + at least one reachable team).
	const providerOk =
		provider === "linear"
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

	return (
		<Box flexDirection="column" padding={1}>
			<Box marginBottom={1}>
				<Text bold color="cyan">
					Mintree Doctor
				</Text>
				<Text dimColor> v{version}</Text>
			</Box>

			<Box marginBottom={1} flexDirection="column">
				<Text bold underline>
					CLI Tools
				</Text>
			</Box>
			{tools.map((t) => (
				<ToolRow key={t.name} tool={t} />
			))}

			<Box marginBottom={1} marginTop={1} flexDirection="column">
				<Text bold underline>
					Integrations
				</Text>
			</Box>
			{provider === "linear" ? (
				<LinearRow status={linear} />
			) : (
				<>
					<GithubIssuesRow gh={gh} />
					<ProjectScopeRow status={projectScope} />
				</>
			)}
			<ShellRow status={shell} />
			<MintreeSetupRow status={setup} />

			<Box marginBottom={1} marginTop={1} flexDirection="column">
				<Text bold underline>
					Claude Code
				</Text>
			</Box>
			<RemoteControlRow status={rc} />
			<SessionSignalRow status={hooks} />

			<Box
				marginTop={1}
				borderStyle="single"
				borderColor={allRequired ? "green" : "yellow"}
				paddingX={2}
			>
				{allRequired ? (
					<Text color="green">All required checks pass. mintree is ready to use.</Text>
				) : (
					<Box flexDirection="column">
						<Text color="yellow">{requiredFailing} required item(s) need attention</Text>
						{optionalMissing.length > 0 && (
							<Text dimColor>{optionalMissing.length} optional item(s) not installed</Text>
						)}
					</Box>
				)}
			</Box>
		</Box>
	);
}

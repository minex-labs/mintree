import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import * as fs from "fs";
import { option } from "pastel";
import { z } from "zod";

import {
	findMainRepoRoot,
	getMintreeDir,
	getMetadataPath,
	getWorktreesDir,
	getSessionStatesDir,
	ensureGitignoreEntries,
	isGitTracked,
} from "../lib/git.js";

export const description =
	"Initialize the current repo for mintree (creates .mintree/, updates .gitignore)";

export const options = z.object({
	provider: z
		.enum(["github", "linear"])
		.default("github")
		.describe(
			option({
				description: "Issue provider to scaffold for (default: github)",
			}),
		),
	workspace: z
		.string()
		.optional()
		.describe(
			option({
				description: "Linear workspace URL key (required when --provider linear)",
			}),
		),
	team: z
		.array(z.string())
		.optional()
		.describe(
			option({
				description: "Linear team key (repeatable, e.g. --team FE --team BE)",
			}),
		),
	apiUrl: z
		.string()
		.optional()
		.describe(
			option({
				description:
					"Linear GraphQL endpoint (default: https://api.linear.app/graphql; override only for self-hosted/proxy)",
			}),
		),
});

type Props = {
	options: z.infer<typeof options>;
};

type StepKind = "created" | "exists" | "added" | "ignored" | "warn";

type Step = {
	kind: StepKind;
	label: string;
	hint?: string;
};

type Result =
	| { ok: true; repoRoot: string; provider: "github" | "linear"; steps: Step[] }
	| { ok: false; message: string; hint?: string };

type ScaffoldOpts = {
	provider: "github" | "linear";
	workspace?: string;
	team?: string[];
	apiUrl?: string;
};

function buildMetadataTemplate(opts: ScaffoldOpts): Record<string, unknown> {
	const base: Record<string, unknown> = {
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

function ensureDir(p: string, label: string, steps: Step[]) {
	if (fs.existsSync(p)) {
		steps.push({ kind: "exists", label });
	} else {
		fs.mkdirSync(p, { recursive: true });
		steps.push({ kind: "created", label });
	}
}

function ensureMetadata(metadataPath: string, opts: ScaffoldOpts, steps: Step[]) {
	if (fs.existsSync(metadataPath)) {
		steps.push({ kind: "exists", label: ".mintree/metadata.json" });
		return;
	}
	const template = buildMetadataTemplate(opts);
	fs.writeFileSync(metadataPath, JSON.stringify(template, null, 2) + "\n");
	steps.push({ kind: "created", label: ".mintree/metadata.json" });
}

function runInit(opts: ScaffoldOpts): Result {
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

	const steps: Step[] = [];
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
		const needs: string[] = [];
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

function StepIcon({ kind }: { kind: StepKind }) {
	switch (kind) {
		case "created":
		case "added":
			return <Text color="green">✓</Text>;
		case "exists":
		case "ignored":
			return <Text color="cyan">○</Text>;
		case "warn":
			return <Text color="yellow">!</Text>;
	}
}

function stepDetail(kind: StepKind): string | null {
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

export default function Init({ options: opts }: Props) {
	const [result, setResult] = useState<Result | null>(null);

	useEffect(() => {
		// Defer one tick so the initial render with the spinner gets to paint.
		setTimeout(() => {
			try {
				setResult(
					runInit({
						provider: opts.provider,
						workspace: opts.workspace,
						team: opts.team,
						apiUrl: opts.apiUrl,
					}),
				);
			} catch (err) {
				setResult({
					ok: false,
					message: err instanceof Error ? err.message : String(err),
				});
			}
		}, 0);
	}, [opts.provider, opts.workspace, opts.team, opts.apiUrl]);

	if (!result) {
		return (
			<Box>
				<Text color="cyan">
					<Spinner type="dots" />
				</Text>
				<Text> Initializing mintree...</Text>
			</Box>
		);
	}

	if (!result.ok) {
		return (
			<Box flexDirection="column" padding={1}>
				<Text color="red" bold>
					✗ {result.message}
				</Text>
				{result.hint && (
					<Box marginTop={1}>
						<Text color="yellow">↳ {result.hint}</Text>
					</Box>
				)}
			</Box>
		);
	}

	const anyChange = result.steps.some((s) => s.kind === "created" || s.kind === "added");

	return (
		<Box flexDirection="column" padding={1}>
			<Box marginBottom={1}>
				<Text bold color="cyan">
					mintree init
				</Text>
				<Text dimColor>{` · ${result.repoRoot}`}</Text>
				<Text dimColor>{` · provider=${result.provider}`}</Text>
			</Box>

			{result.steps.map((step, i) => {
				const detail = stepDetail(step.kind);
				return (
					<Box key={i} flexDirection="column">
						<Box>
							<StepIcon kind={step.kind} />
							<Text> </Text>
							<Text>{step.label}</Text>
							{detail && <Text dimColor> ({detail})</Text>}
						</Box>
						{step.hint && (
							<Box marginLeft={2}>
								<Text color="yellow">↳ {step.hint}</Text>
							</Box>
						)}
					</Box>
				);
			})}

			<Box marginTop={1}>
				{anyChange ? (
					<Text color="green">
						mintree initialized. Run <Text bold>mintree doctor</Text> to verify the rest of your
						setup.
					</Text>
				) : (
					<Text color="cyan">mintree was already initialized — nothing to do.</Text>
				)}
			</Box>
		</Box>
	);
}

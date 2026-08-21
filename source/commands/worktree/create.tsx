import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { argument, option } from "pastel";
import { z } from "zod";

import { PERMISSION_MODES } from "../../lib/claude.js";
import { runCreate, type CreateResult, type CreateStepKind } from "../../lib/worktreeCreate.js";
import { buildCreateMarkers, emitMarkers } from "../../lib/markers.js";
import { findMainRepoRoot } from "../../lib/git.js";
import { createProvider, describeTransition } from "../../lib/providers/index.js";
import type { TransitionResult } from "../../lib/providers/types.js";

export const description = "Create a worktree for an issue branch";

export const args = z.tuple([
	z.string().describe(
		argument({
			name: "branch",
			description:
				"Branch in `<type>/<issue>-<kebab-desc>` format (e.g. feat/100-claude-md-inicial). On a Linear repo you can instead pass the issue's Linear branch name (e.g. jdoe/fe-68-landing-page), or a bare issue id (e.g. FE-68), which is replaced by that issue's Linear branch name.",
		}),
	),
]);

export const options = z.object({
	base: z
		.string()
		.optional()
		.describe(
			option({
				description: "Base branch to fork from (defaults to origin/HEAD or main/master)",
			}),
		),
	work: z
		.boolean()
		.default(false)
		.describe(
			option({
				description:
					"After creating, launch Claude in the new worktree (requires the shell wrapper)",
			}),
		),
	prompt: z
		.string()
		.optional()
		.describe(
			option({
				description:
					"Initial prompt to inject into Claude (only meaningful with --work; literal injection)",
			}),
		),
	exact: z
		.boolean()
		.default(false)
		.describe(
			option({
				description:
					"Create the branch exactly as given, even when it's a bare Linear issue id (skips the branch-name lookup; the branch will close the issue on merge)",
			}),
		),
	permissionMode: z
		.enum(PERMISSION_MODES)
		.optional()
		.describe(
			option({
				description: `Claude --permission-mode passed through to --work (one of: ${PERMISSION_MODES.join(", ")})`,
				alias: "m",
			}),
		),
});

type Props = {
	args: z.infer<typeof args>;
	options: z.infer<typeof options>;
};

function StepIcon({ kind }: { kind: CreateStepKind }) {
	if (kind === "ok") return <Text color="green">✓</Text>;
	if (kind === "warn") return <Text color="yellow">!</Text>;
	if (kind === "error") return <Text color="red">✗</Text>;
	return <Text color="cyan">○</Text>;
}

// Status of the post-create "set issue to In Progress" GraphQL call. Only
// fires on --work; for non-work creates we skip straight to "skipped" so the
// emit-markers effect doesn't stall waiting for a network call we never made.
type TransitionState = "idle" | "running" | "skipped" | TransitionResult;

export default function Create({ args, options }: Props) {
	const [branch] = args;
	const [result, setResult] = useState<CreateResult | null>(null);
	const [transition, setTransition] = useState<TransitionState>("idle");

	useEffect(() => {
		(async () => {
			try {
				const r = await runCreate(branch, {
					base: options.base,
					work: options.work,
					prompt: options.prompt,
					exact: options.exact,
					permissionMode: options.permissionMode,
				});
				setResult(r);
			} catch (err) {
				setResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
			}
		})();
	}, [branch, options.base, options.work, options.prompt, options.exact, options.permissionMode]);

	// Kick the Project v2 transition once the worktree is in place. Only when
	// --work was on — non-work creates leave status untouched. Errors from the
	// GraphQL call surface as a step but never block the worktree hand-off.
	useEffect(() => {
		if (!result || !result.ok) return;
		if (!result.work) {
			setTransition("skipped");
			return;
		}
		setTransition("running");
		let cancelled = false;
		(async () => {
			const root = findMainRepoRoot();
			if (!root) {
				if (!cancelled) setTransition("skipped");
				return;
			}
			try {
				const provider = createProvider(root);
				const r = await provider.transitionIssueToInProgress(result.issueId);
				if (!cancelled) setTransition(r);
			} catch (err) {
				if (cancelled) return;
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
		if (!result) return;
		if (!result.ok || result.initFailed) process.exitCode = 1;
	}, [result]);

	// Emit shell-wrapper markers when create succeeded AND the transition has
	// settled (run or skipped). Goes through the emitMarkers helper so it
	// lands in MINTREE_MARKER_FILE if set, otherwise stdout. Bypasses Ink so
	// word-wrap can't split a long path mid-marker.
	useEffect(() => {
		if (!result || !result.ok) return;
		if (transition === "idle" || transition === "running") return;
		emitMarkers(
			buildCreateMarkers({
				worktreePath: result.worktreePath,
				work: result.work,
				promptFile: result.promptFile,
				permissionMode: result.permissionMode,
			}),
		);
	}, [result, transition]);

	if (!result) {
		return (
			<Box>
				<Text color="cyan">
					<Spinner type="dots" />
				</Text>
				<Text> Creating worktree for {branch}...</Text>
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

	return (
		<Box flexDirection="column" padding={1}>
			<Box marginBottom={1}>
				<Text bold color="cyan">
					mintree worktree create
				</Text>
				<Text dimColor> · {result.branch}</Text>
			</Box>

			{result.steps.map((step, i) => (
				<Box key={i}>
					<StepIcon kind={step.kind} />
					<Text> </Text>
					<Text>{step.label}</Text>
					{step.detail && <Text dimColor> ({step.detail})</Text>}
				</Box>
			))}

			{transition === "running" && (
				<Box>
					<Text color="cyan">
						<Spinner type="dots" />
					</Text>
					<Text> Updating issue status...</Text>
				</Box>
			)}
			{typeof transition === "object" &&
				(() => {
					const step = describeTransition(transition);
					return (
						<Box>
							<StepIcon kind={step.kind} />
							<Text> </Text>
							<Text>{step.label}</Text>
							{step.detail && <Text dimColor> ({step.detail})</Text>}
						</Box>
					);
				})()}

			{/*
			 * The init.sh failure is also a step above, but by then it's buried
			 * mid-scroll under everything that ran after it. This is the last
			 * thing on screen because an uninitialised worktree that reads as
			 * "ready" is the failure mode worth shouting about: its tooling can
			 * still be pointed at the main checkout, so a gate run inside it
			 * goes green against the wrong branch.
			 */}
			{result.initFailed ? (
				<Box marginTop={1} flexDirection="column">
					<Text color="red" bold>
						✗ Worktree created but NOT initialised — .mintree/init.sh failed
					</Text>
					{result.initError && <Text color="red"> {result.initError}</Text>}
					<Text dimColor> at {result.worktreePath}</Text>
					<Box marginTop={1}>
						<Text color="yellow">
							↳ Whatever init.sh sets up (isolation, per-worktree config) is missing. Fix the hook
							and re-run it in the worktree before working there.
						</Text>
					</Box>
				</Box>
			) : (
				<Box marginTop={1} flexDirection="column">
					<Text color="green">
						Worktree ready at <Text bold>{result.worktreePath}</Text>
					</Text>
					<Text dimColor>
						{result.work
							? "Launching Claude in the new worktree..."
							: "Next: `mt worktree work` to start a Claude session, or `cd` and run `claude` directly."}
					</Text>
				</Box>
			)}

			{/*
			 * The branch was (or still is) named after the Linear issue. Linear
			 * closes an issue when a branch bearing its identifier merges, no
			 * matter what the PR body says, so a ticket can go Done with part of
			 * its scope unshipped. Loud and last when we couldn't fix it; a quiet
			 * note when we could. `--exact` says nothing extra — the step line
			 * already reported it and the user asked for this on purpose.
			 */}
			{result.bareIssueBranch?.resolvedTo && (
				<Box marginTop={1}>
					<Text dimColor>
						Branch name taken from Linear ({result.bareIssueBranch.requested} →{" "}
						{result.bareIssueBranch.resolvedTo}); pass --exact to keep the id as typed.
					</Text>
				</Box>
			)}
			{result.bareIssueBranch &&
				!result.bareIssueBranch.resolvedTo &&
				result.bareIssueBranch.reason !== "--exact" && (
					<Box marginTop={1} flexDirection="column">
						<Text color="yellow" bold>
							! Branch `{result.bareIssueBranch.requested}` is named after the Linear issue
						</Text>
						<Text color="yellow">
							{" "}
							Merging it will close {result.bareIssueBranch.requested} in Linear even if the PR says
							&quot;Part of&quot;.
						</Text>
						<Text dimColor> couldn&apos;t check with Linear: {result.bareIssueBranch.reason}</Text>
						<Box marginTop={1}>
							<Text color="yellow">
								↳ Rename it before opening a PR (`git branch -m &lt;new-name&gt;` in the worktree)
								unless closing the issue on merge is what you want.
							</Text>
						</Box>
					</Box>
				)}
		</Box>
	);
}

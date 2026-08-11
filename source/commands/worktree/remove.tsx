import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { argument, option } from "pastel";
import { z } from "zod";

import { runRemove, type RemoveResult } from "../../lib/worktreeRemove.js";

export const description =
	"Remove a worktree (the branch and metadata are preserved so you can re-attach later)";

export const args = z.tuple([
	z.string().describe(
		argument({
			name: "branch",
			description:
				"Branch whose worktree should be removed (in the same `<type>/<issue>-<desc>` format)",
		}),
	),
]);

export const options = z.object({
	force: z
		.boolean()
		.default(false)
		.describe(
			option({
				description: "Remove even if the worktree has uncommitted changes",
			}),
		),
});

type Props = {
	args: z.infer<typeof args>;
	options: z.infer<typeof options>;
};

export default function Remove({ args, options }: Props) {
	const [branch] = args;
	const [result, setResult] = useState<RemoveResult | null>(null);

	useEffect(() => {
		setTimeout(() => {
			try {
				setResult(runRemove(branch, options.force));
			} catch (err) {
				setResult({
					ok: false,
					message: err instanceof Error ? err.message : String(err),
				});
			}
		}, 0);
	}, [branch, options.force]);

	if (!result) {
		return (
			<Box>
				<Text color="cyan">
					<Spinner type="dots" />
				</Text>
				<Text> Removing worktree for {branch}...</Text>
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
					mintree worktree remove
				</Text>
				<Text dimColor> · {result.branch}</Text>
			</Box>

			{result.variant === "pruned-orphan" ? (
				<Text>
					<Text color="yellow">!</Text> worktree directory was already deleted; pruned the dangling
					reference
				</Text>
			) : result.variant === "removed-unregistered" ? (
				<Box flexDirection="column">
					<Text>
						<Text color="yellow">!</Text> directory was not registered with git; deleted it
						<Text dimColor> ({result.worktreePath})</Text>
					</Text>
				</Box>
			) : (
				<Box flexDirection="column">
					<Text>
						<Text color="green">✓</Text> removed <Text dimColor>({result.worktreePath})</Text>
					</Text>
					{result.wasDirty && <Text color="yellow">↳ forced past uncommitted changes</Text>}
				</Box>
			)}

			<Box marginTop={1} flexDirection="column">
				<Text dimColor>
					Branch <Text color="cyan">{result.branch}</Text> was preserved (use `git branch -D{" "}
					{result.branch}` to delete it).
				</Text>
				{result.prunedIssueId ? (
					<Text dimColor>
						Metadata entry for <Text color="cyan">{result.prunedIssueId}</Text> (incl. session_id)
						was pruned.
					</Text>
				) : (
					<Text dimColor>No metadata entry to prune.</Text>
				)}
			</Box>
		</Box>
	);
}

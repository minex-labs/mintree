import React from "react";
import { Box, Text } from "ink";

export const description = "Show welcome screen (TUI dashboard lands in Phase 4)";

export default function Index() {
	return (
		<Box flexDirection="column" paddingX={1} paddingY={1}>
			<Text bold color="green">
				mintree
			</Text>
			<Text dimColor>Issue-driven worktrees + Claude Code sessions.</Text>
			<Box marginTop={1}>
				<Text>
					Run <Text bold>mintree --help</Text> to list available commands.
				</Text>
			</Box>
			<Box marginTop={1}>
				<Text dimColor>
					Phase 0 scaffolding · `doctor`, `init` and `worktree` commands land in subsequent phases.
				</Text>
			</Box>
		</Box>
	);
}

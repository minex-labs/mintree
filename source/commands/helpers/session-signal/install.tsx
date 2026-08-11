import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { installHooks } from "../../../lib/session-signal.js";

export const description = "Install the four mintree hooks in ~/.claude/settings.json";

type Result = { ok: true; settingsPath: string; created: boolean } | { ok: false; message: string };

export default function Install() {
	const [result, setResult] = useState<Result | null>(null);

	useEffect(() => {
		setTimeout(() => {
			try {
				const { settingsPath, created } = installHooks();
				setResult({ ok: true, settingsPath, created });
			} catch (err) {
				setResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
			}
		}, 0);
	}, []);

	if (!result) return null;

	if (!result.ok) {
		return (
			<Box padding={1}>
				<Text color="red" bold>
					✗ {result.message}
				</Text>
			</Box>
		);
	}

	return (
		<Box flexDirection="column" padding={1}>
			<Box marginBottom={1}>
				<Text bold color="cyan">
					mintree helpers session-signal install
				</Text>
			</Box>
			<Text>
				<Text color="green">✓</Text> {result.created ? "created" : "updated"}{" "}
				<Text dimColor>{result.settingsPath}</Text>
			</Text>
			<Box marginTop={1} flexDirection="column">
				<Text dimColor>Hooks installed: UserPromptSubmit, Stop, SessionEnd, Notification.</Text>
				<Text dimColor>
					Re-run safely — existing mintree entries are replaced; non-mintree hooks are preserved.
				</Text>
			</Box>
		</Box>
	);
}

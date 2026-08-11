import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { option } from "pastel";
import { z } from "zod";
import { createRequire } from "module";

import { getLatestVersion, isNewerVersion } from "../lib/version.js";
import { installLatest, PACKAGE_NAME, type UpdateResult } from "../lib/update.js";

const require = createRequire(import.meta.url);
const { version: currentVersion } = require("../../package.json");

export const description = "Update mintree to the latest version (npm i -g mintree)";

export const options = z.object({
	force: z
		.boolean()
		.default(false)
		.describe(
			option({
				description: "Reinstall even when you're already on the latest version",
				alias: "f",
			}),
		),
});

type Props = { options: z.infer<typeof options> };

// Phases: probe the registry → decide → (maybe) install → settle. The registry
// probe is best-effort; if it fails we still attempt the install (npm will
// no-op when already current), so being offline-to-the-probe never blocks an
// actual update.
type Phase =
	| { kind: "checking" }
	| { kind: "uptodate"; latest: string }
	| { kind: "installing"; latest: string | null }
	| { kind: "done"; result: UpdateResult; latest: string | null };

export default function Update({ options: opts }: Props) {
	const [phase, setPhase] = useState<Phase>({ kind: "checking" });

	useEffect(() => {
		let cancelled = false;
		(async () => {
			const latest = await getLatestVersion(PACKAGE_NAME);
			if (cancelled) return;

			// Skip the reinstall only when we're provably current and the user
			// didn't force it. A null probe (offline/private registry) falls
			// through to the install so `mt update` still does something useful.
			if (!opts.force && latest && !isNewerVersion(currentVersion, latest)) {
				setPhase({ kind: "uptodate", latest });
				return;
			}

			setPhase({ kind: "installing", latest });
			const result = await installLatest();
			if (cancelled) return;
			setPhase({ kind: "done", result, latest });
		})();
		return () => {
			cancelled = true;
		};
	}, [opts.force]);

	if (phase.kind === "checking") {
		return (
			<Box>
				<Text color="cyan">
					<Spinner type="dots" />
				</Text>
				<Text> Checking for updates... (current v{currentVersion})</Text>
			</Box>
		);
	}

	if (phase.kind === "uptodate") {
		return (
			<Box flexDirection="column" paddingY={0}>
				<Text color="green">✓ mintree is already up to date (v{phase.latest}).</Text>
				<Text dimColor>Run with --force to reinstall anyway.</Text>
			</Box>
		);
	}

	if (phase.kind === "installing") {
		const target = phase.latest ? `v${phase.latest}` : "latest";
		return (
			<Box>
				<Text color="cyan">
					<Spinner type="dots" />
				</Text>
				<Text>
					{" "}
					Updating mintree from v{currentVersion} to {target}...
				</Text>
			</Box>
		);
	}

	// done
	const { result, latest } = phase;
	if (result.ok) {
		const target = latest ? `v${latest}` : "the latest version";
		return (
			<Box flexDirection="column">
				<Text color="green">✓ mintree updated to {target}.</Text>
				<Text dimColor>Open a new shell (or re-run your command) to use it.</Text>
			</Box>
		);
	}
	return (
		<Box flexDirection="column">
			<Text color="red">✗ Update failed.</Text>
			<Text>{result.message}</Text>
			{result.hint ? <Text dimColor>{result.hint}</Text> : null}
		</Box>
	);
}

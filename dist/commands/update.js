import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { option } from "pastel";
import { z } from "zod";
import { createRequire } from "module";
import { getLatestVersion, isNewerVersion } from "../lib/version.js";
import { installLatest, PACKAGE_NAME } from "../lib/update.js";
const require = createRequire(import.meta.url);
const { version: currentVersion } = require("../../package.json");
export const description = "Update mintree to the latest version (npm i -g mintree)";
export const options = z.object({
    force: z
        .boolean()
        .default(false)
        .describe(option({
        description: "Reinstall even when you're already on the latest version",
        alias: "f",
    })),
});
export default function Update({ options: opts }) {
    const [phase, setPhase] = useState({ kind: "checking" });
    useEffect(() => {
        let cancelled = false;
        (async () => {
            const latest = await getLatestVersion(PACKAGE_NAME);
            if (cancelled)
                return;
            // Skip the reinstall only when we're provably current and the user
            // didn't force it. A null probe (offline/private registry) falls
            // through to the install so `mt update` still does something useful.
            if (!opts.force && latest && !isNewerVersion(currentVersion, latest)) {
                setPhase({ kind: "uptodate", latest });
                return;
            }
            setPhase({ kind: "installing", latest });
            const result = await installLatest();
            if (cancelled)
                return;
            setPhase({ kind: "done", result, latest });
        })();
        return () => {
            cancelled = true;
        };
    }, [opts.force]);
    if (phase.kind === "checking") {
        return (_jsxs(Box, { children: [_jsx(Text, { color: "cyan", children: _jsx(Spinner, { type: "dots" }) }), _jsxs(Text, { children: [" Checking for updates... (current v", currentVersion, ")"] })] }));
    }
    if (phase.kind === "uptodate") {
        return (_jsxs(Box, { flexDirection: "column", paddingY: 0, children: [_jsxs(Text, { color: "green", children: ["\u2713 mintree is already up to date (v", phase.latest, ")."] }), _jsx(Text, { dimColor: true, children: "Run with --force to reinstall anyway." })] }));
    }
    if (phase.kind === "installing") {
        const target = phase.latest ? `v${phase.latest}` : "latest";
        return (_jsxs(Box, { children: [_jsx(Text, { color: "cyan", children: _jsx(Spinner, { type: "dots" }) }), _jsxs(Text, { children: [" ", "Updating mintree from v", currentVersion, " to ", target, "..."] })] }));
    }
    // done
    const { result, latest } = phase;
    if (result.ok) {
        const target = latest ? `v${latest}` : "the latest version";
        return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { color: "green", children: ["\u2713 mintree updated to ", target, "."] }), _jsx(Text, { dimColor: true, children: "Open a new shell (or re-run your command) to use it." })] }));
    }
    return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { color: "red", children: "\u2717 Update failed." }), _jsx(Text, { children: result.message }), result.hint ? _jsx(Text, { dimColor: true, children: result.hint }) : null] }));
}

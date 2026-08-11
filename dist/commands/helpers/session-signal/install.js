import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { installHooks } from "../../../lib/session-signal.js";
export const description = "Install the four mintree hooks in ~/.claude/settings.json";
export default function Install() {
    const [result, setResult] = useState(null);
    useEffect(() => {
        setTimeout(() => {
            try {
                const { settingsPath, created } = installHooks();
                setResult({ ok: true, settingsPath, created });
            }
            catch (err) {
                setResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
            }
        }, 0);
    }, []);
    if (!result)
        return null;
    if (!result.ok) {
        return (_jsx(Box, { padding: 1, children: _jsxs(Text, { color: "red", bold: true, children: ["\u2717 ", result.message] }) }));
    }
    return (_jsxs(Box, { flexDirection: "column", padding: 1, children: [_jsx(Box, { marginBottom: 1, children: _jsx(Text, { bold: true, color: "cyan", children: "mintree helpers session-signal install" }) }), _jsxs(Text, { children: [_jsx(Text, { color: "green", children: "\u2713" }), " ", result.created ? "created" : "updated", " ", _jsx(Text, { dimColor: true, children: result.settingsPath })] }), _jsxs(Box, { marginTop: 1, flexDirection: "column", children: [_jsx(Text, { dimColor: true, children: "Hooks installed: UserPromptSubmit, Stop, SessionEnd, Notification." }), _jsx(Text, { dimColor: true, children: "Re-run safely \u2014 existing mintree entries are replaced; non-mintree hooks are preserved." })] })] }));
}

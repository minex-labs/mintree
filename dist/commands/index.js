import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from "ink";
export const description = "Show welcome screen (TUI dashboard lands in Phase 4)";
export default function Index() {
    return (_jsxs(Box, { flexDirection: "column", paddingX: 1, paddingY: 1, children: [_jsx(Text, { bold: true, color: "green", children: "mintree" }), _jsx(Text, { dimColor: true, children: "Issue-driven worktrees + Claude Code sessions." }), _jsx(Box, { marginTop: 1, children: _jsxs(Text, { children: ["Run ", _jsx(Text, { bold: true, children: "mintree --help" }), " to list available commands."] }) }), _jsx(Box, { marginTop: 1, children: _jsx(Text, { dimColor: true, children: "Phase 0 scaffolding \u00B7 `doctor`, `init` and `worktree` commands land in subsequent phases." }) })] }));
}

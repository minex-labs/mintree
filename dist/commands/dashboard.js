import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import { execSync } from "child_process";
import { createRequire } from "module";
import { findBranchConventionDoc, findMainRepoRoot, getCurrentBranch, getMintreeDir, pathExists, } from "../lib/git.js";
import { resolveClaudeBinary } from "../lib/claude.js";
import { MultilineTextArea } from "../lib/MultilineTextArea.js";
import { tryExec } from "../lib/exec.js";
import { getLatestVersion, isNewerVersion } from "../lib/version.js";
import { ALLOWED_TYPES } from "../lib/branch.js";
import { runCreate, runCreateDetached, } from "../lib/worktreeCreate.js";
import { runRemove, runRemoveByPath } from "../lib/worktreeRemove.js";
import { writePromptFile } from "../lib/worktreeCreate.js";
import { buildCreateMarkers, buildOrchestrateMarkers, emitMarkers } from "../lib/markers.js";
import { buildOrchestratorRcName } from "../lib/orchestrate.js";
import { readMetadata } from "../lib/metadata.js";
import { defaultOrchestratorPrompt, renderOrchestratorTemplate, renderPromptTemplate, } from "../lib/promptTemplate.js";
import { createProvider } from "../lib/providers/index.js";
import { loadDashboard } from "../lib/dashboard.js";
import { priorityDisplay } from "../lib/priority.js";
const require = createRequire(import.meta.url);
const { version: mintreeVersion } = require("../../package.json");
export const description = "Interactive dashboard listing open issues assigned to you with worktree + session state";
// Pause long enough for Ink to paint a pending state before we hand the thread
// back to a synchronous, blocking child process (git worktree remove, etc.).
const FRAME_MS = 32;
function isOrphan(d) {
    return d.orphan === true;
}
// Builds the remove-overlay descriptor for an issue row that has a worktree.
// Callers must have already checked `d.worktree` is present.
function toRemoveTarget(d) {
    return {
        issue: d,
        branch: d.worktree.branch,
        worktreePath: d.worktree.path,
        dirty: d.worktree.dirty,
        unregistered: d.worktree.unregistered === true,
    };
}
// Matches an issue against the live numeric filter by substring on the digit
// portion of its id ("BE-234" → "234", "BE-34" → "34"). Letters are ignored,
// so the user filters by ticket number alone. Empty filter matches everything.
function issueMatchesFilter(d, filter) {
    if (!filter)
        return true;
    return d.issue.id.replace(/\D/g, "").includes(filter);
}
function tabIssues(issues, tab, filter = "") {
    // Orchestrate shows the same set as Issues (open issues assigned to you,
    // non-orphan); only Worktrees flips to the orphan set.
    return issues.filter((d) => (tab === "worktrees" ? isOrphan(d) : !isOrphan(d)) && issueMatchesFilter(d, filter));
}
function tabIndex(s, tab) {
    if (tab === "issues")
        return s.issuesIndex;
    if (tab === "worktrees")
        return s.worktreesIndex;
    return s.orchestrateIndex;
}
function currentSelected(s) {
    const displayed = tabIssues(s.issues, s.activeTab, s.filter);
    return { displayed, selectedIndex: tabIndex(s, s.activeTab) };
}
function withSelectedIndex(s, next) {
    if (s.activeTab === "issues")
        return { ...s, issuesIndex: next };
    if (s.activeTab === "worktrees")
        return { ...s, worktreesIndex: next };
    return { ...s, orchestrateIndex: next };
}
// xterm/iTerm/etc switch to the alternate screen buffer with these escape
// codes. Using the buffer means the dashboard owns the whole window for its
// lifetime, and the previous shell content reappears unchanged the moment
// we switch back. ALT_SCREEN_ENTER also homes the cursor so the first Ink
// render starts at row 1.
const ALT_SCREEN_ENTER = "\x1b[?1049h\x1b[H";
const ALT_SCREEN_LEAVE = "\x1b[?1049l";
// SGR mouse tracking — \x1b[?1002h enables button-event tracking (press,
// release, drag, wheel); \x1b[?1006h switches reports to the SGR extended
// format \x1b[<button;col;row(M|m), which works past col/row 223 and is
// what we parse below. We only consume wheel events; press/release fall
// through harmlessly.
const MOUSE_ON = "\x1b[?1002h\x1b[?1006h";
const MOUSE_OFF = "\x1b[?1006l\x1b[?1002l";
const MOUSE_SGR_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
const SCROLL_STEP = 3;
function truncate(s, max) {
    if (max <= 1)
        return s.slice(0, max);
    if (s.length <= max)
        return s;
    return s.slice(0, max - 1) + "…";
}
/**
 * Compact "X ago" formatter for ISO 8601 timestamps. Returns "—" for
 * unparseable input so callers can use it directly in JSX without needing
 * to handle the missing/invalid case themselves.
 */
function relativeTime(iso) {
    if (!iso)
        return "—";
    const t = Date.parse(iso);
    if (Number.isNaN(t))
        return "—";
    const seconds = Math.floor((Date.now() - t) / 1000);
    if (seconds < 60)
        return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60)
        return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24)
        return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30)
        return `${days}d ago`;
    const months = Math.floor(days / 30);
    if (months < 12)
        return `${months}mo ago`;
    const years = Math.floor(days / 365);
    return `${years}y ago`;
}
// Default cap on the number of words mintree pulls from the issue title to
// build the suggested branch description. Five words matches the typical
// "<type>/<issue>-<short-kebab-desc>" convention found in most projects.
// The user can always extend the desc by hand in the overlay.
const SUGGESTED_DESC_MAX_WORDS = 5;
/**
 * Suggests a default kebab-case description from an issue title. Strips
 * non-ascii / punctuation, collapses whitespace, and caps at SUGGESTED_DESC
 * _MAX_WORDS so a verbose title doesn't produce an unreadable branch name.
 */
function kebabize(title) {
    return title
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "") // strip diacritics
        .replace(/[^a-z0-9\s-]/g, " ")
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, SUGGESTED_DESC_MAX_WORDS)
        .join("-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "");
}
/**
 * Default prompt seeded into the overlay's Prompt field when the user opens
 * `w` for an issue. Single-line on purpose — `ink-text-input` is one-line,
 * so multi-line templates render weirdly when the user tabs in to edit.
 *
 * When the repo configures a `promptTemplate` in `.mintree/metadata.json`,
 * it wins: the `{{id}}`, `{{title}}` and `{{url}}` placeholders are rendered
 * and the result seeds the field. Otherwise we fall back to the built-in,
 * provider-aware default: GitHub issues get the `#<n>` + `gh issue view`
 * form; Linear issues (id like `FE-123`) get the bare id + the issue URL,
 * since `gh` can't read Linear and `#` isn't Linear's notation.
 */
function defaultPromptForIssue(id, title, url, template) {
    if (template) {
        return renderPromptTemplate(template, { id, title, url });
    }
    const isTeamPrefixed = /^[A-Z][A-Z0-9_]*-\d+$/.test(id);
    if (isTeamPrefixed) {
        return `Empezá a trabajar el ticket ${id} (${title}). Abrí ${url} para leer el contexto completo y seguí las convenciones del repo.`;
    }
    return `Empezá a trabajar el issue #${id} (${title}). Usá \`gh issue view ${id}\` para leer el contexto completo y seguí las convenciones del repo.`;
}
/**
 * Sanitises whatever the user typed into the desc field on every keystroke.
 * Same rules as kebabize but without the word cap — this is for live input.
 */
function sanitizeDesc(value) {
    return value
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+/, "");
}
function openInBrowser(url) {
    try {
        const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
        execSync(`${cmd} ${shQuote(url)}`, { stdio: "ignore" });
        return true;
    }
    catch {
        return false;
    }
}
function shQuote(value) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
function useTerminalSize() {
    const { stdout } = useStdout();
    const [size, setSize] = useState({
        columns: stdout?.columns ?? 100,
        rows: stdout?.rows ?? 24,
    });
    useEffect(() => {
        if (!stdout)
            return;
        const onResize = () => setSize({ columns: stdout.columns ?? 100, rows: stdout.rows ?? 24 });
        stdout.on("resize", onResize);
        return () => {
            stdout.off("resize", onResize);
        };
    }, [stdout]);
    return size;
}
// Tab order for ← / → cycling.
const TAB_ORDER = ["issues", "worktrees", "orchestrate"];
function TabChip({ label, active }) {
    return active ? (_jsx(Text, { bold: true, backgroundColor: "cyan", color: "black", children: label })) : (_jsx(Text, { dimColor: true, children: label }));
}
function HeaderRow({ repoName, claudeVersion, issueCount, worktreeCount, orchestrateCount, activeTab, updateAvailable, }) {
    const issuesLabel = ` Issues (${issueCount}) `;
    const worktreesLabel = ` Worktrees (${worktreeCount}) `;
    const orchestrateLabel = orchestrateCount > 0 ? ` Orchestrate (${orchestrateCount}) ` : ` Orchestrate `;
    return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { children: [_jsx(Text, { bold: true, color: "green", children: "mintree" }), _jsx(Text, { dimColor: true, children: `  v${mintreeVersion}` }), updateAvailable && _jsx(Text, { color: "yellow", children: " (*)" }), claudeVersion && _jsx(Text, { dimColor: true, children: `   ·   claude ${claudeVersion}` }), repoName && _jsx(Text, { dimColor: true, children: `   ·   ${repoName}` })] }), _jsxs(Box, { children: [_jsx(TabChip, { label: issuesLabel, active: activeTab === "issues" }), _jsx(Text, { children: " " }), _jsx(TabChip, { label: worktreesLabel, active: activeTab === "worktrees" }), _jsx(Text, { children: " " }), _jsx(TabChip, { label: orchestrateLabel, active: activeTab === "orchestrate" }), _jsx(Text, { dimColor: true, children: "   ← / → switch tab" })] })] }));
}
function FooterRow({ phase, overlayKind, latestVersion, listWidth, activeTab, selectedCount, }) {
    if (phase === "error") {
        return (_jsx(Box, { children: _jsx(Text, { dimColor: true, children: "q quit" }) }));
    }
    if (overlayKind === "create") {
        return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { children: [_jsx(Text, { bold: true, children: "Tab" }), _jsx(Text, { dimColor: true, children: " switch field " }), _jsx(Text, { bold: true, children: "\u2190/\u2192" }), _jsx(Text, { dimColor: true, children: " toggle branch / cycle type " }), _jsx(Text, { bold: true, children: "Ctrl+X" }), _jsx(Text, { dimColor: true, children: " create + work" })] }), _jsxs(Box, { children: [_jsx(Text, { dimColor: true, children: "In the Prompt box: " }), _jsx(Text, { bold: true, children: "Enter" }), _jsx(Text, { dimColor: true, children: " newline " }), _jsx(Text, { bold: true, children: "Ctrl+L" }), _jsx(Text, { dimColor: true, children: " clear " }), _jsx(Text, { bold: true, children: "Esc" }), _jsx(Text, { dimColor: true, children: " cancel" })] })] }));
    }
    if (overlayKind === "remove") {
        return (_jsxs(Box, { children: [_jsx(Text, { bold: true, children: "y/Y" }), _jsx(Text, { dimColor: true, children: " confirm " }), _jsx(Text, { bold: true, children: "n/Esc" }), _jsx(Text, { dimColor: true, children: " cancel" })] }));
    }
    if (overlayKind === "orchestrate") {
        return (_jsxs(Box, { children: [_jsx(Text, { dimColor: true, children: "Edit the prompt \u00B7 " }), _jsx(Text, { bold: true, children: "Enter" }), _jsx(Text, { dimColor: true, children: " newline " }), _jsx(Text, { bold: true, children: "Ctrl+L" }), _jsx(Text, { dimColor: true, children: " clear " }), _jsx(Text, { bold: true, children: "Ctrl+X" }), _jsx(Text, { dimColor: true, children: " orchestrate " }), _jsx(Text, { bold: true, children: "Esc" }), _jsx(Text, { dimColor: true, children: " cancel" })] }));
    }
    // Orchestrate tab: selection-driven controls instead of the per-ticket
    // work/open/remove actions.
    if (activeTab === "orchestrate") {
        return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { children: [_jsx(Text, { bold: true, children: "j/k" }), _jsx(Text, { dimColor: true, children: " nav " }), _jsx(Text, { dimColor: true, children: "\u00B7" }), _jsx(Text, { bold: true, children: " Space" }), _jsx(Text, { dimColor: true, children: " toggle " }), _jsx(Text, { dimColor: true, children: "\u00B7" }), _jsx(Text, { bold: true, children: " a" }), _jsx(Text, { dimColor: true, children: " all " }), _jsx(Text, { dimColor: true, children: "\u00B7" }), _jsx(Text, { bold: true, children: " \u21B5" }), _jsxs(Text, { dimColor: true, children: [" orchestrate", selectedCount ? ` (${selectedCount})` : "", " "] }), _jsx(Text, { dimColor: true, children: "\u00B7" }), _jsx(Text, { bold: true, children: " q" }), _jsx(Text, { dimColor: true, children: " quit" })] }), latestVersion && (_jsxs(Box, { children: [_jsx(Text, { color: "yellow", children: "(*)" }), _jsx(Text, { dimColor: true, children: ` new version available — v${latestVersion} · npm i -g mintree` })] }))] }));
    }
    // Worktrees tab: same navigation as Issues plus Space/a selection so a
    // batch of worktrees can be removed at once with `d`.
    if (activeTab === "worktrees") {
        return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { children: [_jsx(Text, { bold: true, children: "j/k" }), _jsx(Text, { dimColor: true, children: " nav " }), _jsx(Text, { dimColor: true, children: "\u00B7" }), _jsx(Text, { bold: true, children: " Space" }), _jsx(Text, { dimColor: true, children: " select " }), _jsx(Text, { dimColor: true, children: "\u00B7" }), _jsx(Text, { bold: true, children: " a" }), _jsx(Text, { dimColor: true, children: " all " }), _jsx(Text, { dimColor: true, children: "\u00B7" }), _jsx(Text, { bold: true, children: " \u21B5" }), _jsx(Text, { dimColor: true, children: " switch " }), _jsx(Text, { dimColor: true, children: "\u00B7" }), _jsx(Text, { bold: true, children: " d" }), _jsxs(Text, { dimColor: true, children: [" remove", selectedCount ? ` (${selectedCount})` : "", " "] }), _jsx(Text, { dimColor: true, children: "\u00B7" }), _jsx(Text, { bold: true, children: " q" }), _jsx(Text, { dimColor: true, children: " quit" })] }), latestVersion && (_jsxs(Box, { children: [_jsx(Text, { color: "yellow", children: "(*)" }), _jsx(Text, { dimColor: true, children: ` new version available — v${latestVersion} · npm i -g mintree` })] }))] }));
    }
    // Two-column footer like santree: common navigation/dashboard commands
    // align under the left (list) pane; ticket-specific actions align under
    // the right (detail) pane. Falls back to a single inline row when no
    // width hint is available (e.g. the error path).
    const common = (_jsxs(Text, { children: [_jsx(Text, { bold: true, children: "j/k" }), _jsx(Text, { dimColor: true, children: " nav " }), _jsx(Text, { dimColor: true, children: "\u00B7" }), _jsx(Text, { bold: true, children: " PgUp/PgDn" }), _jsx(Text, { dimColor: true, children: " scroll " }), _jsx(Text, { dimColor: true, children: "\u00B7" }), _jsx(Text, { bold: true, children: " r" }), _jsx(Text, { dimColor: true, children: " refresh " }), _jsx(Text, { dimColor: true, children: "\u00B7" }), _jsx(Text, { bold: true, children: " #" }), _jsx(Text, { dimColor: true, children: " filter " }), _jsx(Text, { dimColor: true, children: "\u00B7" }), _jsx(Text, { bold: true, children: " q" }), _jsx(Text, { dimColor: true, children: " quit" })] }));
    const ticket = (_jsxs(Text, { children: [_jsx(Text, { bold: true, children: "\u21B5" }), _jsx(Text, { dimColor: true, children: " Switch " }), _jsx(Text, { dimColor: true, children: "\u00B7" }), _jsx(Text, { bold: true, children: " w" }), _jsx(Text, { dimColor: true, children: " Work " }), _jsx(Text, { dimColor: true, children: "\u00B7" }), _jsx(Text, { bold: true, children: " o" }), _jsx(Text, { dimColor: true, children: " Open " }), _jsx(Text, { dimColor: true, children: "\u00B7" }), _jsx(Text, { bold: true, children: " d" }), _jsx(Text, { dimColor: true, children: " Remove" })] }));
    return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { flexDirection: "row", children: [_jsx(Box, { width: listWidth, children: common }), _jsx(Box, { flexGrow: 1, children: ticket })] }), latestVersion && (_jsxs(Box, { children: [_jsx(Text, { color: "yellow", children: "(*)" }), _jsx(Text, { dimColor: true, children: ` new version available — v${latestVersion} · npm i -g mintree` })] }))] }));
}
export function RemoveOverlayView({ overlay, maxListRows, }) {
    const anyDirty = overlay.targets.some((t) => t.dirty);
    const anyUnregistered = overlay.targets.some((t) => t.unregistered);
    // Both cases mean "we can't promise nothing is lost": a dirty worktree has
    // uncommitted changes, an unregistered one can't be checked for them at all.
    const needsForce = anyDirty || anyUnregistered;
    const isBatch = overlay.targets.length > 1;
    const progress = overlay.progress;
    // A large batch would otherwise render one row per worktree and push the
    // confirmation — and, once running, the progress line — off the bottom of
    // the terminal, which is exactly where the user looks for a sign of life.
    const listed = overlay.targets.slice(0, Math.max(1, maxListRows));
    const hidden = overlay.targets.length - listed.length;
    const progressLine = progress && (_jsxs(Text, { children: [_jsx(Text, { color: "cyan", children: _jsx(Spinner, { type: "dots" }) }), _jsx(Text, { children: ` Removing ${progress.done + 1}/${progress.total} — ` }), _jsx(Text, { color: "cyan", children: progress.current }), _jsx(Text, { dimColor: true, children: "..." }), progress.failed > 0 && _jsx(Text, { color: "red", children: `  (${progress.failed} failed)` })] }));
    const forceReason = anyDirty
        ? isBatch
            ? "Some worktrees are dirty. "
            : "This worktree is dirty. "
        : isBatch
            ? "Some directories aren't registered with git — deleting them is a plain rm -rf. "
            : "This directory isn't registered with git — deleting it is a plain rm -rf. ";
    const confirmLine = needsForce ? (_jsxs(Text, { children: [forceReason, "Press", " ", _jsx(Text, { bold: true, color: "red", children: "Y" }), " ", "to force-remove", isBatch ? " all" : "", ", ", _jsx(Text, { bold: true, children: "N" }), "/", _jsx(Text, { bold: true, children: "Esc" }), " to cancel."] })) : (_jsxs(Text, { children: ["Press", " ", _jsx(Text, { bold: true, color: "green", children: "y" }), " ", "to remove", isBatch ? " all" : "", ", ", _jsx(Text, { bold: true, children: "N" }), "/", _jsx(Text, { bold: true, children: "Esc" }), " to cancel."] }));
    return (_jsxs(Box, { flexGrow: 1, flexDirection: "column", paddingX: 1, children: [_jsxs(Box, { children: [_jsx(Text, { bold: true, color: "cyan", children: isBatch ? `Remove ${overlay.targets.length} worktrees` : "Remove worktree" }), !isBatch && _jsx(Text, { dimColor: true, children: ` for ${overlay.targets[0].issue.issue.id}` })] }), isBatch ? (_jsxs(Box, { marginTop: 1, flexDirection: "column", children: [listed.map((t) => (_jsxs(Text, { wrap: "truncate-end", children: [_jsx(Text, { dimColor: true, children: "• " }), _jsx(Text, { color: "cyan", children: t.issue.issue.id }), _jsx(Text, { dimColor: true, children: `  ${t.unregistered ? t.worktreePath : (t.branch ?? `(detached) ${t.worktreePath}`)}  ` }), t.unregistered ? (_jsx(Text, { color: "red", children: "not in git" })) : t.dirty ? (_jsx(Text, { color: "yellow", children: "dirty" })) : (_jsx(Text, { color: "green", children: "clean" }))] }, t.issue.issue.id))), hidden > 0 && _jsx(Text, { dimColor: true, children: `… and ${hidden} more` })] })) : (_jsxs(_Fragment, { children: [_jsx(Box, { marginTop: 0, children: _jsx(Text, { children: overlay.targets[0].issue.issue.title }) }), _jsxs(Box, { marginTop: 1, flexDirection: "column", children: [_jsxs(Text, { children: [_jsx(Text, { dimColor: true, children: anyUnregistered ? "Path: " : "Branch: " }), _jsx(Text, { color: "cyan", children: anyUnregistered
                                            ? overlay.targets[0].worktreePath
                                            : (overlay.targets[0].branch ??
                                                `(detached) ${overlay.targets[0].worktreePath}`) })] }), _jsxs(Text, { children: [_jsx(Text, { dimColor: true, children: "State: " }), anyUnregistered ? (_jsx(Text, { color: "red", children: "not registered with git (uncommitted changes can't be checked)" })) : overlay.targets[0].dirty ? (_jsx(Text, { color: "yellow", children: "dirty (uncommitted changes will be lost)" })) : (_jsx(Text, { color: "green", children: "clean" }))] })] })] })), _jsx(Box, { marginTop: 1, flexDirection: "column", children: _jsxs(Text, { dimColor: true, children: [isBatch ? "These worktrees' branches are" : "The branch is", " preserved; the issue's metadata entry (session_id included) is dropped."] }) }), _jsx(Box, { marginTop: 1, children: progress ? progressLine : confirmLine }), overlay.error && (_jsx(Box, { marginTop: 1, children: _jsxs(Text, { color: "red", bold: true, children: ["\u2717 ", overlay.error] }) }))] }));
}
function CreateOverlayView({ overlay, onDescChange, onPromptChange, onPromptSubmit, onPromptCancel, boxWidth, boxHeight, }) {
    const labelWidth = 14;
    const isNewBranch = overlay.branchMode === "new";
    const isLinearBranch = overlay.linearBranch !== null;
    // type/desc only apply to the convention "new branch" path — hidden both
    // for detached ("current") mode and for the Linear-branchName case.
    const showTypeDesc = isNewBranch && !isLinearBranch;
    const detachedDesc = kebabize(overlay.issue.issue.title) || `issue-${overlay.issue.issue.id}`;
    const branchPreview = !isNewBranch
        ? `detached @ ${overlay.currentBranch ?? "(unknown)"}`
        : isLinearBranch
            ? overlay.linearBranch
            : `${overlay.type}/${overlay.issue.issue.id}-${overlay.desc}`;
    const dirPreview = !isNewBranch
        ? `${overlay.issue.issue.id}-${detachedDesc}`
        : isLinearBranch
            ? overlay.issue.issue.id
            : `${overlay.issue.issue.id}-${overlay.desc}`;
    return (_jsxs(Box, { flexGrow: 1, flexDirection: "column", paddingX: 1, children: [_jsxs(Box, { children: [_jsx(Text, { bold: true, color: "cyan", children: "Create worktree" }), _jsx(Text, { dimColor: true, children: ` for ${overlay.issue.issue.id}` })] }), _jsx(Box, { marginTop: 0, children: _jsx(Text, { children: overlay.issue.issue.title }) }), _jsxs(Box, { marginTop: 1, flexDirection: "column", children: [_jsxs(Box, { children: [_jsx(Box, { width: labelWidth, children: _jsx(Text, { bold: overlay.field === "branchMode", children: overlay.field === "branchMode" ? "▸ Branch:" : "  Branch:" }) }), _jsxs(Text, { children: [_jsx(Text, { dimColor: true, children: "<  " }), _jsx(Text, { color: overlay.field === "branchMode" ? "cyan" : undefined, bold: overlay.field === "branchMode", children: isNewBranch ? "new" : `current (${overlay.currentBranch ?? "?"})` }), _jsx(Text, { dimColor: true, children: "  >" })] }), overlay.field === "branchMode" && _jsx(Text, { dimColor: true, children: "   (use ← / → to toggle)" })] }), isNewBranch && isLinearBranch && (_jsxs(Box, { marginTop: 0, children: [_jsx(Box, { width: labelWidth, children: _jsx(Text, { dimColor: true, children: "  Branch name:" }) }), _jsx(Text, { color: "green", children: overlay.linearBranch }), _jsx(Text, { dimColor: true, children: "   (from Linear)" })] })), showTypeDesc && (_jsxs(_Fragment, { children: [_jsxs(Box, { marginTop: 0, children: [_jsx(Box, { width: labelWidth, children: _jsx(Text, { bold: overlay.field === "type", children: overlay.field === "type" ? "▸ Type:" : "  Type:" }) }), _jsxs(Text, { children: [_jsx(Text, { dimColor: true, children: "<  " }), _jsx(Text, { color: overlay.field === "type" ? "cyan" : undefined, bold: overlay.field === "type", children: overlay.type }), _jsx(Text, { dimColor: true, children: "  >" })] }), overlay.field === "type" && _jsx(Text, { dimColor: true, children: "   (use ← / → to cycle)" })] }), _jsxs(Box, { marginTop: 0, children: [_jsx(Box, { width: labelWidth, children: _jsx(Text, { bold: overlay.field === "desc", children: overlay.field === "desc" ? "▸ Description:" : "  Description:" }) }), _jsx(Box, { children: overlay.field === "desc" ? (_jsx(TextInput, { value: overlay.desc, onChange: onDescChange, placeholder: "kebab-case" })) : (_jsx(Text, { children: overlay.desc || "(empty)" })) })] })] })), _jsxs(Box, { marginTop: 1, flexDirection: "column", children: [_jsxs(Text, { bold: overlay.field === "prompt", children: [overlay.field === "prompt" ? "▸ Prompt" : "  Prompt", _jsx(Text, { dimColor: true, children: " (from your template — edit freely, empty = no message)" })] }), _jsx(MultilineTextArea, { value: overlay.prompt, onChange: onPromptChange, onSubmit: onPromptSubmit, onCancel: onPromptCancel, focus: overlay.field === "prompt", width: boxWidth, height: boxHeight, placeholder: "Type or paste the prompt for Claude\u2026" })] })] }), _jsxs(Box, { marginTop: 1, flexDirection: "column", children: [_jsxs(Box, { children: [_jsx(Box, { width: labelWidth, children: _jsx(Text, { dimColor: true, children: " Checkout:" }) }), _jsx(Text, { color: "green", children: branchPreview })] }), _jsxs(Box, { children: [_jsx(Box, { width: labelWidth, children: _jsx(Text, { dimColor: true, children: " Worktree:" }) }), _jsxs(Text, { dimColor: true, children: [".mintree/worktrees/", dirPreview] })] }), _jsxs(Box, { children: [_jsx(Box, { width: labelWidth, children: _jsx(Text, { dimColor: true, children: " Mode:" }) }), _jsx(Text, { dimColor: true, children: "--work (Claude launches in the new worktree)" })] })] }), _jsxs(Box, { marginTop: 1, flexDirection: "column", children: [isLinearBranch ? (_jsx(Text, { dimColor: true, children: "Branch name comes from Linear (the issue's suggested `branchName`). The worktree dir is the bare issue id." })) : isNewBranch ? (_jsxs(Text, { dimColor: true, children: ["Suggestion is a kebab of the title (capped at ", SUGGESTED_DESC_MAX_WORDS, " words). Edit it to match your repo's branch conventions."] })) : (_jsxs(Text, { dimColor: true, children: ["Detached HEAD at the tip of ", overlay.currentBranch ?? "the current branch", ". No new branch is created \u2014 commit on a new one with `git switch -c` when ready."] })), showTypeDesc && overlay.conventionDoc && (_jsx(Text, { dimColor: true, children: `This repo has \`${overlay.conventionDoc}\` — review it before creating.` }))] }), overlay.error && (_jsx(Box, { marginTop: 1, children: _jsxs(Text, { color: "red", bold: true, children: ["\u2717 ", overlay.error] }) })), overlay.steps.length > 0 && (_jsx(Box, { marginTop: 1, flexDirection: "column", children: overlay.steps.map((step, i) => (_jsxs(Box, { children: [_jsx(CreateStepIcon, { kind: step.kind }), _jsx(Text, { children: " " }), _jsx(Text, { children: step.label }), step.detail && _jsxs(Text, { dimColor: true, children: [" (", step.detail, ")"] })] }, i))) })), overlay.pending && (_jsxs(Box, { marginTop: overlay.steps.length > 0 ? 0 : 1, children: [_jsx(Text, { color: "cyan", children: _jsx(Spinner, { type: "dots" }) }), _jsxs(Text, { children: [" ", overlay.pending] })] }))] }));
}
function CreateStepIcon({ kind }) {
    if (kind === "ok")
        return _jsx(Text, { color: "green", children: "\u2713" });
    if (kind === "warn")
        return _jsx(Text, { color: "yellow", children: "!" });
    return _jsx(Text, { color: "cyan", children: "\u25CB" });
}
function OrchestrateOverlayView({ overlay, onPromptChange, onPromptSubmit, onPromptCancel, boxWidth, boxHeight, }) {
    return (_jsxs(Box, { flexGrow: 1, flexDirection: "column", paddingX: 1, children: [_jsx(Box, { children: _jsxs(Text, { bold: true, color: "cyan", children: ["Orchestrate ", overlay.ids.length, " ticket", overlay.ids.length === 1 ? "" : "s"] }) }), _jsx(Box, { marginTop: 0, children: _jsx(Text, { color: "cyan", children: overlay.ids.join(", ") }) }), _jsxs(Box, { marginTop: 1, flexDirection: "column", children: [_jsxs(Text, { bold: true, children: ["\u25B8 Prompt", _jsx(Text, { dimColor: true, children: " (from your template — edit freely, empty = no message)" })] }), _jsx(MultilineTextArea, { value: overlay.prompt, onChange: onPromptChange, onSubmit: onPromptSubmit, onCancel: onPromptCancel, focus: true, width: boxWidth, height: boxHeight, placeholder: "Type or paste the prompt for the orchestrator\u2026" })] }), overlay.error && (_jsx(Box, { marginTop: 1, children: _jsxs(Text, { color: "red", bold: true, children: ["\u2717 ", overlay.error] }) }))] }));
}
export function IssueListRow({ d, selected, identifierWidth, rowWidth, checkbox, }) {
    // Display the issue id raw (e.g. "FE-123", "100"). The `#` prefix is a
    // GitHub convention that reads as noise for Linear's already-prefixed
    // ids, and dropping it across the board keeps the dashboard provider-
    // agnostic.
    const idText = d.issue.id.padEnd(identifierWidth, " ");
    // Status-coloured leading dot — same convention as santree. Falls back to
    // gray when the issue has no project board membership.
    const dotColor = d.project?.statusColor ?? "gray";
    // Compact priority glyph (Linear only; GitHub rows render a blank). The
    // fixed single-width icon keeps the ids aligned whether or not a row has a
    // priority. See lib/priority.ts.
    const prio = priorityDisplay(d.issue.priority);
    const title = d.issue.title;
    const checkPrefix = checkbox === undefined ? "  " : checkbox === "on" ? "[✔] " : "[ ] ";
    const checkColor = checkbox === "on" ? "green" : undefined;
    // The leading-dot Text and the rest are nested under a single Text so the
    // selection background paints the whole row in one contiguous block.
    // `wrap="truncate"` clamps the row to a single line and Ink renders an
    // ellipsis at the cut. The outer Box has a fixed width so the wrap
    // behaviour knows where to truncate.
    return (_jsx(Box, { width: rowWidth, children: _jsxs(Text, { wrap: "truncate", backgroundColor: selected ? "blue" : undefined, color: selected ? "white" : undefined, children: [_jsx(Text, { color: selected ? "white" : checkColor, children: checkPrefix }), _jsx(Text, { color: selected ? "white" : dotColor, children: "\u25CF" }), " ", _jsx(Text, { color: selected ? "white" : prio.color, children: prio.icon }), ` ${idText}  ${title}`, d.worktree?.unregistered && (_jsx(Text, { color: selected ? "white" : "red", children: "  (not in git)" }))] }) }));
}
// A project board header — the top level of the grouped issue list. Mirrors
// the bold project name + dim count seen in the santree dashboard.
function ProjectHeaderRow({ title, count, width, }) {
    return (_jsxs(Box, { children: [_jsx(Text, { bold: true, color: "cyan", children: truncate(title, Math.max(4, width - 6)) }), _jsx(Text, { dimColor: true, children: `  ${count}` })] }));
}
// A Status sub-header within a project group. Matches santree's look: just
// the status name in its board colour, no leading bullet — the bullets live
// on the individual issue rows below it.
function StatusHeaderRow({ name, color, count, width, }) {
    return (_jsxs(Box, { children: [_jsx(Text, { color: color, children: ` ${truncate(name, Math.max(4, width - 6))}` }), _jsx(Text, { dimColor: true, children: `  ${count}` })] }));
}
/**
 * Walks the already-grouped flat issue array (loadDashboard sorts it by
 * project → status → number) and interleaves project/status header rows
 * whenever the group changes. When no issue belongs to a project board the
 * list stays flat — same look the dashboard had before grouping existed.
 */
function buildListRows(issues) {
    if (!issues.some((d) => d.project !== null)) {
        return issues.map((d, index) => ({ kind: "issue", d, index }));
    }
    const projectTitle = (d) => d.project?.projectTitle ?? "Sin proyecto";
    const projectCount = new Map();
    const statusCount = new Map();
    for (const d of issues) {
        const p = projectTitle(d);
        projectCount.set(p, (projectCount.get(p) ?? 0) + 1);
        if (d.project) {
            const key = `${p} ${d.project.status ?? "Sin estado"}`;
            statusCount.set(key, (statusCount.get(key) ?? 0) + 1);
        }
    }
    const rows = [];
    let curProject = null;
    let curStatus = null;
    issues.forEach((d, index) => {
        const p = projectTitle(d);
        if (p !== curProject) {
            if (curProject !== null)
                rows.push({ kind: "spacer" });
            rows.push({ kind: "project", title: p, count: projectCount.get(p) ?? 0 });
            curProject = p;
            curStatus = null;
        }
        if (d.project) {
            const s = d.project.status ?? "Sin estado";
            if (s !== curStatus) {
                rows.push({
                    kind: "status",
                    name: s,
                    color: d.project.statusColor,
                    count: statusCount.get(`${p} ${s}`) ?? 0,
                });
                curStatus = s;
            }
        }
        rows.push({ kind: "issue", d, index });
    });
    return rows;
}
/**
 * Splits the grouped list into a pinned-header region and a scrollable body
 * windowed around the selected issue.
 *
 * Sticky pinning only kicks in when the whole list overflows the viewport
 * AND the selected issue's project header would otherwise be scrolled off
 * the top. In every other case (list fits, or selection is above its
 * project header) the layout is rendered natively — moving the project
 * label out of its natural position when there's no scrolling to track
 * is purely confusing.
 *
 * Status headers are never pinned: they're short groups in close vertical
 * proximity to their items, so the user always sees them inline. Pinning
 * them was previously breaking grouping when the body window spanned
 * multiple status sub-groups.
 */
function windowListRows(listRows, selectedIndex, viewportRows) {
    const selRow = listRows.findIndex((r) => r.kind === "issue" && r.index === selectedIndex);
    const anchor = selRow >= 0 ? selRow : 0;
    // If the entire list fits in the viewport, no scrolling will happen and
    // pinning would just visually displace headers without serving any
    // purpose. Render the list flat.
    if (listRows.length <= viewportRows) {
        return {
            sticky: [],
            body: [...listRows],
            issuesAbove: 0,
            issuesBelow: 0,
        };
    }
    // Otherwise, decide if the project header needs to be pinned. It does iff
    // the body window we'd render — centred on the anchor — would not include
    // the project header itself. When it would, the user sees the header in
    // place and pinning is again redundant.
    let projIdx = -1;
    for (let i = anchor; i >= 0; i--) {
        const r = listRows[i];
        if (!r)
            continue;
        if (r.kind === "project") {
            projIdx = i;
            break;
        }
    }
    const tentativeMaxStart = Math.max(0, listRows.length - viewportRows);
    const tentativeStart = Math.max(0, Math.min(tentativeMaxStart, anchor - Math.floor(viewportRows / 2)));
    const projectVisibleInWindow = projIdx >= 0 && projIdx >= tentativeStart;
    if (projectVisibleInWindow) {
        const end = Math.min(listRows.length, tentativeStart + viewportRows);
        return {
            sticky: [],
            body: listRows.slice(tentativeStart, end),
            issuesAbove: listRows.slice(0, tentativeStart).filter((r) => r.kind === "issue").length,
            issuesBelow: listRows.slice(end).filter((r) => r.kind === "issue").length,
        };
    }
    // Project header is above the visible window — pin it (and drop the
    // preceding spacer so the pane doesn't open with a blank line).
    const pinned = new Set();
    const sticky = [];
    if (projIdx >= 0) {
        pinned.add(projIdx);
        sticky.push(listRows[projIdx]);
        const before = listRows[projIdx - 1];
        if (before && before.kind === "spacer")
            pinned.add(projIdx - 1);
    }
    const body = [];
    let anchorInBody = 0;
    listRows.forEach((r, i) => {
        if (pinned.has(i))
            return;
        if (i === anchor)
            anchorInBody = body.length;
        body.push(r);
    });
    const bodyViewport = Math.max(1, viewportRows - sticky.length);
    const maxStart = Math.max(0, body.length - bodyViewport);
    const start = Math.max(0, Math.min(maxStart, anchorInBody - Math.floor(bodyViewport / 2)));
    const end = Math.min(body.length, start + bodyViewport);
    return {
        sticky,
        body: body.slice(start, end),
        issuesAbove: body.slice(0, start).filter((r) => r.kind === "issue").length,
        issuesBelow: body.slice(end).filter((r) => r.kind === "issue").length,
    };
}
// Renders a single grouped-list row — used for both the sticky header region
// and the scrollable body so the two stay visually identical.
function ListRowView({ row, selectedIndex, identifierWidth, width, selectedIds, }) {
    if (row.kind === "spacer")
        return _jsx(Text, { children: " " });
    if (row.kind === "project") {
        return _jsx(ProjectHeaderRow, { title: row.title, count: row.count, width: width });
    }
    if (row.kind === "status") {
        return _jsx(StatusHeaderRow, { name: row.name, color: row.color, count: row.count, width: width });
    }
    return (_jsx(IssueListRow, { d: row.d, selected: row.index === selectedIndex, identifierWidth: identifierWidth, rowWidth: width, checkbox: selectedIds ? (selectedIds.has(row.d.issue.id) ? "on" : "off") : undefined }));
}
// Word-wraps a single line at `width` columns, breaking on the last space
// before the limit when that yields a reasonable cut. Falls back to a hard
// cut for unbroken runs (long URLs, code-fence content) so the detail pane
// width is never exceeded. An empty input returns [""] so blank lines round-
// trip through the wrapper.
function wrapLine(s, width) {
    if (width <= 0)
        return [s];
    if (s.length <= width)
        return [s];
    const out = [];
    let rest = s;
    while (rest.length > width) {
        const space = rest.lastIndexOf(" ", width);
        const cut = space > Math.floor(width * 0.4) ? space : width;
        out.push(rest.slice(0, cut));
        rest = rest.slice(cut).replace(/^ +/, "");
    }
    if (rest.length > 0)
        out.push(rest);
    return out;
}
// Wraps a markdown-ish body to fit `width`, preserving paragraph breaks
// (consecutive empty lines collapse to one) and trimming leading/trailing
// blank lines. Used to feed the description into the flat-line renderer.
function wrapBody(body, width) {
    const raw = body
        .replace(/\r\n/g, "\n")
        .split("\n")
        .map((l) => l.trimEnd());
    while (raw.length > 0 && raw[0] === "")
        raw.shift();
    while (raw.length > 0 && raw[raw.length - 1] === "")
        raw.pop();
    const out = [];
    let lastBlank = false;
    for (const l of raw) {
        if (l === "") {
            if (!lastBlank)
                out.push("");
            lastBlank = true;
            continue;
        }
        lastBlank = false;
        for (const w of wrapLine(l, Math.max(1, width)))
            out.push(w);
    }
    return out;
}
function sessionIconColor(state) {
    switch (state) {
        case "active":
            return { text: "●", color: "green" };
        case "waiting":
            return { text: "!", color: "yellow" };
        case "idle":
            return { text: "○", dim: true };
        case "exited":
            return { text: "—", dim: true };
    }
}
// Builds the detail pane as a flat array of styled lines so the renderer
// can slice by `scrollOffset` and the user can scroll the entire pane (not
// just the description). Word-wraps the issue body and title at `width` so
// long content stays inside the pane instead of getting truncated with "…".
function buildDetailLines(d, width) {
    const lines = [];
    const blank = () => [{ text: " " }];
    const w = Math.max(20, width);
    const titlePrefix = `${d.issue.id} `;
    const titleWrapped = wrapLine(d.issue.title, Math.max(8, w - titlePrefix.length));
    titleWrapped.forEach((chunk, i) => {
        if (i === 0) {
            lines.push([
                { text: titlePrefix, bold: true },
                { text: chunk, bold: true },
            ]);
        }
        else {
            lines.push([{ text: " ".repeat(titlePrefix.length) + chunk, bold: true }]);
        }
    });
    const labels = d.issue.labels.map((l) => l.name);
    const labelText = labels.length > 0 ? labels.map((l) => `[${l}]`).join(" ") : "(no labels)";
    for (const w2 of wrapLine(labelText, w))
        lines.push([{ text: w2, dim: true }]);
    if (d.project) {
        lines.push([
            { text: "● ", color: d.project.statusColor },
            { text: d.project.status ?? "Sin estado", color: d.project.statusColor },
            { text: ` · ${truncate(d.project.projectTitle, Math.max(8, w - 12))}`, dim: true },
        ]);
    }
    lines.push([
        {
            text: `updated ${relativeTime(d.issue.updatedAt)} · created ${relativeTime(d.issue.createdAt)}`,
            dim: true,
        },
    ]);
    lines.push(blank());
    for (const u of wrapLine(d.issue.url, w))
        lines.push([{ text: u, dim: true }]);
    const body = (d.issue.body ?? "").trim();
    if (body.length > 0) {
        lines.push(blank());
        lines.push([{ text: "📝 Description", bold: true }]);
        for (const bl of wrapBody(body, w - 1)) {
            lines.push([{ text: bl ? ` ${bl}` : " ", dim: true }]);
        }
    }
    lines.push(blank());
    lines.push([{ text: "⌥ Worktree", bold: true }]);
    if (d.worktree) {
        for (const w2 of wrapLine(` branch: ${d.worktree.branch ?? "(detached HEAD)"}`, w))
            lines.push([{ text: w2, dim: true }]);
        for (const w2 of wrapLine(` path:   ${d.worktree.path}`, w))
            lines.push([{ text: w2, dim: true }]);
        const statusLine = [{ text: ` status: `, dim: true }];
        statusLine.push(d.worktree.dirty ? { text: "dirty", color: "yellow" } : { text: "clean", color: "green" });
        if (d.worktree.ab) {
            statusLine.push({
                text: `  +${d.worktree.ab.ahead} / -${d.worktree.ab.behind}`,
                dim: true,
            });
        }
        lines.push(statusLine);
        if (d.worktree.sessionId) {
            lines.push([{ text: ` session: ${d.worktree.sessionId.slice(0, 8)}…`, dim: true }]);
        }
    }
    else {
        lines.push([{ text: " no worktree for this issue", dim: true }]);
    }
    lines.push(blank());
    lines.push([{ text: "● Pull Request", bold: true }]);
    if (d.pr) {
        const stateColor = d.pr.state === "OPEN" ? "green" : d.pr.state === "MERGED" ? "magenta" : "yellow";
        lines.push([
            { text: ` #${d.pr.number}  `, dim: true },
            { text: d.pr.state, color: stateColor },
        ]);
        for (const w2 of wrapLine(` ${d.pr.url}`, w))
            lines.push([{ text: w2, dim: true }]);
    }
    else {
        lines.push([{ text: " no PR yet", dim: true }]);
    }
    lines.push(blank());
    lines.push([{ text: "◌ Session", bold: true }]);
    if (d.session) {
        const ic = sessionIconColor(d.session.state);
        lines.push([
            { text: ` state: `, dim: true },
            { text: ic.text, color: ic.color, dim: ic.dim },
            { text: ` ${d.session.state}`, dim: true },
        ]);
        if (d.session.message) {
            for (const w2 of wrapLine(` message: ${d.session.message}`, w))
                lines.push([{ text: w2, dim: true }]);
        }
        if (d.session.at)
            lines.push([{ text: ` at:      ${d.session.at}`, dim: true }]);
    }
    else {
        lines.push([{ text: " no live session signal", dim: true }]);
    }
    return lines;
}
function DetailPane({ d, contentWidth, contentHeight, scrollOffset, }) {
    if (!d) {
        return (_jsx(Box, { children: _jsx(Text, { dimColor: true, children: "No issue selected." }) }));
    }
    const lines = buildDetailLines(d, contentWidth);
    const totalLines = lines.length;
    const canScroll = totalLines > contentHeight;
    // Reserve last row for the scroll hint when overflow exists.
    const visibleHeight = Math.max(1, canScroll ? contentHeight - 1 : contentHeight);
    const maxOffset = Math.max(0, totalLines - visibleHeight);
    const offset = Math.min(Math.max(0, scrollOffset), maxOffset);
    const visible = lines.slice(offset, offset + visibleHeight);
    let scrollHint = null;
    if (canScroll) {
        const atTop = offset === 0;
        const atBottom = offset + visibleHeight >= totalLines;
        const range = `(${offset + 1}-${Math.min(offset + visibleHeight, totalLines)} / ${totalLines})`;
        const arrows = atTop ? "↓" : atBottom ? "↑" : "↑↓";
        scrollHint = `${arrows} scroll ${range}`;
    }
    return (_jsxs(Box, { flexDirection: "column", children: [visible.map((segs, i) => (_jsx(Box, { children: _jsx(Text, { children: segs.map((seg, j) => (_jsx(Text, { color: seg.color, bold: seg.bold, dimColor: seg.dim, children: seg.text }, j))) }) }, i))), scrollHint && (_jsx(Box, { children: _jsx(Text, { dimColor: true, children: scrollHint }) }))] }));
}
export default function Dashboard() {
    const { exit } = useApp();
    const [state, setState] = useState({ phase: "loading" });
    const [repoName, setRepoName] = useState(null);
    const [claudeVersion, setClaudeVersion] = useState(null);
    // Set only when the npm registry reports a strictly newer version.
    const [latestVersion, setLatestVersion] = useState(null);
    const { columns, rows } = useTerminalSize();
    // Switch to the alt-screen buffer once, synchronously, on the first render
    // pass. Doing this here (instead of inside a useEffect) is what makes the
    // loading state already write into the alt-screen — useEffect only fires
    // after the first commit, which leaves "Loading..." stranded on the parent
    // buffer when the dashboard exits. The ref keeps it idempotent.
    const altScreenEntered = useRef(false);
    if (!altScreenEntered.current) {
        process.stdout.write(ALT_SCREEN_ENTER);
        altScreenEntered.current = true;
    }
    // Set as the dashboard unmounts. The overlay mouse-pause effect below
    // re-enables mouse tracking in its cleanup, and that cleanup also fires on
    // unmount (the create overlay is still open when `confirmCreate` calls
    // exit()). React runs effect cleanups in mount order, so the overlay's
    // MOUSE_ON would run *after* the mouse effect's MOUSE_OFF and leave the
    // terminal capturing the scroll wheel — breaking scroll once Claude takes
    // over. This flag lets the overlay cleanup skip MOUSE_ON during teardown.
    const tearingDown = useRef(false);
    useEffect(() => {
        return () => {
            tearingDown.current = true;
            process.stdout.write(ALT_SCREEN_LEAVE);
        };
    }, []);
    // Live value for the mouse handler (mounted once) to read without
    // re-binding on every resize.
    const listWidthRef = useRef(0);
    const refresh = async (opts) => {
        const root = findMainRepoRoot();
        if (!root) {
            setState({
                phase: "error",
                message: "Not in a git repository.",
                hint: "Run `git init` and then `mintree init`.",
            });
            return;
        }
        if (!pathExists(getMintreeDir(root))) {
            setState({
                phase: "error",
                message: ".mintree/ not found in this repo.",
                hint: "Run `mintree init` first.",
            });
            return;
        }
        const issues = await loadDashboard(root, opts);
        if (!issues) {
            const provider = readMetadata(root).provider ?? "github";
            const message = provider === "linear"
                ? "Could not fetch issues from Linear."
                : "Could not fetch issues from GitHub.";
            const hint = provider === "linear"
                ? "Check `mintree doctor` — LINEAR_API_KEY must be set and the workspace + teams reachable."
                : "Check `mintree doctor` — gh must be authenticated and the repo must live on GitHub.";
            setState((prev) => {
                // Initial load failure → escalate to the full error screen so the
                // user gets the actionable hint front-and-centre. But once the
                // dashboard is up, a transient fetch failure (network blip on the
                // 30s auto-refresh, momentary API slowness) shouldn't blow away
                // what's already on screen — surface a toast and let the next
                // refresh recover.
                if (prev.phase !== "ready") {
                    return { phase: "error", message, hint };
                }
                return {
                    ...prev,
                    refreshing: false,
                    toast: {
                        kind: "error",
                        text: `${message} Showing last known data — press \`r\` to retry.`,
                    },
                };
            });
            return;
        }
        setState((prev) => {
            const prevReady = prev.phase === "ready" ? prev : null;
            const activeTab = prevReady?.activeTab ?? "issues";
            const previousIssuesIndex = prevReady?.issuesIndex ?? 0;
            const previousWorktreesIndex = prevReady?.worktreesIndex ?? 0;
            const previousOrchestrateIndex = prevReady?.orchestrateIndex ?? 0;
            const previousOverlay = prevReady?.overlay ?? null;
            const previousToast = prevReady?.toast ?? null;
            const previousScroll = prevReady?.detailScrollOffset ?? 0;
            const filter = prevReady?.filter ?? "";
            const issuesList = tabIssues(issues, "issues", filter);
            const worktreesList = tabIssues(issues, "worktrees", filter);
            const orchestrateList = tabIssues(issues, "orchestrate", filter);
            const issuesIndex = Math.min(previousIssuesIndex, Math.max(0, issuesList.length - 1));
            const worktreesIndex = Math.min(previousWorktreesIndex, Math.max(0, worktreesList.length - 1));
            const orchestrateIndex = Math.min(previousOrchestrateIndex, Math.max(0, orchestrateList.length - 1));
            // Keep only checked ids that still exist among the open issues, so a
            // resolved/closed ticket drops out of the batch instead of lingering.
            const liveIds = new Set(issues.map((d) => d.issue.id));
            const selectedIds = new Set([...(prevReady?.selectedIds ?? [])].filter((id) => liveIds.has(id)));
            // Worktree selection only makes sense for rows still present in the
            // Worktrees tab (orphaned worktrees). A removed/re-attached worktree
            // drops out of the batch on the next refresh.
            const orphanIds = new Set(issues.filter(isOrphan).map((d) => d.issue.id));
            const selectedWorktreeIds = new Set([...(prevReady?.selectedWorktreeIds ?? [])].filter((id) => orphanIds.has(id)));
            // Preserve scroll only when the active tab's selected issue still
            // resolves to the same row — clamping or list churn means the user
            // is now reading something else.
            const prevDisplayed = prevReady ? tabIssues(prevReady.issues, activeTab, filter) : [];
            const nextDisplayed = activeTab === "worktrees"
                ? worktreesList
                : activeTab === "orchestrate"
                    ? orchestrateList
                    : issuesList;
            const prevIdx = activeTab === "worktrees"
                ? previousWorktreesIndex
                : activeTab === "orchestrate"
                    ? previousOrchestrateIndex
                    : previousIssuesIndex;
            const nextIdx = activeTab === "worktrees"
                ? worktreesIndex
                : activeTab === "orchestrate"
                    ? orchestrateIndex
                    : issuesIndex;
            const prevSelectedId = prevDisplayed[prevIdx]?.issue.id ?? null;
            const nextSelectedId = nextDisplayed[nextIdx]?.issue.id ?? null;
            const detailScrollOffset = prevSelectedId !== null && prevSelectedId === nextSelectedId ? previousScroll : 0;
            return {
                phase: "ready",
                issues,
                activeTab,
                issuesIndex,
                worktreesIndex,
                orchestrateIndex,
                selectedIds,
                selectedWorktreeIds,
                detailScrollOffset,
                refreshing: false,
                overlay: previousOverlay,
                toast: previousToast,
                filter,
            };
        });
    };
    useEffect(() => {
        void refresh();
        // Cheap meta-info for the header row, fetched once on mount.
        (async () => {
            const repo = await tryExec("gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null");
            setRepoName(repo);
            const bin = resolveClaudeBinary();
            if (bin) {
                const v = await tryExec(`"${bin}" --version 2>/dev/null | head -1`);
                if (v) {
                    const m = v.match(/([\d.]+)/);
                    setClaudeVersion(m && m[1] ? m[1] : v);
                }
            }
            const latest = await getLatestVersion("mintree");
            if (latest && isNewerVersion(mintreeVersion, latest)) {
                setLatestVersion(latest);
            }
        })();
    }, []);
    // SGR mouse tracking: enable on mount, disable on unmount, and route
    // wheel events. Press/release/drag are ignored — we only care about
    // scroll. Wheel button 64 = up, 65 = down.
    useEffect(() => {
        if (!process.stdin.isTTY)
            return;
        process.stdout.write(MOUSE_ON);
        const onData = (data) => {
            const str = data.toString("utf-8");
            MOUSE_SGR_RE.lastIndex = 0;
            let match;
            while ((match = MOUSE_SGR_RE.exec(str)) !== null) {
                if (match[4] !== "M")
                    continue;
                const button = parseInt(match[1], 10);
                if (button !== 64 && button !== 65)
                    continue;
                const col = parseInt(match[2], 10);
                const delta = button === 65 ? SCROLL_STEP : -SCROLL_STEP;
                const lw = listWidthRef.current;
                const inLeftPane = col <= lw;
                // Functional setState so a fast wheel doesn't read stale
                // scroll/selection through the ref between dispatches.
                setState((prev) => {
                    if (prev.phase !== "ready")
                        return prev;
                    if (prev.overlay)
                        return prev; // overlay pauses scroll routing
                    if (inLeftPane) {
                        const { displayed, selectedIndex } = currentSelected(prev);
                        const next = Math.max(0, Math.min(displayed.length - 1, selectedIndex + delta));
                        if (next === selectedIndex)
                            return prev;
                        return { ...withSelectedIndex(prev, next), detailScrollOffset: 0 };
                    }
                    const next = Math.max(0, prev.detailScrollOffset + delta);
                    if (next === prev.detailScrollOffset)
                        return prev;
                    return { ...prev, detailScrollOffset: next };
                });
            }
        };
        process.stdin.on("data", onData);
        return () => {
            process.stdout.write(MOUSE_OFF);
            process.stdin.removeListener("data", onData);
        };
    }, []);
    // While the create overlay is open, ink-text-input owns stdin and reads
    // the leading ESC of every mouse report as key.escape — which dismisses
    // the overlay on any click/scroll. Pause SGR tracking until the overlay
    // closes, then re-enable.
    useEffect(() => {
        if (state.phase !== "ready" || !state.overlay)
            return;
        if (!process.stdin.isTTY)
            return;
        process.stdout.write(MOUSE_OFF);
        return () => {
            // Skip on unmount: re-enabling mouse tracking here would survive the
            // dashboard exit and break scroll in the terminal Claude inherits.
            if (tearingDown.current)
                return;
            process.stdout.write(MOUSE_ON);
        };
    }, [state.phase === "ready" && state.overlay ? state.overlay.kind : null]);
    // Auto-refresh every 5 minutes while the dashboard is idle. 30s was too
    // aggressive for an issue list — most of the time nothing has changed,
    // and even a single GraphQL refresh isn't worth firing twice a minute.
    // Press `r` for an immediate refresh when something changed externally.
    // Skipped while an overlay is open so we don't yank state from under a
    // confirmation, and while a manual refresh is in flight to avoid
    // stomping on its spinner.
    const stateRef = useRef(state);
    useEffect(() => {
        stateRef.current = state;
    }, [state]);
    useEffect(() => {
        const id = setInterval(() => {
            const s = stateRef.current;
            if (s.phase !== "ready")
                return;
            if (s.overlay)
                return;
            if (s.refreshing)
                return;
            void refresh();
        }, 5 * 60 * 1000);
        return () => clearInterval(id);
    }, []);
    useInput((input, key) => {
        // Esc closes the create overlay first if it's open; only then quits the
        // dashboard. Ctrl-C and `q` always quit (the desc TextInput swallows
        // raw `q` when it has focus, so `q` while editing types a literal q).
        if (state.phase === "ready" && state.overlay) {
            handleOverlayInput(input, key);
            return;
        }
        // Esc clears an active numeric filter before it falls through to quit —
        // so the user can back out of a search without leaving the dashboard.
        if (key.escape && state.phase === "ready" && state.filter) {
            setState({
                ...state,
                filter: "",
                issuesIndex: 0,
                worktreesIndex: 0,
                orchestrateIndex: 0,
                detailScrollOffset: 0,
            });
            return;
        }
        if (input === "q" || key.escape || (input === "c" && key.ctrl)) {
            exit();
            return;
        }
        if (state.phase !== "ready")
            return;
        // Numeric filter: typing a digit narrows the list by ticket number
        // (matched on the digits of the id, so "34" hits both BE-234 and BE-34).
        // Backspace pops a digit; Esc (handled above) clears it. Reset selection
        // to the first match so the cursor stays on a visible row as it narrows.
        if (/^[0-9]$/.test(input)) {
            setState({
                ...state,
                filter: state.filter + input,
                issuesIndex: 0,
                worktreesIndex: 0,
                orchestrateIndex: 0,
                detailScrollOffset: 0,
            });
            return;
        }
        if ((key.backspace || key.delete) && state.filter) {
            setState({
                ...state,
                filter: state.filter.slice(0, -1),
                issuesIndex: 0,
                worktreesIndex: 0,
                orchestrateIndex: 0,
                detailScrollOffset: 0,
            });
            return;
        }
        if (key.leftArrow || key.rightArrow) {
            // Cycle through the three tabs; → advances, ← goes back. Per-tab
            // indices are preserved, so the user returns to the row they left.
            const cur = TAB_ORDER.indexOf(state.activeTab);
            const delta = key.leftArrow ? -1 : 1;
            const next = TAB_ORDER[(cur + delta + TAB_ORDER.length) % TAB_ORDER.length];
            setState({ ...state, activeTab: next, detailScrollOffset: 0 });
            return;
        }
        if (key.upArrow || input === "k") {
            const { selectedIndex } = currentSelected(state);
            const nextIndex = Math.max(0, selectedIndex - 1);
            setState({ ...withSelectedIndex(state, nextIndex), detailScrollOffset: 0 });
            return;
        }
        if (key.downArrow || input === "j") {
            const { displayed, selectedIndex } = currentSelected(state);
            const nextIndex = Math.min(Math.max(0, displayed.length - 1), selectedIndex + 1);
            setState({ ...withSelectedIndex(state, nextIndex), detailScrollOffset: 0 });
            return;
        }
        if (key.pageUp) {
            setState({
                ...state,
                detailScrollOffset: Math.max(0, state.detailScrollOffset - SCROLL_STEP),
            });
            return;
        }
        if (key.pageDown) {
            setState({
                ...state,
                detailScrollOffset: state.detailScrollOffset + SCROLL_STEP,
            });
            return;
        }
        if (input === "r") {
            setState({ ...state, refreshing: true });
            // Manual refresh bypasses the Linear snapshot cache: the user pressed
            // `r` to see a change they just made externally (e.g. a freshly
            // assigned ticket), so serving cached data would defeat the gesture.
            void refresh({ forceRefresh: true });
            return;
        }
        // Worktrees tab: Space toggles the worktree under the cursor into the
        // remove batch; `a` toggles all visible worktrees. Mirrors Orchestrate.
        if (state.activeTab === "worktrees" && input === " ") {
            const { displayed, selectedIndex } = currentSelected(state);
            const issue = displayed[selectedIndex];
            if (!issue || !issue.worktree)
                return;
            const next = new Set(state.selectedWorktreeIds);
            if (next.has(issue.issue.id))
                next.delete(issue.issue.id);
            else
                next.add(issue.issue.id);
            setState({ ...state, selectedWorktreeIds: next });
            return;
        }
        if (state.activeTab === "worktrees" && input === "a") {
            const { displayed } = currentSelected(state);
            const selectable = displayed.filter((d) => d.worktree);
            const allSelected = selectable.length > 0 && selectable.every((d) => state.selectedWorktreeIds.has(d.issue.id));
            const next = new Set(state.selectedWorktreeIds);
            for (const d of selectable) {
                if (allSelected)
                    next.delete(d.issue.id);
                else
                    next.add(d.issue.id);
            }
            setState({ ...state, selectedWorktreeIds: next });
            return;
        }
        // Orchestrate tab: Space toggles the ticket under the cursor; `a`
        // toggles all visible tickets at once.
        if (state.activeTab === "orchestrate" && input === " ") {
            const { displayed, selectedIndex } = currentSelected(state);
            const issue = displayed[selectedIndex];
            if (!issue)
                return;
            const next = new Set(state.selectedIds);
            if (next.has(issue.issue.id))
                next.delete(issue.issue.id);
            else
                next.add(issue.issue.id);
            setState({ ...state, selectedIds: next });
            return;
        }
        if (state.activeTab === "orchestrate" && input === "a") {
            const { displayed } = currentSelected(state);
            const allSelected = displayed.length > 0 && displayed.every((d) => state.selectedIds.has(d.issue.id));
            const next = new Set(state.selectedIds);
            for (const d of displayed) {
                if (allSelected)
                    next.delete(d.issue.id);
                else
                    next.add(d.issue.id);
            }
            setState({ ...state, selectedIds: next });
            return;
        }
        if (input === "o") {
            const { displayed, selectedIndex } = currentSelected(state);
            const issue = displayed[selectedIndex];
            // Orphan rows carry an empty URL — nothing to open. Skip silently
            // rather than asking the OS to open an empty string.
            if (issue && issue.issue.url)
                openInBrowser(issue.issue.url);
            return;
        }
        if (input === "w") {
            const { displayed, selectedIndex } = currentSelected(state);
            const issue = displayed[selectedIndex];
            if (!issue)
                return;
            if (issue.worktree) {
                // Already has a worktree — `w` would be a no-op; `↵` resumes.
                return;
            }
            openCreateOverlay(issue);
            return;
        }
        if (key.return) {
            // Orchestrate tab: Enter opens the confirm overlay for the checked
            // tickets (where the user can add an extra message) instead of
            // resuming/creating a single worktree.
            if (state.activeTab === "orchestrate") {
                openOrchestrateOverlay();
                return;
            }
            const { displayed, selectedIndex } = currentSelected(state);
            const issue = displayed[selectedIndex];
            if (!issue)
                return;
            if (issue.worktree) {
                // Resume Claude in the existing worktree: same marker handshake
                // as `worktree create --work`, minus the create. The wrapper
                // will cd + run `mintree worktree work`, which itself sees the
                // session_id in metadata and uses --resume.
                emitMarkers([`MINTREE_CD:${issue.worktree.path}`, "MINTREE_WORK:1"]);
                exit();
                return;
            }
            openCreateOverlay(issue);
            return;
        }
        if (input === "d") {
            const { displayed, selectedIndex } = currentSelected(state);
            // On the Worktrees tab, a checked batch takes precedence over the row
            // under the cursor — so `d` removes everything you selected with Space.
            const batch = state.activeTab === "worktrees"
                ? displayed.filter((d) => state.selectedWorktreeIds.has(d.issue.id) && d.worktree)
                : [];
            let targets;
            if (batch.length > 0) {
                targets = batch.map(toRemoveTarget);
            }
            else {
                const issue = displayed[selectedIndex];
                if (!issue || !issue.worktree)
                    return;
                targets = [toRemoveTarget(issue)];
            }
            setState({
                ...state,
                overlay: { kind: "remove", targets, error: null, progress: null },
                toast: null,
            });
            return;
        }
    });
    function openOrchestrateOverlay() {
        if (state.phase !== "ready")
            return;
        const { displayed } = currentSelected(state);
        // Preserve the display order; only keep ids that are actually visible
        // and checked.
        const ids = displayed.filter((d) => state.selectedIds.has(d.issue.id)).map((d) => d.issue.id);
        if (ids.length === 0) {
            setState({
                ...state,
                toast: {
                    kind: "error",
                    text: "Seleccioná al menos un ticket (Space) antes de orquestar.",
                },
            });
            return;
        }
        const root = findMainRepoRoot();
        if (!root) {
            setState({ ...state, toast: { kind: "error", text: "No estás en un repositorio git." } });
            return;
        }
        const meta = readMetadata(root);
        const idList = ids.join(", ");
        const prompt = meta.orchestratorPromptTemplate
            ? renderOrchestratorTemplate(meta.orchestratorPromptTemplate, {
                ids: idList,
                count: ids.length,
            })
            : defaultOrchestratorPrompt(idList);
        setState({
            ...state,
            overlay: {
                kind: "orchestrate",
                ids,
                prompt,
                repoRoot: root,
                permissionMode: meta.defaultPermissionMode ?? "default",
                rcName: buildOrchestratorRcName(ids),
                error: null,
            },
            toast: null,
        });
    }
    function confirmOrchestrate(overlay) {
        if (state.phase !== "ready")
            return;
        const prompt = overlay.prompt.trim();
        const promptFile = writePromptFile(prompt);
        emitMarkers(buildOrchestrateMarkers({
            repoRoot: overlay.repoRoot,
            promptFile,
            permissionMode: overlay.permissionMode,
            rcName: overlay.rcName ?? undefined,
        }));
        exit();
    }
    function openCreateOverlay(issue) {
        if (state.phase !== "ready")
            return;
        const root = findMainRepoRoot();
        // On a Linear repo, prefer the branch Linear suggests for the issue
        // (its `branchName`) over the synthesised `<type>/<issue>-<desc>` form —
        // that's the convention those repos actually follow. Falls back to the
        // convention form when the issue has no branchName.
        const meta = root ? readMetadata(root) : undefined;
        const provider = meta?.provider;
        const linearBranch = provider === "linear" && issue.issue.branchName ? issue.issue.branchName : null;
        setState({
            ...state,
            overlay: {
                kind: "create",
                issue,
                branchMode: "new",
                currentBranch: root ? getCurrentBranch(root) : null,
                type: "feat",
                desc: kebabize(issue.issue.title) || `issue-${issue.issue.id}`,
                linearBranch,
                prompt: defaultPromptForIssue(issue.issue.id, issue.issue.title, issue.issue.url, meta?.promptTemplate),
                field: "branchMode",
                error: null,
                conventionDoc: root ? findBranchConventionDoc(root) : null,
                pending: null,
                steps: [],
            },
            toast: null,
        });
    }
    function handleOverlayInput(input, key) {
        if (state.phase !== "ready" || !state.overlay)
            return;
        const overlay = state.overlay;
        // When a create overlay is finishing its post-create transition the
        // worktree is already on disk and we're about to exit() — freeze the
        // overlay so escape / stray keys don't dismiss it mid-flight.
        if (overlay.kind === "create" && overlay.pending) {
            return;
        }
        // Same idea while a batch removal is running: git is already deleting
        // worktrees, so Esc can't undo anything — it would only hide the progress.
        if (overlay.kind === "remove" && overlay.progress) {
            return;
        }
        if (key.escape || (input === "c" && key.ctrl)) {
            setState({ ...state, overlay: null });
            return;
        }
        if (overlay.kind === "remove") {
            handleRemoveOverlayInput(input, key, overlay);
            return;
        }
        if (overlay.kind === "orchestrate") {
            // The MultilineTextArea owns all text input: Enter inserts a newline,
            // Ctrl+X submits (→ confirmOrchestrate via onSubmit), Ctrl+G/Esc cancel.
            // Esc is already handled above; everything else falls through to it.
            return;
        }
        // In "current" branch mode (detached) and in the Linear-branchName case
        // we skip type+desc fields entirely — they have no meaning when the
        // branch is fixed (detached HEAD, or Linear's own `branchName`). Tab
        // cycles branchMode ⇄ prompt only.
        const skipTypeDesc = overlay.branchMode === "current" || overlay.linearBranch !== null;
        if (key.tab) {
            const order = skipTypeDesc
                ? ["branchMode", "prompt"]
                : ["branchMode", "type", "desc", "prompt"];
            const i = order.indexOf(overlay.field);
            const nextField = order[(i + 1) % order.length];
            setState({
                ...state,
                overlay: { ...overlay, field: nextField },
            });
            return;
        }
        if (overlay.field === "branchMode") {
            if (key.leftArrow || key.rightArrow || input === "h" || input === "l") {
                const next = overlay.branchMode === "new" ? "current" : "new";
                setState({ ...state, overlay: { ...overlay, branchMode: next, error: null } });
                return;
            }
        }
        if (overlay.field === "type") {
            if (key.leftArrow || input === "h") {
                const idx = ALLOWED_TYPES.indexOf(overlay.type);
                const next = ALLOWED_TYPES[(idx - 1 + ALLOWED_TYPES.length) % ALLOWED_TYPES.length];
                setState({ ...state, overlay: { ...overlay, type: next } });
                return;
            }
            if (key.rightArrow || input === "l") {
                const idx = ALLOWED_TYPES.indexOf(overlay.type);
                const next = ALLOWED_TYPES[(idx + 1) % ALLOWED_TYPES.length];
                setState({ ...state, overlay: { ...overlay, type: next } });
                return;
            }
        }
        // Enter confirms from the branch/type/desc fields. In the Prompt field the
        // MultilineTextArea owns Enter (inserts a newline) and Ctrl+X submits, so
        // we must NOT confirm here — otherwise Enter would launch mid-typing.
        if (key.return && overlay.field !== "prompt") {
            void confirmCreate(overlay);
            return;
        }
        // Any other input while in the desc/prompt fields is handled by the field's
        // own component (TextInput / MultilineTextArea), not here — useInput still
        // fires for those keystrokes but we want them to fall through.
    }
    function handleRemoveOverlayInput(input, key, overlay) {
        if (state.phase !== "ready")
            return;
        // Force-confirm with capital Y when any target is dirty; lowercase y
        // otherwise. In a batch a single dirty worktree gates the whole set
        // behind Y, same as the single-worktree flow. Enter alone counts as
        // "no" so a stray return never discards dirty state.
        const anyDirty = overlay.targets.some((t) => t.dirty);
        if (input === "y" && !anyDirty) {
            void confirmRemove(overlay, false);
            return;
        }
        if (input === "Y" && anyDirty) {
            void confirmRemove(overlay, true);
            return;
        }
        if (input === "n" || input === "N" || key.return) {
            setState({ ...state, overlay: null });
            return;
        }
    }
    async function confirmCreate(overlay) {
        if (state.phase !== "ready")
            return;
        // Validate first so we don't flash a spinner just to immediately show
        // a sync-fail message. A Linear-branch create needs no desc (the branch
        // is Linear's `branchName`), so only the convention path requires it.
        if (overlay.branchMode === "new" && !overlay.linearBranch && !overlay.desc.trim()) {
            setState({
                ...state,
                overlay: { ...overlay, error: "Description is required." },
            });
            return;
        }
        // Enter the live-setup view: clear input chrome, reset the step log,
        // show a starting spinner. The actual progress updates come through
        // the runCreate/runCreateDetached callbacks below.
        setState({
            ...state,
            overlay: { ...overlay, error: null, pending: "Starting...", steps: [] },
        });
        await new Promise((resolve) => setTimeout(resolve, FRAME_MS));
        // Progress callbacks invoked from inside runCreate/runCreateDetached.
        // Use functional setState so we don't clobber concurrent updates and
        // don't rely on the stale closure of `state`.
        const onStep = (step) => {
            setState((prev) => {
                if (prev.phase !== "ready" || prev.overlay?.kind !== "create")
                    return prev;
                return {
                    ...prev,
                    overlay: { ...prev.overlay, steps: [...prev.overlay.steps, step] },
                };
            });
        };
        const onPending = (label) => {
            setState((prev) => {
                if (prev.phase !== "ready" || prev.overlay?.kind !== "create")
                    return prev;
                return {
                    ...prev,
                    overlay: { ...prev.overlay, pending: label },
                };
            });
        };
        const prompt = overlay.prompt.trim();
        const issueId = overlay.issue.issue.id;
        let result;
        if (overlay.branchMode === "current") {
            // Detached worktree off the main repo's current branch. Desc comes
            // from the issue title (kebabized), not user input — keeping the
            // "current branch" flow as low-friction as possible.
            const descKebab = kebabize(overlay.issue.issue.title) || `issue-${issueId}`;
            result = await runCreateDetached({
                issueId,
                descKebab,
                work: true,
                progress: { onStep, onPending },
                ...(prompt.length > 0 ? { prompt } : {}),
            });
        }
        else {
            // Linear repos with a `branchName` use it verbatim; everyone else
            // synthesises the `<type>/<issue>-<desc>` convention branch.
            const branch = overlay.linearBranch ?? `${overlay.type}/${issueId}-${overlay.desc.trim()}`;
            result = await runCreate(branch, {
                work: true,
                progress: { onStep, onPending },
                ...(prompt.length > 0 ? { prompt } : {}),
            });
        }
        if (!result.ok) {
            setState((prev) => {
                if (prev.phase !== "ready" || prev.overlay?.kind !== "create")
                    return prev;
                return {
                    ...prev,
                    overlay: {
                        ...prev.overlay,
                        pending: null,
                        error: result.ok ? null : result.message + (result.hint ? ` — ${result.hint}` : ""),
                    },
                };
            });
            return;
        }
        // Worktree's on disk — keep the overlay visible while we move the issue
        // to In Progress on its project. Errors from the GraphQL call don't
        // block the worktree hand-off; we swallow them and let `mintree doctor`
        // surface persistent issues (missing `project` scope, etc.).
        // Functional update preserves the accumulated `steps` list from the
        // progress callbacks; using the stale `overlay` closure would wipe it.
        setState((prev) => {
            if (prev.phase !== "ready" || prev.overlay?.kind !== "create")
                return prev;
            return {
                ...prev,
                overlay: { ...prev.overlay, error: null, pending: "Updating issue status..." },
            };
        });
        const repoRoot = findMainRepoRoot();
        if (repoRoot) {
            try {
                const provider = createProvider(repoRoot);
                await provider.transitionIssueToInProgress(issueId);
            }
            catch {
                // best effort — surface via doctor / next dashboard refresh
            }
        }
        emitMarkers(buildCreateMarkers({
            worktreePath: result.worktreePath,
            work: result.work,
            promptFile: result.promptFile,
            permissionMode: result.permissionMode,
        }));
        exit();
    }
    async function confirmRemove(overlay, force) {
        if (state.phase !== "ready")
            return;
        // runRemove/runRemoveByPath are synchronous (execSync + rm -rf). Running
        // the whole batch in one tick blocks the event loop for as long as git
        // takes — with dozens of worktrees that's tens of seconds with the frozen
        // confirmation still on screen and no sign anything is happening. So we
        // remove one target per turn of the loop and yield in between, letting Ink
        // repaint the counter after each one.
        const targets = overlay.targets;
        const setProgress = (progress) => {
            setState((prev) => {
                if (prev.phase !== "ready" || prev.overlay?.kind !== "remove")
                    return prev;
                return { ...prev, overlay: { ...prev.overlay, error: null, progress } };
            });
        };
        const results = [];
        let failedCount = 0;
        for (const [i, t] of targets.entries()) {
            setProgress({
                done: i,
                total: targets.length,
                current: t.issue.issue.id,
                failed: failedCount,
            });
            // Give React/Ink a frame to paint the counter before we hand the thread
            // back to git for this target.
            await new Promise((resolve) => setTimeout(resolve, FRAME_MS));
            const result = t.branch ? runRemove(t.branch, force) : runRemoveByPath(t.worktreePath, force);
            results.push(result);
            if (!result.ok)
                failedCount += 1;
        }
        const ok = results.filter((r) => r.ok);
        const failed = results.filter((r) => !r.ok);
        // Nothing removed — keep the overlay open and surface the first error so
        // the user can react (e.g. a dirty worktree that needs Y).
        if (ok.length === 0) {
            const first = failed[0];
            const message = first
                ? first.message + (first.hint ? ` — ${first.hint}` : "")
                : "Removal failed.";
            // Functional update: `state` is the pre-loop closure and a refresh may
            // have landed while git was running.
            setState((prev) => {
                if (prev.phase !== "ready" || prev.overlay?.kind !== "remove")
                    return prev;
                return { ...prev, overlay: { ...prev.overlay, progress: null, error: message } };
            });
            return;
        }
        // Close the overlay, drop the removed rows from the selection, surface a
        // toast, and refetch so the rows update (worktree/session/PR flip back).
        const removedIds = new Set(targets.filter((t, i) => results[i]?.ok).map((t) => t.issue.issue.id));
        const text = targets.length === 1
            ? ok[0].variant === "pruned-orphan"
                ? `Pruned dangling reference for ${ok[0].branch}.`
                : ok[0].variant === "removed-unregistered"
                    ? `Deleted ${ok[0].branch} (it was no longer registered with git).`
                    : `Removed worktree for ${ok[0].branch}.${ok[0].wasDirty ? " (forced past dirty)" : ""}`
            : `Removed ${ok.length} worktree${ok.length === 1 ? "" : "s"}.${failed.length ? ` ${failed.length} failed.` : ""}`;
        setState((prev) => {
            if (prev.phase !== "ready")
                return prev;
            return {
                ...prev,
                overlay: null,
                selectedWorktreeIds: new Set([...prev.selectedWorktreeIds].filter((id) => !removedIds.has(id))),
                toast: { kind: failed.length ? "error" : "success", text },
            };
        });
        void refresh();
    }
    if (state.phase === "loading") {
        return (_jsxs(Box, { width: columns, height: rows, alignItems: "center", justifyContent: "center", children: [_jsx(Text, { color: "cyan", children: _jsx(Spinner, { type: "dots" }) }), _jsx(Text, { children: " Loading issues..." })] }));
    }
    if (state.phase === "error") {
        return (_jsxs(Box, { width: columns, height: rows, flexDirection: "column", borderStyle: "round", borderColor: "red", paddingX: 1, children: [_jsxs(Text, { color: "red", bold: true, children: ["\u2717 ", state.message] }), state.hint && (_jsx(Box, { marginTop: 1, children: _jsxs(Text, { color: "yellow", children: ["\u21B3 ", state.hint] }) })), _jsx(Box, { marginTop: 1, children: _jsx(FooterRow, { phase: "error" }) })] }));
    }
    const { issues, refreshing, overlay, toast, activeTab, filter, selectedIds, selectedWorktreeIds, } = state;
    const { displayed, selectedIndex } = currentSelected(state);
    const selected = displayed[selectedIndex] ?? null;
    const issuesTabCount = issues.reduce((n, d) => (isOrphan(d) ? n : n + 1), 0);
    const worktreesTabCount = issues.length - issuesTabCount;
    // The Orchestrate chip shows how many tickets are currently checked.
    const orchestrateTabCount = selectedIds.size;
    const onOverlayDescChange = (next) => {
        if (state.phase !== "ready" || !state.overlay)
            return;
        if (state.overlay.kind !== "create")
            return;
        setState({
            ...state,
            overlay: { ...state.overlay, desc: sanitizeDesc(next), error: null },
        });
    };
    // Shared by the create and orchestrate overlays — both carry an editable
    // `prompt` box seeded with the rendered template.
    const onOverlayPromptChange = (next) => {
        if (state.phase !== "ready" || !state.overlay)
            return;
        if (state.overlay.kind !== "create" && state.overlay.kind !== "orchestrate")
            return;
        setState({
            ...state,
            overlay: { ...state.overlay, prompt: next, error: null },
        });
    };
    // Ctrl+X in the Prompt textarea. Launches the flow the open overlay belongs to.
    const onOverlayPromptSubmit = () => {
        if (state.phase !== "ready" || !state.overlay)
            return;
        if (state.overlay.kind === "create")
            void confirmCreate(state.overlay);
        else if (state.overlay.kind === "orchestrate")
            confirmOrchestrate(state.overlay);
    };
    // Ctrl+G in the Prompt textarea — same as Esc: close the overlay.
    const onOverlayPromptCancel = () => {
        if (state.phase !== "ready")
            return;
        setState({ ...state, overlay: null });
    };
    // Prompt textarea geometry. Width tracks the terminal (capped so the box
    // doesn't sprawl); height is a bit smaller for the create overlay (it carries
    // more chrome above/below) than for the orchestrate one. Both clamp down on
    // short terminals — the box scrolls internally, so a small height still works.
    const boxWidth = Math.max(20, Math.min(columns - 8, 100));
    const createBoxHeight = Math.max(4, Math.min(8, rows - 20));
    const orchestrateBoxHeight = Math.max(4, Math.min(12, rows - 14));
    // Rows the remove overlay may spend listing targets. The rest of its chrome
    // (title, the note, the confirm/progress line, borders, header, footer) eats
    // roughly a dozen rows — reserving them keeps the progress line on screen for
    // a 100-worktree batch.
    const removeListRows = Math.max(3, rows - 16);
    // Left pane is the issue list — santree gives it ~half the width and the
    // detail pane still has room for URLs, descriptions and branch paths
    // because long lines wrap within the pane.
    const listWidthPct = 0.5;
    const listWidth = Math.max(32, Math.floor(columns * listWidthPct));
    const detailWidth = columns - listWidth - 2; // border slack
    const identifierWidth = Math.max(3, ...displayed.map((d) => d.issue.id.length));
    // Reserve rows: header (2), top borders (1), footer (3).
    const listVisibleRows = Math.max(3, rows - 9);
    // Detail pane content height inside the bordered box. Header eats 2 rows,
    // the box's borders eat 2, the footer eats 2-3 — match the list reserve so
    // both panes anchor to the same outer chrome.
    const detailContentHeight = Math.max(3, rows - 9);
    // Mouse handler needs the current list width to route wheel events to the
    // correct pane. Ref lets the stdin listener (mounted once) read the live
    // value without re-binding on every resize.
    listWidthRef.current = listWidth;
    // Grouped list: build the project/status header rows interleaved with
    // issue rows, then split into a sticky header region (the selected issue's
    // project + Status, pinned to the top) and a windowed scrollable body.
    // The Worktrees tab renders flat — the tab title already labels the group,
    // so the per-project headers would just be visual noise.
    const listRows = activeTab === "issues"
        ? buildListRows(displayed)
        : displayed.map((d, index) => ({ kind: "issue", d, index }));
    const listView = windowListRows(listRows, selectedIndex, listVisibleRows);
    const listContentWidth = Math.max(8, listWidth - 4);
    return (_jsxs(Box, { flexDirection: "column", width: columns, height: rows, children: [_jsx(Box, { paddingX: 1, paddingTop: 0, flexDirection: "column", children: _jsx(HeaderRow, { repoName: repoName, claudeVersion: claudeVersion, issueCount: issuesTabCount, worktreeCount: worktreesTabCount, orchestrateCount: orchestrateTabCount, activeTab: activeTab, updateAvailable: latestVersion !== null }) }), overlay ? (_jsx(Box, { flexGrow: 1, flexDirection: "column", borderStyle: "round", borderColor: overlay.kind === "remove" ? "yellow" : "cyan", children: overlay.kind === "create" ? (_jsx(CreateOverlayView, { overlay: overlay, onDescChange: onOverlayDescChange, onPromptChange: onOverlayPromptChange, onPromptSubmit: onOverlayPromptSubmit, onPromptCancel: onOverlayPromptCancel, boxWidth: boxWidth, boxHeight: createBoxHeight })) : overlay.kind === "orchestrate" ? (_jsx(OrchestrateOverlayView, { overlay: overlay, onPromptChange: onOverlayPromptChange, onPromptSubmit: onOverlayPromptSubmit, onPromptCancel: onOverlayPromptCancel, boxWidth: boxWidth, boxHeight: orchestrateBoxHeight })) : (_jsx(RemoveOverlayView, { overlay: overlay, maxListRows: removeListRows })) })) : (_jsxs(Box, { flexGrow: 1, flexDirection: "row", children: [_jsx(Box, { width: listWidth, flexDirection: "column", borderStyle: "round", borderColor: "gray", paddingX: 1, children: displayed.length === 0 ? (_jsx(Text, { dimColor: true, children: filter
                                ? `No tickets match #${filter} — Esc to clear the filter.`
                                : activeTab === "worktrees"
                                    ? "No orphaned worktrees — anything in `.mintree/worktrees/` matches an open issue."
                                    : "No open issues assigned to you in this repo." })) : (_jsxs(_Fragment, { children: [listView.sticky.map((row, i) => (_jsx(ListRowView, { row: row, selectedIndex: selectedIndex, identifierWidth: identifierWidth, width: listContentWidth, selectedIds: activeTab === "orchestrate"
                                        ? selectedIds
                                        : activeTab === "worktrees"
                                            ? selectedWorktreeIds
                                            : undefined }, `sticky-${i}`))), listView.issuesAbove > 0 && (_jsxs(Text, { dimColor: true, children: ["\u2191 ", listView.issuesAbove, " more above"] })), listView.body.map((row, i) => (_jsx(ListRowView, { row: row, selectedIndex: selectedIndex, identifierWidth: identifierWidth, width: listContentWidth, selectedIds: activeTab === "orchestrate"
                                        ? selectedIds
                                        : activeTab === "worktrees"
                                            ? selectedWorktreeIds
                                            : undefined }, `body-${i}`))), listView.issuesBelow > 0 && (_jsxs(Text, { dimColor: true, children: ["\u2193 ", listView.issuesBelow, " more below"] }))] })) }), _jsx(Box, { width: detailWidth, flexDirection: "column", borderStyle: "round", borderColor: "gray", paddingX: 1, children: _jsx(DetailPane, { d: selected, contentWidth: detailWidth - 4, contentHeight: detailContentHeight, scrollOffset: state.detailScrollOffset }) })] })), _jsxs(Box, { paddingX: 1, flexDirection: "column", children: [filter && (_jsxs(Box, { children: [_jsx(Text, { color: "cyan", bold: true, children: `⌕ #${filter}` }), _jsx(Text, { dimColor: true, children: ` · ${displayed.length} match${displayed.length === 1 ? "" : "es"} · Esc clear` })] })), toast && (_jsx(Box, { children: _jsxs(Text, { color: toast.kind === "success" ? "green" : toast.kind === "error" ? "red" : "cyan", children: [toast.kind === "success" ? "✓ " : toast.kind === "error" ? "✗ " : "· ", toast.text] }) })), refreshing && (_jsxs(Box, { children: [_jsx(Text, { color: "cyan", children: _jsx(Spinner, { type: "dots" }) }), _jsx(Text, { dimColor: true, children: " refreshing" })] })), _jsx(FooterRow, { phase: "ready", overlayKind: overlay?.kind, latestVersion: latestVersion, listWidth: listWidth, activeTab: activeTab, selectedCount: activeTab === "worktrees" ? selectedWorktreeIds.size : orchestrateTabCount })] })] }));
}

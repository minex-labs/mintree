import * as fs from "fs";
import * as path from "path";
import { getMetadataPath } from "./git.js";
import { PERMISSION_MODES } from "./claude.js";
const EMPTY = { version: 1, issues: {} };
function sanitizeProvider(raw) {
    if (raw === "github" || raw === "linear")
        return raw;
    return undefined;
}
function sanitizePermissionMode(raw) {
    return PERMISSION_MODES.includes(raw) ? raw : undefined;
}
function sanitizePromptTemplate(raw) {
    return typeof raw === "string" && raw.trim().length > 0 ? raw : undefined;
}
function sanitizeOrchestratorPromptTemplate(raw) {
    return typeof raw === "string" && raw.trim().length > 0 ? raw : undefined;
}
/**
 * Normalises one raw `linkFiles` element into `{ path, mode }`. Accepts both
 * on-disk shapes: a bare string (the pre-modes shape, meaning "copy") and an
 * object with an explicit `mode`. An unrecognised `mode` falls back to "copy"
 * rather than being dropped — a typo shouldn't silently stop a `.env` from
 * reaching new worktrees, and "copy" is the conservative side (it can't mutate
 * the main checkout's file).
 */
function sanitizeLinkFileEntry(raw) {
    if (typeof raw === "string")
        return { path: raw, mode: "copy" };
    if (typeof raw !== "object" || raw === null)
        return undefined;
    const r = raw;
    if (typeof r["path"] !== "string")
        return undefined;
    return { path: r["path"], mode: r["mode"] === "link" ? "link" : "copy" };
}
/**
 * Keeps only safe, repo-root-relative paths. Drops blanks, absolute paths and
 * any entry that escapes the repo root via `..` — a malicious / fat-fingered
 * `metadata.json` must never make mintree copy something outside the worktree,
 * nor (now that "link" exists) point a symlink at an arbitrary path. Normalises
 * and de-dupes the survivors by path; on a duplicate path the first entry wins,
 * so a later contradictory mode can't quietly override the earlier one.
 */
function sanitizeLinkFiles(raw) {
    if (!Array.isArray(raw))
        return undefined;
    const out = [];
    const seen = new Set();
    for (const v of raw) {
        const entry = sanitizeLinkFileEntry(v);
        if (!entry)
            continue;
        const trimmed = entry.path.trim();
        if (trimmed.length === 0 || path.isAbsolute(trimmed))
            continue;
        const norm = path.normalize(trimmed);
        if (norm === ".." ||
            norm.startsWith(`..${path.sep}`) ||
            norm.includes(`${path.sep}..${path.sep}`)) {
            continue;
        }
        if (seen.has(norm))
            continue;
        seen.add(norm);
        out.push({ path: norm, mode: entry.mode });
    }
    return out.length > 0 ? out : undefined;
}
/**
 * Inverse of `sanitizeLinkFiles` for persistence: "copy" entries go back out as
 * bare strings so a metadata file that never opted into modes round-trips
 * unchanged through the read/write cycle that every `upsertIssue` performs.
 */
function serializeLinkFiles(entries) {
    return entries.map((e) => (e.mode === "copy" ? e.path : e));
}
function sanitizeLinearTeam(raw) {
    if (typeof raw !== "object" || raw === null)
        return undefined;
    const r = raw;
    if (typeof r["key"] !== "string" || r["key"].length === 0)
        return undefined;
    const out = { key: r["key"] };
    if (typeof r["name"] === "string" && r["name"].length > 0)
        out.name = r["name"];
    return out;
}
function sanitizeLinear(raw) {
    if (typeof raw !== "object" || raw === null)
        return undefined;
    const r = raw;
    if (typeof r["workspaceSlug"] !== "string" || r["workspaceSlug"].length === 0)
        return undefined;
    const teamsRaw = Array.isArray(r["teams"]) ? r["teams"] : [];
    const teams = [];
    for (const t of teamsRaw) {
        const sanitized = sanitizeLinearTeam(t);
        if (sanitized)
            teams.push(sanitized);
    }
    const out = {
        workspaceSlug: r["workspaceSlug"],
        teams,
    };
    if (typeof r["apiUrl"] === "string" && r["apiUrl"].length > 0)
        out.apiUrl = r["apiUrl"];
    if (typeof r["inProgressStateName"] === "string" && r["inProgressStateName"].length > 0) {
        out.inProgressStateName = r["inProgressStateName"];
    }
    if (Array.isArray(r["protectedStateTypes"])) {
        const arr = r["protectedStateTypes"].filter((v) => typeof v === "string" && v.length > 0);
        if (arr.length > 0)
            out.protectedStateTypes = arr;
    }
    return out;
}
function sanitizeProject(raw) {
    if (typeof raw !== "object" || raw === null)
        return undefined;
    const r = raw;
    const out = {};
    if (typeof r["url"] === "string" && r["url"].length > 0)
        out.url = r["url"];
    if (typeof r["statusField"] === "string" && r["statusField"].length > 0) {
        out.statusField = r["statusField"];
    }
    if (typeof r["inProgressOption"] === "string" && r["inProgressOption"].length > 0) {
        out.inProgressOption = r["inProgressOption"];
    }
    if (Array.isArray(r["protectedStatuses"])) {
        const arr = r["protectedStatuses"].filter((v) => typeof v === "string" && v.length > 0);
        if (arr.length > 0)
            out.protectedStatuses = arr;
    }
    return Object.keys(out).length > 0 ? out : undefined;
}
export function readMetadata(repoRoot) {
    const filePath = getMetadataPath(repoRoot);
    if (!fs.existsSync(filePath))
        return { ...EMPTY, issues: {} };
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        if (typeof parsed !== "object" || parsed === null)
            return { ...EMPTY, issues: {} };
        const project = sanitizeProject(parsed.project);
        const provider = sanitizeProvider(parsed.provider);
        const linear = sanitizeLinear(parsed.linear);
        const defaultPermissionMode = sanitizePermissionMode(parsed.defaultPermissionMode);
        const promptTemplate = sanitizePromptTemplate(parsed.promptTemplate);
        const orchestratorPromptTemplate = sanitizeOrchestratorPromptTemplate(parsed.orchestratorPromptTemplate);
        const linkFiles = sanitizeLinkFiles(parsed.linkFiles);
        return {
            version: 1,
            issues: typeof parsed.issues === "object" && parsed.issues !== null
                ? parsed.issues
                : {},
            ...(provider ? { provider } : {}),
            ...(project ? { project } : {}),
            ...(linear ? { linear } : {}),
            ...(defaultPermissionMode ? { defaultPermissionMode } : {}),
            ...(promptTemplate ? { promptTemplate } : {}),
            ...(orchestratorPromptTemplate ? { orchestratorPromptTemplate } : {}),
            ...(linkFiles ? { linkFiles } : {}),
        };
    }
    catch {
        return { ...EMPTY, issues: {} };
    }
}
export function writeMetadata(repoRoot, data) {
    const filePath = getMetadataPath(repoRoot);
    const onDisk = {
        ...data,
        ...(data.linkFiles ? { linkFiles: serializeLinkFiles(data.linkFiles) } : {}),
    };
    fs.writeFileSync(filePath, JSON.stringify(onDisk, null, 2) + "\n");
}
/**
 * Merges `partial` into the metadata entry for `issueId`, creating the entry
 * if missing. Persists the result. Existing fields not present in `partial`
 * are preserved.
 */
export function upsertIssue(repoRoot, issueId, partial) {
    const data = readMetadata(repoRoot);
    const previous = data.issues[issueId] ?? {};
    data.issues[issueId] = { ...previous, ...partial };
    writeMetadata(repoRoot, data);
    return data;
}
/**
 * Removes the metadata entry for `issueId` entirely (session_id included) and
 * persists the result. No-op — and no rewrite — when there's no such entry, so
 * callers can invoke it unconditionally. Returns true when an entry was
 * actually removed. Used by `worktree clean`, where the worktree's PR is
 * merged/closed and the issue is done, so keeping the entry (and its stale
 * session_id) around would only let it accumulate forever.
 */
export function removeIssue(repoRoot, issueId) {
    const data = readMetadata(repoRoot);
    if (!(issueId in data.issues))
        return false;
    delete data.issues[issueId];
    writeMetadata(repoRoot, data);
    return true;
}
/**
 * Records whether this issue's worktree finished its post-create `init.sh`.
 * Writes the flag on failure and REMOVES it on success, so the mere presence of
 * `init_failed` means "this worktree is not initialised" — callers can test the
 * key without having to distinguish false from absent. No-op when clearing an
 * entry that was already clean, to avoid rewriting metadata on every create.
 */
export function setInitFailed(repoRoot, issueId, failed) {
    const data = readMetadata(repoRoot);
    const previous = data.issues[issueId] ?? {};
    if (!failed && previous.init_failed === undefined)
        return;
    if (failed) {
        data.issues[issueId] = { ...previous, init_failed: true };
    }
    else {
        const next = { ...previous };
        delete next.init_failed;
        data.issues[issueId] = next;
    }
    writeMetadata(repoRoot, data);
}
export function getSessionId(repoRoot, issueId) {
    return readMetadata(repoRoot).issues[issueId]?.session_id;
}
export function setSessionId(repoRoot, issueId, sessionId) {
    upsertIssue(repoRoot, issueId, { session_id: sessionId });
}

import * as fs from "fs";
import * as path from "path";
import { getMetadataPath } from "./git.js";
import { PERMISSION_MODES, type PermissionMode } from "./claude.js";

export type IssueMeta = {
	base_branch?: string;
	session_id?: string;
	// Set when this worktree's post-create `.mintree/init.sh` hook failed, and
	// cleared when a later run succeeds. The hook is what makes a worktree
	// self-contained (isolated docker project name, per-worktree ports); a
	// worktree whose hook failed looks healthy but may be pointed at the main
	// checkout's stack, so the failure is recorded rather than left as
	// scrollback the user already lost.
	init_failed?: boolean;
};

// How a `linkFiles` entry is materialised into a new worktree.
//   - "copy": each worktree gets its OWN file. Per-worktree edits (a port, a
//     feature flag) stay local, but rotating a credential in the main checkout
//     does NOT propagate to already-created worktrees.
//   - "link": a relative symlink back to the main checkout. Single source of
//     truth — a rotated credential is picked up everywhere — at the cost of
//     per-worktree edits mutating the shared file.
// Pick per entry: shared credentials (`.env.local`) want "link"; anything the
// worktree is supposed to own or that a post-create hook regenerates (`.env`)
// wants "copy", or belongs out of the list entirely.
export type LinkFileMode = "copy" | "link";

export type LinkFileEntry = {
	// Repo-root-relative path. Validated by `sanitizeLinkFiles`.
	path: string;
	mode: LinkFileMode;
};

export type ProjectMeta = {
	// Project URL (e.g. https://github.com/orgs/<org>/projects/<n>). Optional;
	// when set, narrows auto-discovery to a single project so transitions
	// don't get skipped on `skip-ambiguous`.
	url?: string;
	// Name of the single-select field that holds the workflow status.
	// Defaults to "Status" when omitted.
	statusField?: string;
	// Name of the option to set when work starts. Defaults to "In Progress".
	inProgressOption?: string;
	// Statuses whose presence should keep mintree from overwriting (typically
	// PR-driven later stages). Defaults to ["In Review", "Done"].
	protectedStatuses?: string[];
};

export type ProviderKind = "github" | "linear";

export type LinearTeamRef = {
	// Linear team key (e.g. "FE" in FE-123). Used to filter work items and
	// round-trip between branch names and Linear identifiers.
	key: string;
	// Human-readable team name (e.g. "Frontend"). Optional; surfaces in
	// dashboard group headers when present.
	name?: string;
};

export type LinearMeta = {
	// Defaults to https://api.linear.app/graphql. Override only if you're
	// behind a corporate proxy / self-hosted endpoint.
	apiUrl?: string;
	// Workspace URL key (the "acme" in linear.app/acme).
	// Required when provider === "linear" — used to build issue URLs and
	// surface in doctor.
	workspaceSlug: string;
	// One or more Linear teams this repo tracks. mintree filters assigned
	// work items by `team.key in [...]`.
	teams: LinearTeamRef[];
	// Name of the workflow state to set when work starts. When omitted, the
	// provider picks the first state with type === "started".
	inProgressStateName?: string;
	// Workflow state types whose presence should keep mintree from
	// overwriting. Defaults to ["completed", "canceled"] — already-done work
	// shouldn't be dragged back to In Progress.
	protectedStateTypes?: string[];
};

export type Metadata = {
	version: 1;
	// Selects which IssueProvider mintree uses. Omitted = "github" for
	// back-compat with repos initialised before the provider field existed.
	provider?: ProviderKind;
	issues: Record<string, IssueMeta>;
	project?: ProjectMeta;
	linear?: LinearMeta;
	// Default Claude `--permission-mode` for sessions mintree launches in this
	// repo (worktree work / create --work / dashboard `w` + `↵`). The
	// `--permission-mode` CLI flag still overrides it per-launch. Omitted =
	// "default" (the stricter mode). Set to "auto" to launch in auto-accept.
	defaultPermissionMode?: PermissionMode;
	// Template for the initial prompt seeded when launching Claude for an
	// issue. Supports the placeholders {{id}}, {{title}} and {{url}}. When
	// omitted, mintree falls back to its built-in provider-aware default.
	promptTemplate?: string;
	// Template for the message handed to the orchestrator Claude launched from
	// the dashboard's Orchestrate tab (or `mintree orchestrate`). Supports the
	// placeholders {{ids}} (comma-separated selected ticket ids) and {{count}}.
	// When omitted, mintree falls back to a built-in default.
	orchestratorPromptTemplate?: string;
	// Gitignored files (relative to the repo root) that mintree materialises
	// into every new worktree right after creating it — typically `.env`. Git
	// worktrees don't share untracked files, so secrets/config live only in the
	// main checkout; this brings them in so per-worktree tooling (tests, dev
	// servers) finds them.
	//
	// Each entry carries its own `mode` (see LinkFileMode). On disk an entry may
	// be written either as a bare string (= mode "copy", the shape that predates
	// modes) or as `{ "path": "...", "mode": "link" }`; `readMetadata` normalises
	// both into LinkFileEntry, and `writeMetadata` serialises "copy" entries back
	// to bare strings so existing metadata files don't churn.
	//
	// Entries must be repo-root-relative and may not escape it (no absolute
	// paths, no `..`).
	linkFiles?: LinkFileEntry[];
};

const EMPTY: Metadata = { version: 1, issues: {} };

function sanitizeProvider(raw: unknown): ProviderKind | undefined {
	if (raw === "github" || raw === "linear") return raw;
	return undefined;
}

function sanitizePermissionMode(raw: unknown): PermissionMode | undefined {
	return PERMISSION_MODES.includes(raw as PermissionMode) ? (raw as PermissionMode) : undefined;
}

function sanitizePromptTemplate(raw: unknown): string | undefined {
	return typeof raw === "string" && raw.trim().length > 0 ? raw : undefined;
}

function sanitizeOrchestratorPromptTemplate(raw: unknown): string | undefined {
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
function sanitizeLinkFileEntry(raw: unknown): LinkFileEntry | undefined {
	if (typeof raw === "string") return { path: raw, mode: "copy" };
	if (typeof raw !== "object" || raw === null) return undefined;
	const r = raw as Record<string, unknown>;
	if (typeof r["path"] !== "string") return undefined;
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
function sanitizeLinkFiles(raw: unknown): LinkFileEntry[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const out: LinkFileEntry[] = [];
	const seen = new Set<string>();
	for (const v of raw) {
		const entry = sanitizeLinkFileEntry(v);
		if (!entry) continue;
		const trimmed = entry.path.trim();
		if (trimmed.length === 0 || path.isAbsolute(trimmed)) continue;
		const norm = path.normalize(trimmed);
		if (
			norm === ".." ||
			norm.startsWith(`..${path.sep}`) ||
			norm.includes(`${path.sep}..${path.sep}`)
		) {
			continue;
		}
		if (seen.has(norm)) continue;
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
function serializeLinkFiles(entries: LinkFileEntry[]): (string | LinkFileEntry)[] {
	return entries.map((e) => (e.mode === "copy" ? e.path : e));
}

function sanitizeLinearTeam(raw: unknown): LinearTeamRef | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const r = raw as Record<string, unknown>;
	if (typeof r["key"] !== "string" || r["key"].length === 0) return undefined;
	const out: LinearTeamRef = { key: r["key"] };
	if (typeof r["name"] === "string" && r["name"].length > 0) out.name = r["name"];
	return out;
}

function sanitizeLinear(raw: unknown): LinearMeta | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const r = raw as Record<string, unknown>;
	if (typeof r["workspaceSlug"] !== "string" || r["workspaceSlug"].length === 0) return undefined;
	const teamsRaw = Array.isArray(r["teams"]) ? r["teams"] : [];
	const teams: LinearTeamRef[] = [];
	for (const t of teamsRaw) {
		const sanitized = sanitizeLinearTeam(t);
		if (sanitized) teams.push(sanitized);
	}
	const out: LinearMeta = {
		workspaceSlug: r["workspaceSlug"],
		teams,
	};
	if (typeof r["apiUrl"] === "string" && r["apiUrl"].length > 0) out.apiUrl = r["apiUrl"];
	if (typeof r["inProgressStateName"] === "string" && r["inProgressStateName"].length > 0) {
		out.inProgressStateName = r["inProgressStateName"];
	}
	if (Array.isArray(r["protectedStateTypes"])) {
		const arr = r["protectedStateTypes"].filter(
			(v): v is string => typeof v === "string" && v.length > 0,
		);
		if (arr.length > 0) out.protectedStateTypes = arr;
	}
	return out;
}

function sanitizeProject(raw: unknown): ProjectMeta | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const r = raw as Record<string, unknown>;
	const out: ProjectMeta = {};
	if (typeof r["url"] === "string" && r["url"].length > 0) out.url = r["url"];
	if (typeof r["statusField"] === "string" && r["statusField"].length > 0) {
		out.statusField = r["statusField"];
	}
	if (typeof r["inProgressOption"] === "string" && r["inProgressOption"].length > 0) {
		out.inProgressOption = r["inProgressOption"];
	}
	if (Array.isArray(r["protectedStatuses"])) {
		const arr = r["protectedStatuses"].filter(
			(v): v is string => typeof v === "string" && v.length > 0,
		);
		if (arr.length > 0) out.protectedStatuses = arr;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

export function readMetadata(repoRoot: string): Metadata {
	const filePath = getMetadataPath(repoRoot);
	if (!fs.existsSync(filePath)) return { ...EMPTY, issues: {} };
	try {
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		if (typeof parsed !== "object" || parsed === null) return { ...EMPTY, issues: {} };
		const project = sanitizeProject(parsed.project);
		const provider = sanitizeProvider(parsed.provider);
		const linear = sanitizeLinear(parsed.linear);
		const defaultPermissionMode = sanitizePermissionMode(parsed.defaultPermissionMode);
		const promptTemplate = sanitizePromptTemplate(parsed.promptTemplate);
		const orchestratorPromptTemplate = sanitizeOrchestratorPromptTemplate(
			parsed.orchestratorPromptTemplate,
		);
		const linkFiles = sanitizeLinkFiles(parsed.linkFiles);
		return {
			version: 1,
			issues:
				typeof parsed.issues === "object" && parsed.issues !== null
					? (parsed.issues as Record<string, IssueMeta>)
					: {},
			...(provider ? { provider } : {}),
			...(project ? { project } : {}),
			...(linear ? { linear } : {}),
			...(defaultPermissionMode ? { defaultPermissionMode } : {}),
			...(promptTemplate ? { promptTemplate } : {}),
			...(orchestratorPromptTemplate ? { orchestratorPromptTemplate } : {}),
			...(linkFiles ? { linkFiles } : {}),
		};
	} catch {
		return { ...EMPTY, issues: {} };
	}
}

export function writeMetadata(repoRoot: string, data: Metadata): void {
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
export function upsertIssue(repoRoot: string, issueId: string, partial: IssueMeta): Metadata {
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
export function removeIssue(repoRoot: string, issueId: string): boolean {
	const data = readMetadata(repoRoot);
	if (!(issueId in data.issues)) return false;
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
export function setInitFailed(repoRoot: string, issueId: string, failed: boolean): void {
	const data = readMetadata(repoRoot);
	const previous = data.issues[issueId] ?? {};
	if (!failed && previous.init_failed === undefined) return;
	if (failed) {
		data.issues[issueId] = { ...previous, init_failed: true };
	} else {
		const next = { ...previous };
		delete next.init_failed;
		data.issues[issueId] = next;
	}
	writeMetadata(repoRoot, data);
}

export function getSessionId(repoRoot: string, issueId: string): string | undefined {
	return readMetadata(repoRoot).issues[issueId]?.session_id;
}

export function setSessionId(repoRoot: string, issueId: string, sessionId: string): void {
	upsertIssue(repoRoot, issueId, { session_id: sessionId });
}

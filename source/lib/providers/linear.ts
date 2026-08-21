/**
 * LinearProvider — implements IssueProvider against Linear's GraphQL API
 * (https://api.linear.app/graphql).
 *
 * One POST per dashboard refresh: a single GraphQL query pulls viewer +
 * teams (with states) + assigned issues in one shot. Transitions add a
 * second call for the `issueUpdate` mutation.
 *
 * Auth resolution order: `LINEAR_API_KEY` env var → `~/.mintree/
 * credentials.json` (`{ linear: { apiKey: "..." } }`). Never reads or
 * writes credentials to the repo's `.mintree/` directory — personal API
 * keys are user-scoped, not repo-scoped.
 *
 * Linear personal API keys (`lin_api_...`) go directly into the
 * Authorization header with no `Bearer` prefix.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { readMetadata, type LinearMeta, type LinearTeamRef } from "../metadata.js";
import type {
	IssueId,
	IssueProjectInfo,
	IssueProvider,
	LoadOptions,
	ProviderIssue,
	TransitionResult,
} from "./types.js";

const DEFAULT_API_URL = "https://api.linear.app/graphql";
// Linear state types we treat as "done" — work in these states is excluded
// from the assigned list and protected from transitions back to In Progress.
// "duplicate" is its own terminal state type in Linear (separate from
// "canceled"), so it has to be listed explicitly or those issues leak in.
const DEFAULT_PROTECTED_STATE_TYPES = ["completed", "canceled", "duplicate"];
const STATUS_ORDER_UNSET = 999;
// One query covers viewer + teams + issues; a single 20s budget comfortably
// fits even the slowest cold-start response without making real failures
// (DNS, network down) drag too long.
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 400;
const RETRY_AFTER_CAP_MS = 5_000;
const MIN_REQUEST_INTERVAL_MS = 200;
const SNAPSHOT_CACHE_TTL_MS = 60 * 1000;

// Module-level snapshot cache. The dashboard constructs a new LinearProvider
// every refresh, so without this each refresh would re-issue the GraphQL
// query and pay the network round-trip from scratch. A 60s TTL absorbs the
// mount load and the 5-minute auto-refresh cheaply. The manual `r` refresh
// passes forceRefresh to bypass this cache (see loadSnapshot) — the user hits
// `r` precisely to see a change they just made, so stale data there is wrong.
type SnapshotCacheEntry = { snapshot: LinearSnapshot; fetchedAt: number };
const snapshotCache = new Map<string, SnapshotCacheEntry>();

function snapshotCacheKey(workspaceSlug: string, teamKeys: string[]): string {
	return `${workspaceSlug}\x00${[...teamKeys].sort().join(",")}`;
}

function readSnapshotCache(workspaceSlug: string, teamKeys: string[]): LinearSnapshot | null {
	const entry = snapshotCache.get(snapshotCacheKey(workspaceSlug, teamKeys));
	if (!entry) return null;
	if (Date.now() - entry.fetchedAt > SNAPSHOT_CACHE_TTL_MS) {
		snapshotCache.delete(snapshotCacheKey(workspaceSlug, teamKeys));
		return null;
	}
	return entry.snapshot;
}

function writeSnapshotCache(
	workspaceSlug: string,
	teamKeys: string[],
	snapshot: LinearSnapshot,
): void {
	snapshotCache.set(snapshotCacheKey(workspaceSlug, teamKeys), {
		snapshot,
		fetchedAt: Date.now(),
	});
}

function invalidateSnapshotCache(workspaceSlug: string, teamKeys: string[]): void {
	snapshotCache.delete(snapshotCacheKey(workspaceSlug, teamKeys));
}

// Process-global throttle: serialises Linear requests with a minimum gap
// between them. Linear's published per-IP rate limit is generous, but
// repeated dashboard refreshes can still queue up bursts — this keeps the
// sequence orderly without making the dashboard feel slow.
let throttleQueue: Promise<void> = Promise.resolve();
let lastRequestAt = 0;

function throttle(): Promise<void> {
	const wait = throttleQueue.then(async () => {
		const elapsed = Date.now() - lastRequestAt;
		if (elapsed < MIN_REQUEST_INTERVAL_MS) {
			await sleep(MIN_REQUEST_INTERVAL_MS - elapsed);
		}
		lastRequestAt = Date.now();
	});
	throttleQueue = wait;
	return wait;
}

const DEBUG_LOG_PATH = path.join(os.homedir(), ".mintree", "linear-debug.log");

/**
 * Set `MINTREE_DEBUG=1` to enable Linear HTTP debug logging to
 * `~/.mintree/linear-debug.log`. Always-on stderr/stdout would corrupt the
 * Ink-rendered dashboard, so the log is file-only and opt-in.
 */
function debugEnabled(): boolean {
	const v = process.env["MINTREE_DEBUG"];
	return v === "1" || v === "true";
}

function logDebug(message: string): void {
	if (!debugEnabled()) return;
	try {
		const dir = path.dirname(DEBUG_LOG_PATH);
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		fs.appendFileSync(DEBUG_LOG_PATH, `[${new Date().toISOString()}] ${message}\n`);
	} catch {
		// Logging never crashes the dashboard.
	}
}

function isRetryableStatus(status: number): boolean {
	// 0  → AbortError / network timeout / DNS / TLS
	// 429 → rate-limited
	// 5xx → server error
	return status === 0 || status === 429 || (status >= 500 && status < 600);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

type RawLinearViewer = { id: string; name?: string; email?: string };

type RawLinearState = {
	id: string;
	name: string;
	color?: string;
	type?: string;
	position?: number;
};

type RawLinearTeam = {
	id: string;
	key: string;
	name?: string;
	states?: { nodes?: RawLinearState[] };
};

type RawLinearIssue = {
	id: string;
	identifier: string;
	title: string;
	description?: string;
	url: string;
	// Linear's suggested git branch name (a.k.a. gitBranchName). Shape depends
	// on the workspace's branch-name prefix setting — typically
	// "<user>/<team>-<n>-<slug>". mintree uses it verbatim as the worktree branch.
	branchName?: string;
	// Linear priority on the 0-4 scale (0=none, 1=urgent … 4=low).
	priority?: number;
	createdAt?: string;
	updatedAt?: string;
	team?: { id?: string; key?: string; name?: string };
	state?: { id?: string; name?: string; color?: string; type?: string; position?: number };
	labels?: { nodes?: Array<{ name?: string }> };
	// Linear project membership is optional and orthogonal to team — an
	// issue belongs to exactly one team but may belong to zero or one
	// projects (which can themselves span multiple teams). The dashboard
	// uses this to suffix group headers as "Team — Project".
	project?: { id?: string; name?: string } | null;
	// Relations where THIS issue is the target — a `blocks` relation here means
	// some other issue blocks this one. Linear has no "blocked_by" relation
	// type: A-blocks-B is stored once, and B sees it through inverseRelations.
	inverseRelations?: { nodes?: RawLinearRelation[] };
};

type RawLinearRelationEnd = {
	identifier?: string;
	title?: string;
	state?: { name?: string; type?: string };
};

type RawLinearRelation = {
	type?: string;
	issue?: RawLinearRelationEnd | null;
	relatedIssue?: RawLinearRelationEnd | null;
};

type LinearSnapshot = {
	viewer: RawLinearViewer;
	teams: RawLinearTeam[];
	issues: RawLinearIssue[];
};

type LinearFailure = {
	ok: false;
	status: number;
	error: string;
	hint?: string;
	// Linear sometimes sends a Retry-After on 429. When present, retries
	// honour it rather than the fixed backoff so we wait exactly as long as
	// Linear asked.
	retryAfterMs?: number;
};

type LinearRequestResult<T> = { ok: true; data: T } | LinearFailure;

function resolveApiKey(): string | null {
	const env = process.env["LINEAR_API_KEY"];
	if (env && env.length > 0) return env;
	const credsPath = path.join(os.homedir(), ".mintree", "credentials.json");
	try {
		if (!fs.existsSync(credsPath)) return null;
		const parsed = JSON.parse(fs.readFileSync(credsPath, "utf-8"));
		const k = parsed?.linear?.apiKey;
		return typeof k === "string" && k.length > 0 ? k : null;
	} catch {
		return null;
	}
}

async function doLinearRequest<T>(
	apiUrl: string,
	apiKey: string,
	query: string,
	variables?: Record<string, unknown>,
): Promise<LinearRequestResult<T>> {
	await throttle();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const res = await fetch(apiUrl, {
			method: "POST",
			headers: {
				Authorization: apiKey,
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({ query, variables: variables ?? {} }),
			signal: controller.signal,
		});
		clearTimeout(timer);
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			const failure = interpretHttpError(res.status, text);
			if (res.status === 429) {
				const ra = res.headers.get("retry-after");
				if (ra) {
					const seconds = Number(ra);
					if (Number.isFinite(seconds) && seconds > 0) {
						failure.retryAfterMs = Math.min(seconds * 1000, RETRY_AFTER_CAP_MS);
					}
				}
			}
			return failure;
		}
		const body = (await res.json()) as { data?: T; errors?: Array<{ message?: string }> };
		// GraphQL errors land with HTTP 200; surface them like an HTTP failure
		// so the retry loop and caller logic can treat them uniformly.
		if (body.errors && body.errors.length > 0) {
			const messages = body.errors
				.map((e) => (typeof e.message === "string" ? e.message : "unknown error"))
				.join("; ");
			return { ok: false, status: 200, error: `GraphQL error: ${messages}` };
		}
		if (!body.data) {
			return { ok: false, status: 200, error: "Linear API returned no data" };
		}
		return { ok: true, data: body.data };
	} catch (err) {
		clearTimeout(timer);
		if (err instanceof Error && err.name === "AbortError") {
			return { ok: false, status: 0, error: "Linear API request timed out" };
		}
		return {
			ok: false,
			status: 0,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * Calls the Linear API with retry on transient errors. Retries up to
 * MAX_RETRIES on 429 / 5xx / network. Permanent errors (auth, GraphQL
 * validation) return immediately. Failures log when MINTREE_DEBUG=1.
 */
async function linearRequest<T>(
	apiUrl: string,
	apiKey: string,
	query: string,
	variables?: Record<string, unknown>,
): Promise<LinearRequestResult<T>> {
	let attempt = 0;
	let lastResult: LinearRequestResult<T> | null = null;
	while (attempt <= MAX_RETRIES) {
		const result = await doLinearRequest<T>(apiUrl, apiKey, query, variables);
		if (result.ok) {
			if (attempt > 0) {
				logDebug(`recovered Linear query after ${attempt} retry/retries`);
			}
			return result;
		}
		lastResult = result;
		if (!isRetryableStatus(result.status) || attempt === MAX_RETRIES) {
			logDebug(
				`failed Linear query status=${result.status} error=${result.error}${
					result.hint ? ` hint=${result.hint}` : ""
				}`,
			);
			return result;
		}
		const delay =
			result.retryAfterMs !== undefined
				? result.retryAfterMs
				: RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
		logDebug(
			`retry ${attempt + 1}/${MAX_RETRIES} after ${delay}ms (last status=${result.status}${
				result.retryAfterMs !== undefined ? ", server-Retry-After" : ""
			})`,
		);
		await sleep(delay);
		attempt += 1;
	}
	return (
		lastResult ?? {
			ok: false,
			status: 0,
			error: "linearRequest exhausted retries with no recorded error",
		}
	);
}

function interpretHttpError(status: number, body: string): LinearFailure {
	if (status === 401 || status === 403) {
		return {
			ok: false,
			status,
			error: "Linear rejected the API key (401/403).",
			hint: "Verify LINEAR_API_KEY or ~/.mintree/credentials.json#linear.apiKey",
		};
	}
	if (status === 404) {
		return {
			ok: false,
			status,
			error: "Linear API endpoint not found (404).",
			hint: "Check linear.apiUrl in .mintree/metadata.json",
		};
	}
	const snippet = body.slice(0, 200).replace(/\s+/g, " ").trim();
	return {
		ok: false,
		status,
		error: snippet || `Linear API responded with HTTP ${status}`,
	};
}

const BOOTSTRAP_QUERY = /* GraphQL */ `
	query MintreeBootstrap($teamKeys: [String!]!) {
		viewer {
			id
			name
			email
		}
		teams(filter: { key: { in: $teamKeys } }) {
			nodes {
				id
				key
				name
				states {
					nodes {
						id
						name
						color
						type
						position
					}
				}
			}
		}
		issues(
			first: 100
			filter: {
				assignee: { isMe: { eq: true } }
				state: { type: { nin: ["completed", "canceled", "duplicate"] } }
				team: { key: { in: $teamKeys } }
			}
		) {
			nodes {
				id
				identifier
				title
				description
				url
				branchName
				priority
				createdAt
				updatedAt
				team {
					id
					key
					name
				}
				project {
					id
					name
				}
				state {
					id
					name
					color
					type
					position
				}
				labels {
					nodes {
						name
					}
				}
				inverseRelations {
					nodes {
						type
						issue {
							identifier
							title
							state {
								name
								type
							}
						}
						relatedIssue {
							identifier
							title
							state {
								name
								type
							}
						}
					}
				}
			}
		}
	}
`;

const TRANSITION_QUERY = /* GraphQL */ `
	mutation MintreeMoveIssue($id: String!, $stateId: String!) {
		issueUpdate(id: $id, input: { stateId: $stateId }) {
			success
			issue {
				id
				state {
					id
					name
				}
			}
		}
	}
`;

function mapIssueToProviderIssue(wi: RawLinearIssue): ProviderIssue {
	const labels: { name: string }[] = [];
	if (wi.labels?.nodes) {
		for (const l of wi.labels.nodes) {
			if (l && typeof l.name === "string") labels.push({ name: l.name });
		}
	}
	return {
		id: wi.identifier,
		title: wi.title,
		state: wi.state?.name ?? "",
		url: wi.url,
		labels,
		body: wi.description ?? "",
		createdAt: wi.createdAt ?? "",
		updatedAt: wi.updatedAt ?? "",
		// Linear sends 0 for "No priority"; normalise it (and any missing
		// value) to null so the dashboard treats it the same as GitHub's
		// no-priority rows.
		priority: wi.priority && wi.priority > 0 ? wi.priority : null,
		...(wi.branchName && wi.branchName.length > 0 ? { branchName: wi.branchName } : {}),
	};
}

/**
 * Returns the identifiers of the issues that currently block `wi`.
 *
 * A blocker only counts while it is still open: once it reaches a protected
 * state type (completed/canceled/duplicate) the work it gated is unblocked, so
 * the issue is workable again. A blocker whose state we couldn't read is
 * treated as open — hiding a workable ticket is worse than showing a blocked
 * one, but a missing state is far more likely to mean "still open" than "done".
 *
 * Linear stores A-blocks-B once, on A, and B reads it via `inverseRelations`.
 * Which end of the relation carries the blocker isn't worth relying on (the API
 * has swapped the perspective of `issue`/`relatedIssue` between the two
 * directions), so we take whichever end isn't the issue itself.
 */
export function blockersOf(wi: RawLinearIssue, protectedTypes: Set<string>): string[] {
	const blockers: string[] = [];
	for (const rel of wi.inverseRelations?.nodes ?? []) {
		if (rel?.type !== "blocks") continue;
		const other = [rel.issue, rel.relatedIssue].find(
			(end) => end?.identifier && end.identifier !== wi.identifier,
		);
		if (!other?.identifier) continue;
		const type = other.state?.type;
		if (type && protectedTypes.has(type)) continue;
		blockers.push(other.identifier);
	}
	return blockers;
}

export class LinearProvider implements IssueProvider {
	readonly kind = "linear" as const;

	private snapshotPromise: Promise<LinearSnapshot | LinearFailure> | null = null;

	constructor(private readonly repoRoot: string) {}

	private getConfig(): LinearMeta | null {
		return readMetadata(this.repoRoot).linear ?? null;
	}

	/**
	 * Single source of truth for the dashboard's data. Both listAssignedIssues
	 * and fetchProjectAssignments call this so we never double-fetch within a
	 * load. Per-instance promise memoisation handles the back-to-back call;
	 * the module-level cache handles refreshes within the TTL.
	 *
	 * `forceRefresh` skips the module-level cache read so the live GraphQL query
	 * runs again (it still writes the result back to the cache). The per-instance
	 * promise is kept either way, so the two callers within one load share the
	 * single forced fetch instead of issuing two.
	 */
	private async loadSnapshot(forceRefresh = false): Promise<LinearSnapshot | LinearFailure> {
		if (this.snapshotPromise) return this.snapshotPromise;

		const cfg = this.getConfig();
		if (!cfg) {
			return { ok: false, status: 0, error: "Linear config missing in .mintree/metadata.json" };
		}
		if (cfg.teams.length === 0) {
			return { ok: false, status: 0, error: "No Linear teams configured" };
		}

		const apiKey = resolveApiKey();
		if (!apiKey) {
			return {
				ok: false,
				status: 0,
				error: "LINEAR_API_KEY not set",
				hint: "export LINEAR_API_KEY=<key> or write ~/.mintree/credentials.json#linear.apiKey",
			};
		}
		const apiUrl = cfg.apiUrl ?? DEFAULT_API_URL;
		const teamKeys = cfg.teams.map((t) => t.key);

		const cached = forceRefresh ? null : readSnapshotCache(cfg.workspaceSlug, teamKeys);
		if (cached) return cached;

		this.snapshotPromise = (async (): Promise<LinearSnapshot | LinearFailure> => {
			const r = await linearRequest<{
				viewer: RawLinearViewer;
				teams: { nodes?: RawLinearTeam[] };
				issues: { nodes?: RawLinearIssue[] };
			}>(apiUrl, apiKey, BOOTSTRAP_QUERY, { teamKeys });
			if (!r.ok) return r;
			const snapshot: LinearSnapshot = {
				viewer: r.data.viewer,
				teams: r.data.teams?.nodes ?? [],
				issues: r.data.issues?.nodes ?? [],
			};
			writeSnapshotCache(cfg.workspaceSlug, teamKeys, snapshot);
			return snapshot;
		})();

		return this.snapshotPromise;
	}

	async listAssignedIssues(opts?: LoadOptions): Promise<ProviderIssue[] | null> {
		const cfg = this.getConfig();
		if (!cfg || cfg.teams.length === 0) return [];
		const snapshot = await this.loadSnapshot(opts?.forceRefresh ?? false);
		if ("ok" in snapshot && snapshot.ok === false) return null;
		const data = snapshot as LinearSnapshot;
		const protectedTypes = new Set(cfg.protectedStateTypes ?? DEFAULT_PROTECTED_STATE_TYPES);
		const out: ProviderIssue[] = [];
		for (const wi of data.issues) {
			// Defensive — the bootstrap query already excludes
			// completed/canceled/duplicate via state.type.nin, but a workspace
			// could have custom state types the user added to the protected list
			// locally (and a stale snapshot cache predating the query change
			// still gets filtered here).
			const type = wi.state?.type;
			if (type && protectedTypes.has(type)) continue;
			// A ticket gated by an open `blocks` relation isn't workable yet, so
			// it stays out of the dashboard entirely (list + Orchestrate). It
			// reappears on its own once every blocker closes.
			const blockers = blockersOf(wi, protectedTypes);
			if (blockers.length > 0) {
				logDebug(`hiding ${wi.identifier}: blocked by ${blockers.join(", ")}`);
				continue;
			}
			out.push(mapIssueToProviderIssue(wi));
		}
		return out;
	}

	async fetchProjectAssignments(
		opts?: LoadOptions,
	): Promise<Map<IssueId, IssueProjectInfo> | null> {
		const cfg = this.getConfig();
		const result = new Map<IssueId, IssueProjectInfo>();
		if (!cfg || cfg.teams.length === 0) return result;
		const snapshot = await this.loadSnapshot(opts?.forceRefresh ?? false);
		if ("ok" in snapshot && snapshot.ok === false) return null;
		const data = snapshot as LinearSnapshot;

		// Build a per-team workflow-state index so we can attach position
		// (statusOrder) and colour to each issue's status row.
		const teamByKey = new Map<string, { team: LinearTeamRef; states: RawLinearState[] }>();
		for (const t of data.teams) {
			if (!t.key) continue;
			const states = (t.states?.nodes ?? [])
				.slice()
				.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
			teamByKey.set(t.key, {
				team: { key: t.key, name: t.name },
				states,
			});
		}

		for (const wi of data.issues) {
			const teamKey = wi.team?.key;
			if (!teamKey) continue;
			const teamEntry = teamByKey.get(teamKey);
			const orderedStates = teamEntry?.states ?? [];
			const statusOrder = wi.state?.id ? orderedStates.findIndex((s) => s.id === wi.state?.id) : -1;
			const teamName = teamEntry?.team.name ?? wi.team?.name ?? teamKey;
			// Issues may or may not be assigned to a Linear project. When they
			// are, suffix the group header so issues from the same team but
			// different projects render as separate sections — keeps things
			// scannable when one team contributes to many projects.
			const projectName = wi.project?.name;
			const projectTitle = projectName ? `${teamName} — ${projectName}` : teamName;
			// Keep the URL pointed at the team page rather than the project
			// page — the team view is the consistent landing spot regardless
			// of whether an issue happens to be on a project.
			const projectUrl = `https://linear.app/${cfg.workspaceSlug}/team/${teamKey}`;
			result.set(wi.identifier, {
				projectTitle,
				projectUrl,
				projectNumber: 0,
				status: wi.state?.name ?? null,
				statusColor: wi.state?.color ?? "yellow",
				statusOrder: statusOrder >= 0 ? statusOrder : STATUS_ORDER_UNSET,
			});
		}
		return result;
	}

	async transitionIssueToInProgress(issueId: IssueId): Promise<TransitionResult> {
		const cfg = this.getConfig();
		if (!cfg) {
			return {
				kind: "error",
				message: "Linear config missing in .mintree/metadata.json",
				hint: "Run `mintree init --provider linear --workspace <slug> --team <key>` first",
			};
		}
		const apiKey = resolveApiKey();
		if (!apiKey) {
			return {
				kind: "error",
				message: "LINEAR_API_KEY not set",
				hint: "export LINEAR_API_KEY=<key> (or write ~/.mintree/credentials.json)",
			};
		}
		const apiUrl = cfg.apiUrl ?? DEFAULT_API_URL;

		const dash = issueId.lastIndexOf("-");
		if (dash <= 0) return { kind: "skip-no-issue" };
		const teamKey = issueId.slice(0, dash);

		const team = cfg.teams.find((t) => t.key === teamKey);
		if (!team) return { kind: "skip-no-project" };

		const snapshot = await this.loadSnapshot();
		if ("ok" in snapshot && snapshot.ok === false) {
			return {
				kind: "error",
				message: snapshot.error,
				...(snapshot.hint ? { hint: snapshot.hint } : {}),
			};
		}
		const data = snapshot as LinearSnapshot;

		const teamNode = data.teams.find((t) => t.key === teamKey);
		const states = teamNode?.states?.nodes ?? [];
		if (states.length === 0) {
			return { kind: "error", message: `Could not fetch states for team ${teamKey}` };
		}

		const targetStateName = cfg.inProgressStateName;
		let targetState = targetStateName ? states.find((s) => s.name === targetStateName) : undefined;
		if (!targetState) {
			// Linear marks BOTH "In Progress" and "In Review" as type "started",
			// and the bootstrap query returns states unordered — so a plain
			// `find(type === "started")` can land on "In Review". Prefer a state
			// literally named "In Progress", otherwise pick the leftmost started
			// state by workflow position (lowest = earliest = "In Progress").
			const started = states.filter((s) => s.type === "started");
			targetState =
				started.find((s) => s.name?.toLowerCase() === "in progress") ??
				started.sort((a, b) => (a.position ?? 0) - (b.position ?? 0))[0];
		}
		if (!targetState) {
			return {
				kind: "skip-no-in-progress-option",
				projects: [team.name ?? team.key],
			};
		}

		const workItem = data.issues.find((i) => i.identifier === issueId);
		if (!workItem) return { kind: "skip-no-issue" };

		const protectedTypes = new Set(cfg.protectedStateTypes ?? DEFAULT_PROTECTED_STATE_TYPES);
		const currentState = workItem.state;
		if (currentState?.id === targetState.id) {
			return { kind: "noop-already", projectTitle: team.name ?? team.key };
		}
		if (currentState?.type && protectedTypes.has(currentState.type)) {
			return {
				kind: "noop-protected",
				projectTitle: team.name ?? team.key,
				current: currentState.name ?? currentState.type,
			};
		}

		const patch = await linearRequest<{ issueUpdate: { success: boolean } }>(
			apiUrl,
			apiKey,
			TRANSITION_QUERY,
			{ id: workItem.id, stateId: targetState.id },
		);
		if (!patch.ok) {
			return {
				kind: "error",
				message: patch.error,
				...(patch.hint ? { hint: patch.hint } : {}),
			};
		}
		if (!patch.data.issueUpdate.success) {
			return { kind: "error", message: "Linear rejected the issueUpdate mutation" };
		}

		// Snapshot is now stale — wipe both the per-instance promise and the
		// module-level cache so the next loadSnapshot refetches.
		this.snapshotPromise = null;
		invalidateSnapshotCache(
			cfg.workspaceSlug,
			cfg.teams.map((t) => t.key),
		);

		return {
			kind: "transitioned",
			projectTitle: team.name ?? team.key,
			from: currentState?.name ?? null,
			to: targetState.name,
		};
	}
}

/**
 * Doctor-side snapshot of the Linear integration's health. Bundles API-key
 * resolution, `viewer` ping, and per-configured-team existence check into
 * one async call so the doctor row can render everything in one pass.
 */
export type LinearSetupCheck = {
	configured: boolean;
	hasApiKey: boolean;
	authOk: boolean;
	user?: string;
	workspaceSlug?: string;
	apiUrl?: string;
	teams: Array<{ key: string; name?: string; ok: boolean; error?: string }>;
	hint?: string;
};

export async function checkLinearSetup(repoRoot: string): Promise<LinearSetupCheck> {
	const cfg = readMetadata(repoRoot).linear;
	if (!cfg) {
		return {
			configured: false,
			hasApiKey: false,
			authOk: false,
			teams: [],
			hint: "Linear not configured. Run: mintree init --provider linear --workspace <slug> --team <key>",
		};
	}
	const apiUrl = cfg.apiUrl ?? DEFAULT_API_URL;
	const apiKey = resolveApiKey();
	if (!apiKey) {
		return {
			configured: true,
			hasApiKey: false,
			authOk: false,
			workspaceSlug: cfg.workspaceSlug,
			apiUrl,
			teams: cfg.teams.map((t) => ({ key: t.key, ...(t.name ? { name: t.name } : {}), ok: false })),
			hint: "export LINEAR_API_KEY=<key> or populate ~/.mintree/credentials.json#linear.apiKey",
		};
	}

	// One round-trip covers viewer + every configured team. If any team key
	// is wrong we'll see it as a missing node in the response.
	const teamKeys = cfg.teams.map((t) => t.key);
	const r = await linearRequest<{
		viewer: RawLinearViewer;
		teams: { nodes?: Array<{ id: string; key: string; name?: string }> };
	}>(
		apiUrl,
		apiKey,
		/* GraphQL */ `
			query MintreeDoctor($teamKeys: [String!]!) {
				viewer {
					id
					name
					email
				}
				teams(filter: { key: { in: $teamKeys } }) {
					nodes {
						id
						key
						name
					}
				}
			}
		`,
		{ teamKeys },
	);
	if (!r.ok) {
		return {
			configured: true,
			hasApiKey: true,
			authOk: false,
			workspaceSlug: cfg.workspaceSlug,
			apiUrl,
			teams: cfg.teams.map((t) => ({ key: t.key, ...(t.name ? { name: t.name } : {}), ok: false })),
			hint: r.hint ?? r.error,
		};
	}

	const foundKeys = new Set((r.data.teams.nodes ?? []).map((t) => t.key));
	const teamResults: LinearSetupCheck["teams"] = cfg.teams.map((t) => {
		const ok = foundKeys.has(t.key);
		const entry: LinearSetupCheck["teams"][number] = { key: t.key, ok };
		if (t.name) entry.name = t.name;
		if (!ok) entry.error = `Team key "${t.key}" not found in workspace`;
		return entry;
	});
	const allTeamsOk = teamResults.every((t) => t.ok);
	const noTeams = cfg.teams.length === 0;

	return {
		configured: true,
		hasApiKey: true,
		authOk: true,
		user: r.data.viewer.name ?? r.data.viewer.email ?? r.data.viewer.id,
		workspaceSlug: cfg.workspaceSlug,
		apiUrl,
		teams: teamResults,
		hint: noTeams
			? "No teams configured. Add at least one to .mintree/metadata.json#linear.teams[]"
			: !allTeamsOk
				? "One or more configured teams could not be found — check teams[].key"
				: undefined,
	};
}

/**
 * Outcome of resolving an issue identifier to Linear's suggested branch name.
 *
 * Three states, not two, because the caller reacts differently to each: a
 * resolved name is used verbatim, a not-found identifier means the input was
 * never a Linear issue in the first place (nothing to warn about), and an
 * unavailable lookup (no API key, offline, API error) means we *couldn't tell*
 * — the caller keeps the branch as typed and warns instead of silently
 * pretending the check passed.
 */
export type BranchNameLookup =
	| { kind: "resolved"; branchName: string }
	| { kind: "not-found" }
	| { kind: "unavailable"; reason: string };

/**
 * Resolves a human Linear identifier (`FE-123`) to the issue's `branchName`.
 *
 * Deliberately NOT routed through `loadSnapshot`: that query is filtered to
 * open issues assigned to the current user on the configured teams, so it
 * misses exactly the identifiers most likely to be typed by hand (someone
 * else's ticket, a closed one, another team's). `issue(id:)` accepts the
 * human identifier directly — verified against the live API, case-insensitive
 * — and is a single ~250ms round-trip.
 *
 * A missing issue comes back as a GraphQL "Entity not found" error at HTTP
 * 200, which `linearRequest` surfaces as a failure; it's matched here so a
 * bogus identifier reads as `not-found` rather than as a transport problem.
 */
export async function fetchIssueBranchName(
	repoRoot: string,
	issueId: string,
): Promise<BranchNameLookup> {
	const cfg = readMetadata(repoRoot).linear;
	const apiUrl = cfg?.apiUrl ?? DEFAULT_API_URL;
	const apiKey = resolveApiKey();
	if (!apiKey) {
		return { kind: "unavailable", reason: "LINEAR_API_KEY not set" };
	}
	const r = await linearRequest<{ issue?: { identifier?: string; branchName?: string } | null }>(
		apiUrl,
		apiKey,
		/* GraphQL */ `
			query MintreeIssueBranchName($id: String!) {
				issue(id: $id) {
					identifier
					branchName
				}
			}
		`,
		{ id: issueId },
	);
	if (!r.ok) {
		if (/entity not found/i.test(r.error)) return { kind: "not-found" };
		return { kind: "unavailable", reason: r.hint ?? r.error };
	}
	const branchName = r.data.issue?.branchName;
	if (!r.data.issue) return { kind: "not-found" };
	if (typeof branchName !== "string" || branchName.length === 0) {
		return { kind: "unavailable", reason: `Linear returned no branchName for ${issueId}` };
	}
	return { kind: "resolved", branchName };
}

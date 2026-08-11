/**
 * GithubProvider — implements IssueProvider against GitHub Issues + Projects
 * v2 via the `gh` CLI. All the GraphQL plumbing that previously lived in
 * dashboard.ts (project assignment lookup) and githubProject.ts (status
 * transition) is consolidated here so the rest of mintree can talk to issues
 * through a stable, provider-agnostic interface.
 *
 * Stays gh-CLI-driven (not raw octokit) because gh transparently handles
 * auth tokens, scope refresh, and the user's preferred login — mintree's
 * doctor already validates that flow, and not having a second auth path
 * means there's only one thing to break.
 */

import { execFile } from "child_process";
import { promisify } from "util";

import { tryExec } from "../exec.js";
import { getRepoFullName } from "../gh.js";
import { readMetadata, type ProjectMeta } from "../metadata.js";
import type {
	IssueId,
	IssueProjectInfo,
	IssueProvider,
	ProviderIssue,
	TransitionResult,
} from "./types.js";

const execFileAsync = promisify(execFile);

const DEFAULT_STATUS_FIELD = "Status";
const DEFAULT_IN_PROGRESS_OPTION = "In Progress";
const DEFAULT_PROTECTED_STATUSES = ["In Review", "Done"];
const ISSUE_LIST_LIMIT = 50;

// GitHub Projects v2 single-select options carry their own colour enum.
// Map each to the closest Ink/chalk colour; ORANGE and PINK have no 16-colour
// keyword so they use hex (truecolor terminals render them, others approximate).
const PROJECT_STATUS_COLORS: Record<string, string> = {
	GRAY: "gray",
	BLUE: "blue",
	GREEN: "green",
	YELLOW: "yellow",
	ORANGE: "#d18616",
	RED: "red",
	PINK: "#d2a8ff",
	PURPLE: "magenta",
};

const STATUS_ORDER_UNSET = 999;

type RawGhIssue = {
	number: number;
	title: string;
	state: string;
	url: string;
	labels: { name: string }[];
	body: string;
	createdAt: string;
	updatedAt: string;
};

type ProjectItemNode = {
	project?: {
		title?: string;
		number?: number;
		url?: string;
		field?: { options?: Array<{ name?: string; color?: string }> } | null;
	} | null;
	fieldValueByName?: { name?: string } | null;
};

type SearchResponse = {
	data?: {
		search?: {
			nodes?: Array<{
				number?: number;
				projectItems?: { nodes?: ProjectItemNode[] };
			}>;
		};
	};
};

type ProjectField = {
	id: string;
	name: string;
	options: Array<{ id: string; name: string }>;
};

type ProjectItem = {
	id: string;
	project: {
		id: string;
		title: string;
		number: number;
		url: string;
		field: ProjectField | null;
	};
	fieldValues: {
		nodes: Array<{
			name?: string;
			field?: { name?: string };
		}>;
	};
};

type IssueQueryResponse = {
	data?: {
		repository?: {
			issue?: {
				id: string;
				projectItems: { nodes: ProjectItem[] };
			} | null;
		} | null;
	};
};

function parseProjectNumberFromUrl(url: string): number | null {
	const m = url.match(/\/projects\/(\d+)/);
	return m && m[1] ? Number(m[1]) : null;
}

async function runGhGraphql(
	query: string,
	fields: Array<[string, string | number]>,
): Promise<unknown> {
	const args = ["api", "graphql", "-f", `query=${query}`];
	for (const [key, value] of fields) {
		if (typeof value === "number") {
			args.push("-F", `${key}=${value}`);
		} else {
			args.push("-f", `${key}=${value}`);
		}
	}
	const { stdout } = await execFileAsync("gh", args);
	return JSON.parse(stdout) as unknown;
}

async function ghGraphqlOrNull(query: string): Promise<unknown | null> {
	try {
		const { stdout } = await execFileAsync("gh", ["api", "graphql", "-f", `query=${query}`]);
		return JSON.parse(stdout) as unknown;
	} catch {
		return null;
	}
}

function interpretGhError(err: unknown): TransitionResult {
	const stderr =
		err && typeof err === "object" && "stderr" in err
			? String((err as { stderr: Buffer | string }).stderr)
			: err instanceof Error
				? err.message
				: String(err);

	if (/INSUFFICIENT_SCOPES/i.test(stderr) || (/scope/i.test(stderr) && /project/i.test(stderr))) {
		return {
			kind: "error",
			message: "gh token is missing the `project` scope.",
			hint: "Run: gh auth refresh -s project",
		};
	}
	if (/Could not resolve to a Repository/i.test(stderr)) {
		return { kind: "skip-no-repo" };
	}
	if (/Could not resolve to an Issue/i.test(stderr)) {
		return { kind: "skip-no-issue" };
	}

	const firstLine = stderr.split("\n").find((line) => line.trim().length > 0) ?? "";
	return {
		kind: "error",
		message: firstLine.slice(0, 200) || "gh api graphql failed",
	};
}

function pickProjectNode(
	nodes: ProjectItemNode[],
	configuredUrl: string | null,
): ProjectItemNode | null {
	if (nodes.length === 0) return null;
	if (configuredUrl) {
		const targetNumber = parseProjectNumberFromUrl(configuredUrl);
		return (
			nodes.find(
				(n) =>
					n.project?.url === configuredUrl ||
					(targetNumber !== null && n.project?.number === targetNumber),
			) ?? null
		);
	}
	return nodes[0] ?? null;
}

function toProjectInfo(node: ProjectItemNode): IssueProjectInfo | null {
	const proj = node.project;
	if (!proj) return null;
	const options = proj.field?.options ?? [];
	const status = node.fieldValueByName?.name ?? null;
	const optionIndex = status ? options.findIndex((o) => o.name === status) : -1;
	const option = optionIndex >= 0 ? options[optionIndex] : undefined;
	return {
		projectTitle: proj.title ?? "(untitled project)",
		projectUrl: proj.url ?? "",
		projectNumber: proj.number ?? 0,
		status,
		statusColor: option?.color
			? (PROJECT_STATUS_COLORS[option.color] ?? "yellow")
			: status
				? "yellow"
				: "gray",
		statusOrder: optionIndex >= 0 ? optionIndex : STATUS_ORDER_UNSET,
	};
}

export class GithubProvider implements IssueProvider {
	readonly kind = "github" as const;

	constructor(private readonly repoRoot: string) {}

	private readProjectConfig(): ProjectMeta {
		return readMetadata(this.repoRoot).project ?? {};
	}

	async listAssignedIssues(): Promise<ProviderIssue[] | null> {
		const json = await tryExec(
			`gh issue list --assignee @me --state open --json number,title,state,url,labels,body,createdAt,updatedAt --limit ${ISSUE_LIST_LIMIT} 2>/dev/null`,
		);
		if (!json) return null;
		try {
			const parsed = JSON.parse(json);
			if (!Array.isArray(parsed)) return null;
			return (parsed as RawGhIssue[]).map((raw) => ({
				id: String(raw.number),
				title: raw.title,
				state: raw.state,
				url: raw.url,
				labels: raw.labels,
				body: raw.body,
				createdAt: raw.createdAt,
				updatedAt: raw.updatedAt,
				// GitHub Issues has no native priority field.
				priority: null,
			}));
		} catch {
			return null;
		}
	}

	async fetchProjectAssignments(): Promise<Map<IssueId, IssueProjectInfo> | null> {
		const result = new Map<IssueId, IssueProjectInfo>();
		const repo = await getRepoFullName();
		if (!repo) return result;

		const cfg = this.readProjectConfig();
		const statusFieldName = cfg.statusField ?? DEFAULT_STATUS_FIELD;
		const configuredUrl = cfg.url ?? null;

		// The Status field name is interpolated into the query (not a variable)
		// because it appears as a field argument; escape embedded quotes.
		const escapedField = statusFieldName.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		const searchQuery = `repo:${repo} is:issue is:open assignee:@me`.replace(/"/g, '\\"');

		const query = `query {
  search(query: "${searchQuery}", type: ISSUE, first: ${ISSUE_LIST_LIMIT}) {
    nodes {
      ... on Issue {
        number
        projectItems(first: 10, includeArchived: false) {
          nodes {
            project {
              title
              number
              url
              field(name: "${escapedField}") {
                ... on ProjectV2SingleSelectField {
                  options { name color }
                }
              }
            }
            fieldValueByName(name: "${escapedField}") {
              ... on ProjectV2ItemFieldSingleSelectValue { name }
            }
          }
        }
      }
    }
  }
}`;

		const raw = (await ghGraphqlOrNull(query)) as SearchResponse | null;
		// Distinguish a failed call (gh missing the project scope, network
		// error) from a successful call with no results — the former returns
		// null so the dashboard treats it as a partial load failure and keeps
		// its last-good state.
		if (raw === null) return null;
		const nodes = raw?.data?.search?.nodes;
		if (!Array.isArray(nodes)) return result;

		for (const node of nodes) {
			if (typeof node?.number !== "number") continue;
			const items = node.projectItems?.nodes ?? [];
			const picked = pickProjectNode(items, configuredUrl);
			if (!picked) continue;
			const info = toProjectInfo(picked);
			if (info) result.set(String(node.number), info);
		}
		return result;
	}

	async transitionIssueToInProgress(issueId: IssueId): Promise<TransitionResult> {
		const repo = await getRepoFullName();
		if (!repo) return { kind: "skip-no-repo" };
		const [owner, name] = repo.split("/");
		if (!owner || !name) return { kind: "skip-no-repo" };

		const issueNumber = Number(issueId);
		if (!Number.isFinite(issueNumber)) return { kind: "skip-no-issue" };

		const cfg = this.readProjectConfig();
		const statusFieldName = cfg.statusField ?? DEFAULT_STATUS_FIELD;
		const inProgressOptionName = cfg.inProgressOption ?? DEFAULT_IN_PROGRESS_OPTION;
		const protectedStatuses = cfg.protectedStatuses ?? DEFAULT_PROTECTED_STATUSES;

		// The Status field name is interpolated into the query (not a variable)
		// because GraphQL field-argument names are not parameterizable through
		// the variables object. Escape any embedded quotes to keep the query valid.
		const escapedFieldName = statusFieldName.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

		const query = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      id
      projectItems(first: 20, includeArchived: false) {
        nodes {
          id
          project {
            id
            title
            number
            url
            field(name: "${escapedFieldName}") {
              ... on ProjectV2SingleSelectField {
                id
                name
                options { id name }
              }
            }
          }
          fieldValues(first: 30) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                field {
                  ... on ProjectV2SingleSelectField { name }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

		let raw: IssueQueryResponse;
		try {
			raw = (await runGhGraphql(query, [
				["owner", owner],
				["repo", name],
				["number", issueNumber],
			])) as IssueQueryResponse;
		} catch (err) {
			return interpretGhError(err);
		}

		const issue = raw?.data?.repository?.issue;
		if (!issue) return { kind: "skip-no-issue" };

		let nodes = issue.projectItems.nodes;
		if (nodes.length === 0) return { kind: "skip-no-project" };

		// Honour an explicit project URL in the config before doing anything else.
		if (cfg.url) {
			const targetNumber = parseProjectNumberFromUrl(cfg.url);
			nodes = nodes.filter(
				(n) =>
					n.project.url === cfg.url || (targetNumber !== null && n.project.number === targetNumber),
			);
			if (nodes.length === 0) return { kind: "skip-no-project" };
		}

		const withField = nodes.filter((n) => n.project.field !== null);
		if (withField.length === 0) {
			return { kind: "skip-no-status-field", projects: nodes.map((n) => n.project.title) };
		}

		const withOption = withField.filter((n) =>
			n.project.field!.options.some((o) => o.name === inProgressOptionName),
		);
		if (withOption.length === 0) {
			return {
				kind: "skip-no-in-progress-option",
				projects: withField.map((n) => n.project.title),
			};
		}

		if (withOption.length > 1) {
			return { kind: "skip-ambiguous", projects: withOption.map((n) => n.project.title) };
		}

		const item = withOption[0]!;
		const project = item.project;
		const field = project.field!;
		const option = field.options.find((o) => o.name === inProgressOptionName);
		if (!option) {
			// Defensive — already filtered above, but TypeScript can't see it.
			return { kind: "skip-no-in-progress-option", projects: [project.title] };
		}

		const currentStatus =
			item.fieldValues.nodes.find((v) => v.field?.name === statusFieldName)?.name ?? null;

		if (currentStatus === inProgressOptionName) {
			return { kind: "noop-already", projectTitle: project.title };
		}
		if (currentStatus !== null && protectedStatuses.includes(currentStatus)) {
			return { kind: "noop-protected", projectTitle: project.title, current: currentStatus };
		}

		const mutation = `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $projectId
    itemId: $itemId
    fieldId: $fieldId
    value: { singleSelectOptionId: $optionId }
  }) {
    projectV2Item { id }
  }
}`;

		try {
			await runGhGraphql(mutation, [
				["projectId", project.id],
				["itemId", item.id],
				["fieldId", field.id],
				["optionId", option.id],
			]);
		} catch (err) {
			return interpretGhError(err);
		}

		return {
			kind: "transitioned",
			projectTitle: project.title,
			from: currentStatus,
			to: inProgressOptionName,
		};
	}
}

/**
 * Returns the gh CLI token scopes for github.com, or null when `gh` can't be
 * called / the user isn't authenticated. `gh auth status` writes the scopes
 * line to stderr; we capture both streams and grep for it.
 *
 * Kept as a standalone export (not part of IssueProvider) because it's
 * consumed by doctor for the Project v2 scope row — a doctor-side concern,
 * not part of the runtime issue flow.
 */
export async function getGhTokenScopes(): Promise<string[] | null> {
	try {
		const { stdout, stderr } = await execFileAsync("gh", ["auth", "status"]);
		const combined = `${stdout}\n${stderr}`;
		return parseScopesFromAuthStatus(combined);
	} catch (err) {
		const out =
			err && typeof err === "object" && "stdout" in err && "stderr" in err
				? `${String((err as { stdout: Buffer | string }).stdout)}\n${String((err as { stderr: Buffer | string }).stderr)}`
				: "";
		const parsed = parseScopesFromAuthStatus(out);
		return parsed ?? null;
	}
}

function parseScopesFromAuthStatus(text: string): string[] | null {
	const m = text.match(/Token scopes:\s*([^\n]+)/i);
	if (!m || !m[1]) return null;
	return m[1]
		.split(",")
		.map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
		.filter(Boolean);
}

export function hasProjectScope(scopes: string[]): boolean {
	return scopes.some((s) => s === "project" || s === "write:project");
}

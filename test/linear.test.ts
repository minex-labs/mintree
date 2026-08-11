import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { LinearProvider, blockersOf } from "../source/lib/providers/linear.js";

// Exercises the module-level snapshot cache and the forceRefresh bypass that
// backs the dashboard's manual `r` refresh. The Linear API is mocked at the
// `global.fetch` boundary; each "refresh" constructs a fresh LinearProvider,
// exactly as the dashboard does (createProvider per load), so the per-instance
// promise memoisation doesn't mask the module cache behaviour under test.

function makeRepo(workspaceSlug: string): { dir: string; cleanup: () => void } {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mintree-linear-test-")));
	const mintreeDir = path.join(dir, ".mintree");
	fs.mkdirSync(mintreeDir, { recursive: true });
	const metadata = {
		version: 1,
		provider: "linear",
		issues: {},
		linear: { workspaceSlug, teams: [{ key: "FE" }] },
	};
	fs.writeFileSync(path.join(mintreeDir, "metadata.json"), JSON.stringify(metadata, null, 2));
	return {
		dir,
		cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
	};
}

test("LinearProvider: a second refresh within the TTL is served from cache (no extra fetch)", async () => {
	const repo = makeRepo("cache-hit-ws");
	const prevKey = process.env["LINEAR_API_KEY"];
	process.env["LINEAR_API_KEY"] = "lin_api_test";
	const original = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = (async () => {
		calls++;
		return {
			ok: true,
			status: 200,
			headers: { get: () => null },
			text: async () => "",
			json: async () => ({
				data: {
					viewer: { id: "u1", name: "Tester", email: "t@example.com" },
					teams: { nodes: [] },
					issues: { nodes: [] },
				},
			}),
		};
	}) as unknown as typeof globalThis.fetch;

	try {
		// First load: cache cold → one network round-trip.
		await new LinearProvider(repo.dir).listAssignedIssues();
		assert.equal(calls, 1, "first load should fetch");

		// Second load (fresh instance, like the dashboard) without forceRefresh:
		// the module-level cache is still warm → no second fetch.
		await new LinearProvider(repo.dir).listAssignedIssues();
		assert.equal(calls, 1, "cached load must not fetch again");
	} finally {
		globalThis.fetch = original;
		if (prevKey === undefined) delete process.env["LINEAR_API_KEY"];
		else process.env["LINEAR_API_KEY"] = prevKey;
		repo.cleanup();
	}
});

test("LinearProvider: forceRefresh bypasses the cache and re-fetches", async () => {
	const repo = makeRepo("force-refresh-ws");
	const prevKey = process.env["LINEAR_API_KEY"];
	process.env["LINEAR_API_KEY"] = "lin_api_test";
	const original = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = (async () => {
		calls++;
		return {
			ok: true,
			status: 200,
			headers: { get: () => null },
			text: async () => "",
			json: async () => ({
				data: {
					viewer: { id: "u1", name: "Tester", email: "t@example.com" },
					teams: { nodes: [] },
					issues: { nodes: [] },
				},
			}),
		};
	}) as unknown as typeof globalThis.fetch;

	try {
		// Warm the cache.
		await new LinearProvider(repo.dir).listAssignedIssues();
		assert.equal(calls, 1, "first load should fetch");

		// Manual `r`: forceRefresh must bypass the warm cache and hit the network
		// again, so a just-assigned ticket would be picked up immediately.
		await new LinearProvider(repo.dir).listAssignedIssues({ forceRefresh: true });
		assert.equal(calls, 2, "forceRefresh must re-fetch despite a warm cache");
	} finally {
		globalThis.fetch = original;
		if (prevKey === undefined) delete process.env["LINEAR_API_KEY"];
		else process.env["LINEAR_API_KEY"] = prevKey;
		repo.cleanup();
	}
});

// --- blocked-issue filtering -------------------------------------------------
// Linear stores A-blocks-B once, on A; B sees it through inverseRelations. The
// dashboard hides B while any blocker is still open.

const PROTECTED = new Set(["completed", "canceled", "duplicate"]);

function issueWithInverseRelations(identifier: string, nodes: unknown[]) {
	return { identifier, inverseRelations: { nodes } } as Parameters<typeof blockersOf>[0];
}

test("blockersOf: an open blocks relation yields the blocker's identifier", () => {
	const wi = issueWithInverseRelations("FE-300", [
		{
			type: "blocks",
			issue: { identifier: "BE-129", state: { name: "Todo", type: "unstarted" } },
		},
	]);
	assert.deepEqual(blockersOf(wi, PROTECTED), ["BE-129"]);
});

test("blockersOf: a closed blocker no longer blocks", () => {
	for (const type of ["completed", "canceled", "duplicate"]) {
		const wi = issueWithInverseRelations("FE-300", [
			{ type: "blocks", issue: { identifier: "BE-129", state: { name: "Done", type } } },
		]);
		assert.deepEqual(
			blockersOf(wi, PROTECTED),
			[],
			`blocker in state type "${type}" must not block`,
		);
	}
});

test("blockersOf: non-blocking relation types are ignored", () => {
	const wi = issueWithInverseRelations("FE-300", [
		{ type: "related", issue: { identifier: "BE-129", state: { type: "unstarted" } } },
		{ type: "duplicate", issue: { identifier: "BE-130", state: { type: "started" } } },
	]);
	assert.deepEqual(blockersOf(wi, PROTECTED), []);
});

test("blockersOf: reads the blocker from whichever end isn't the issue itself", () => {
	// Guards against the API reporting the relation from the other perspective.
	const wi = issueWithInverseRelations("FE-300", [
		{
			type: "blocks",
			issue: { identifier: "FE-300", state: { type: "unstarted" } },
			relatedIssue: { identifier: "BE-129", state: { type: "started" } },
		},
	]);
	assert.deepEqual(blockersOf(wi, PROTECTED), ["BE-129"]);
});

test("blockersOf: a blocker with an unreadable state is treated as still blocking", () => {
	const wi = issueWithInverseRelations("FE-300", [
		{ type: "blocks", issue: { identifier: "BE-129" } },
	]);
	assert.deepEqual(blockersOf(wi, PROTECTED), ["BE-129"]);
});

test("blockersOf: an issue with no relations has no blockers", () => {
	assert.deepEqual(
		blockersOf({ identifier: "FE-301" } as Parameters<typeof blockersOf>[0], PROTECTED),
		[],
	);
});

test("LinearProvider: blocked issues are dropped from the assigned list", async () => {
	const repo = makeRepo("blocked-ws");
	const prevKey = process.env["LINEAR_API_KEY"];
	process.env["LINEAR_API_KEY"] = "lin_api_test";
	const original = globalThis.fetch;

	const issue = (identifier: string, inverseRelations: unknown[]) => ({
		id: `id-${identifier}`,
		identifier,
		title: `Ticket ${identifier}`,
		url: `https://linear.app/x/issue/${identifier}`,
		state: { id: "s1", name: "Todo", type: "unstarted" },
		team: { key: "FE" },
		inverseRelations: { nodes: inverseRelations },
	});

	globalThis.fetch = (async () => ({
		ok: true,
		status: 200,
		headers: { get: () => null },
		text: async () => "",
		json: async () => ({
			data: {
				viewer: { id: "u1", name: "Tester", email: "t@example.com" },
				teams: { nodes: [] },
				issues: {
					nodes: [
						// Blocked by an open ticket → hidden.
						issue("FE-300", [
							{ type: "blocks", issue: { identifier: "BE-129", state: { type: "unstarted" } } },
						]),
						// Blocker already done → shown.
						issue("FE-301", [
							{ type: "blocks", issue: { identifier: "BE-128", state: { type: "completed" } } },
						]),
						// No relations at all → shown.
						issue("FE-302", []),
					],
				},
			},
		}),
	})) as unknown as typeof globalThis.fetch;

	try {
		const issues = await new LinearProvider(repo.dir).listAssignedIssues();
		assert.deepEqual(
			issues?.map((i) => i.id),
			["FE-301", "FE-302"],
			"only the ticket with an open blocker should be hidden",
		);
	} finally {
		globalThis.fetch = original;
		if (prevKey === undefined) delete process.env["LINEAR_API_KEY"];
		else process.env["LINEAR_API_KEY"] = prevKey;
		repo.cleanup();
	}
});

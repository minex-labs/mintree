import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { isBareIssueIdBranch, parseBranch, parseLinearBranch, isParseError } from "../source/lib/branch.js";
import { resolveBareIssueBranch, runCreate } from "../source/lib/worktreeCreate.js";
import type { BranchNameLookup } from "../source/lib/providers/linear.js";

/**
 * The guard against creating a branch whose whole name is a Linear issue id
 * (`FE-68`) — a shape Linear treats as "this branch closes that issue" on
 * merge, regardless of the PR body.
 *
 * Every "stays quiet" case below is a POSITIVE CONTROL: it is a Linear repo
 * with configured teams whose argument reaches `resolveBareIssueBranch`, and
 * it asserts that the branch-name lookup was never even attempted. A case that
 * bailed out earlier (a GitHub repo, an unparseable branch) would prove
 * nothing about the guard, so those are asserted separately, on their own
 * terms.
 */

const TEAM_KEYS = ["FE", "BE"];

function parsed(branch: string) {
	const conv = parseBranch(branch);
	if (!isParseError(conv)) return conv;
	const lin = parseLinearBranch(branch, TEAM_KEYS);
	assert.ok(!isParseError(lin), `fixture branch did not parse: ${branch}`);
	return lin;
}

// A lookup that records its calls, so "stayed quiet" can be distinguished from
// "asked Linear and was told nothing".
function spyLookup(outcome: BranchNameLookup) {
	const calls: string[] = [];
	return {
		calls,
		fn: async (_root: string, issueId: string): Promise<BranchNameLookup> => {
			calls.push(issueId);
			return outcome;
		},
	};
}

test("bare id + resolvable → builds Linear's branch name instead", async () => {
	const spy = spyLookup({ kind: "resolved", branchName: "jdoe/fe-68-landing-page" });
	const out = await resolveBareIssueBranch({
		repoRoot: "/nowhere",
		parsed: parsed("FE-68"),
		teamKeys: TEAM_KEYS,
		exact: false,
		lookup: spy.fn,
	});

	assert.deepEqual(spy.calls, ["FE-68"]);
	assert.equal(out.parsed.branch, "jdoe/fe-68-landing-page");
	assert.equal(out.parsed.issueId, "FE-68");
	assert.equal(out.parsed.worktreeDirName, "FE-68");
	assert.equal(out.info?.requested, "FE-68");
	assert.equal(out.info?.resolvedTo, "jdoe/fe-68-landing-page");
	assert.equal(out.step?.kind, "warn");
});

test("bare id, lower-case → same correction (Linear ids are case-insensitive)", async () => {
	const spy = spyLookup({ kind: "resolved", branchName: "jdoe/fe-68-landing-page" });
	const out = await resolveBareIssueBranch({
		repoRoot: "/nowhere",
		parsed: parsed("fe-68"),
		teamKeys: TEAM_KEYS,
		exact: false,
		lookup: spy.fn,
	});
	assert.deepEqual(spy.calls, ["FE-68"]);
	assert.equal(out.parsed.branch, "jdoe/fe-68-landing-page");
});

test("bare id + lookup unavailable → keeps the branch and warns", async () => {
	const spy = spyLookup({ kind: "unavailable", reason: "LINEAR_API_KEY not set" });
	const out = await resolveBareIssueBranch({
		repoRoot: "/nowhere",
		parsed: parsed("FE-68"),
		teamKeys: TEAM_KEYS,
		exact: false,
		lookup: spy.fn,
	});

	assert.deepEqual(spy.calls, ["FE-68"]);
	assert.equal(out.parsed.branch, "FE-68", "branch must not change when we couldn't resolve it");
	assert.equal(out.info?.resolvedTo, undefined);
	assert.equal(out.info?.reason, "LINEAR_API_KEY not set");
	assert.equal(out.step?.kind, "warn");
	assert.match(String(out.step?.detail), /close the Linear issue when merged/);
});

test("bare-looking id that isn't a Linear issue → silent (it only looked id-shaped)", async () => {
	const spy = spyLookup({ kind: "not-found" });
	const out = await resolveBareIssueBranch({
		repoRoot: "/nowhere",
		parsed: parsed("FE-9999"),
		teamKeys: TEAM_KEYS,
		exact: false,
		lookup: spy.fn,
	});

	// Control: the guard DID run and DID ask Linear — the silence is a verdict,
	// not a code path that was never reached.
	assert.deepEqual(spy.calls, ["FE-9999"]);
	assert.equal(out.parsed.branch, "FE-9999");
	assert.equal(out.info, undefined);
	assert.equal(out.step, undefined);
});

test("--exact keeps the bare id without asking Linear", async () => {
	const spy = spyLookup({ kind: "resolved", branchName: "jdoe/fe-68-landing-page" });
	const out = await resolveBareIssueBranch({
		repoRoot: "/nowhere",
		parsed: parsed("FE-68"),
		teamKeys: TEAM_KEYS,
		exact: true,
		lookup: spy.fn,
	});

	assert.deepEqual(spy.calls, [], "--exact must not hit the network");
	assert.equal(out.parsed.branch, "FE-68");
	assert.equal(out.info?.reason, "--exact");
	assert.equal(out.step?.kind, "skip");
});

test("convention branch stays untouched and never asks Linear", async () => {
	const spy = spyLookup({ kind: "resolved", branchName: "jdoe/fe-68-landing-page" });
	const out = await resolveBareIssueBranch({
		repoRoot: "/nowhere",
		parsed: parsed("feat/FE-68-landing-page"),
		teamKeys: TEAM_KEYS,
		exact: false,
		lookup: spy.fn,
	});

	assert.deepEqual(spy.calls, []);
	assert.equal(out.parsed.branch, "feat/FE-68-landing-page");
	assert.equal(out.step, undefined);
});

test("Linear branchName stays untouched and never asks Linear", async () => {
	const spy = spyLookup({ kind: "resolved", branchName: "jdoe/fe-68-other" });
	const out = await resolveBareIssueBranch({
		repoRoot: "/nowhere",
		parsed: parsed("jdoe/fe-68-landing-page"),
		teamKeys: TEAM_KEYS,
		exact: false,
		lookup: spy.fn,
	});

	assert.deepEqual(spy.calls, []);
	assert.equal(out.parsed.branch, "jdoe/fe-68-landing-page");
	assert.equal(out.step, undefined);
});

test("no configured teams disables the guard entirely", async () => {
	const spy = spyLookup({ kind: "resolved", branchName: "jdoe/fe-68-landing-page" });
	const out = await resolveBareIssueBranch({
		repoRoot: "/nowhere",
		parsed: parsed("FE-68"),
		teamKeys: [],
		exact: false,
		lookup: spy.fn,
	});

	assert.deepEqual(spy.calls, []);
	assert.equal(out.parsed.branch, "FE-68");
	assert.equal(out.step, undefined);
});

test("isBareIssueIdBranch: only the bare identifier form", () => {
	assert.equal(isBareIssueIdBranch(parsed("FE-68")), true);
	assert.equal(isBareIssueIdBranch(parsed("fe-68")), true);
	assert.equal(isBareIssueIdBranch(parsed("feat/FE-68-x")), false);
	assert.equal(isBareIssueIdBranch(parsed("jdoe/fe-68-landing-page")), false);
	assert.equal(isBareIssueIdBranch(parsed("fe-68-landing-page")), false);
	// GitHub convention branch: the issue id is bare digits, but it's still
	// wrapped in `<type>/…-<desc>`, so the guard can never see it as bare.
	assert.equal(isBareIssueIdBranch(parsed("feat/100-x")), false);
});

// ---------------------------------------------------------------------------
// End-to-end: real git repo, real runCreate, mocked Linear transport. These
// assert on the branch that actually ended up checked out in the worktree,
// not on what the result object claims.
// ---------------------------------------------------------------------------

type Repo = { dir: string; restore: () => void };

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function makeRepo(metadata: unknown): Repo {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mintree-bare-")));
	git(dir, "init", "-b", "main");
	git(dir, "config", "user.email", "test@example.com");
	git(dir, "config", "user.name", "Test");
	fs.writeFileSync(path.join(dir, "README.md"), "# test\n");
	git(dir, "add", ".");
	git(dir, "commit", "-m", "init");
	fs.mkdirSync(path.join(dir, ".mintree", "worktrees"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, ".mintree", "metadata.json"),
		JSON.stringify(metadata, null, 2),
	);

	const prevCwd = process.cwd();
	process.chdir(dir);
	return {
		dir,
		restore: () => {
			process.chdir(prevCwd);
			fs.rmSync(dir, { recursive: true, force: true });
		},
	};
}

const LINEAR_META = {
	version: 1,
	provider: "linear",
	issues: {},
	linear: { workspaceSlug: "acme", teams: [{ key: "FE" }, { key: "BE" }] },
};

const GITHUB_META = { version: 1, provider: "github", issues: {} };

// Stands in for the Linear GraphQL endpoint. `payload` is the `data` object;
// pass null to fail the request the way a missing issue does.
function mockFetch(payload: unknown | null) {
	const calls: unknown[] = [];
	const original = globalThis.fetch;
	globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
		calls.push(init?.body ? JSON.parse(init.body) : null);
		return {
			ok: true,
			status: 200,
			headers: { get: () => null },
			text: async () => "",
			json: async () =>
				payload === null
					? { errors: [{ message: "Entity not found: Issue" }] }
					: { data: payload },
		};
	}) as unknown as typeof globalThis.fetch;
	return { calls, restore: () => { globalThis.fetch = original; } };
}

function withApiKey(value: string | undefined): () => void {
	const prevKey = process.env["LINEAR_API_KEY"];
	const prevHome = process.env["HOME"];
	// Point HOME somewhere empty so `~/.mintree/credentials.json` on the
	// developer's machine can't leak a real key into the "no key" case.
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "mintree-home-"));
	process.env["HOME"] = home;
	if (value === undefined) delete process.env["LINEAR_API_KEY"];
	else process.env["LINEAR_API_KEY"] = value;
	return () => {
		if (prevKey === undefined) delete process.env["LINEAR_API_KEY"];
		else process.env["LINEAR_API_KEY"] = prevKey;
		if (prevHome === undefined) delete process.env["HOME"];
		else process.env["HOME"] = prevHome;
		fs.rmSync(home, { recursive: true, force: true });
	};
}

test("e2e: `create FE-68` checks out Linear's branch, not the bare id", async () => {
	const repo = makeRepo(LINEAR_META);
	const restoreKey = withApiKey("lin_api_test");
	const net = mockFetch({ issue: { identifier: "FE-68", branchName: "jdoe/fe-68-landing-page" } });
	try {
		const result = await runCreate("FE-68", { work: false });
		assert.ok(result.ok, `expected success, got ${JSON.stringify(result)}`);
		if (!result.ok) return;

		// What actually landed on disk — the only claim that matters.
		assert.equal(git(result.worktreePath, "branch", "--show-current"), "jdoe/fe-68-landing-page");
		assert.equal(
			git(repo.dir, "branch", "--list", "FE-68"),
			"",
			"the bare-id branch must not exist",
		);
		assert.equal(path.basename(result.worktreePath), "FE-68");
		assert.equal(result.bareIssueBranch?.resolvedTo, "jdoe/fe-68-landing-page");
		assert.equal(net.calls.length, 1);
	} finally {
		net.restore();
		restoreKey();
		repo.restore();
	}
});

test("e2e: a Linear branch name is created verbatim, with no lookup at all", async () => {
	const repo = makeRepo(LINEAR_META);
	const restoreKey = withApiKey("lin_api_test");
	const net = mockFetch({ issue: { identifier: "FE-68", branchName: "SHOULD-NOT-BE-USED" } });
	try {
		const result = await runCreate("jdoe/fe-68-landing-page", { work: false });
		assert.ok(result.ok, `expected success, got ${JSON.stringify(result)}`);
		if (!result.ok) return;

		assert.equal(git(result.worktreePath, "branch", "--show-current"), "jdoe/fe-68-landing-page");
		assert.equal(result.bareIssueBranch, undefined);
		// The guard ran on a Linear repo with configured teams and decided to do
		// nothing: no request, no extra step.
		assert.equal(net.calls.length, 0);
		assert.equal(
			result.steps.filter((s) => s.kind === "warn" && /issue id|Linear's branch/.test(s.label))
				.length,
			0,
		);
	} finally {
		net.restore();
		restoreKey();
		repo.restore();
	}
});

test("e2e: convention branch on a Linear repo is created verbatim, no lookup", async () => {
	const repo = makeRepo(LINEAR_META);
	const restoreKey = withApiKey("lin_api_test");
	const net = mockFetch({ issue: { identifier: "FE-70", branchName: "SHOULD-NOT-BE-USED" } });
	try {
		const result = await runCreate("feat/FE-70-landing-page", { work: false });
		assert.ok(result.ok, `expected success, got ${JSON.stringify(result)}`);
		if (!result.ok) return;

		assert.equal(git(result.worktreePath, "branch", "--show-current"), "feat/FE-70-landing-page");
		assert.equal(result.bareIssueBranch, undefined);
		assert.equal(net.calls.length, 0);
	} finally {
		net.restore();
		restoreKey();
		repo.restore();
	}
});

test("e2e: without an API key the bare id is kept, loudly", async () => {
	const repo = makeRepo(LINEAR_META);
	const restoreKey = withApiKey(undefined);
	const net = mockFetch({ issue: { identifier: "FE-68", branchName: "jdoe/fe-68-landing-page" } });
	try {
		const result = await runCreate("FE-68", { work: false });
		assert.ok(result.ok, `expected success, got ${JSON.stringify(result)}`);
		if (!result.ok) return;

		// Never blocks: the worktree is created either way.
		assert.equal(git(result.worktreePath, "branch", "--show-current"), "FE-68");
		assert.equal(net.calls.length, 0, "no key means no request was even attempted");
		assert.equal(result.bareIssueBranch?.requested, "FE-68");
		assert.equal(result.bareIssueBranch?.resolvedTo, undefined);
		assert.match(String(result.bareIssueBranch?.reason), /LINEAR_API_KEY/);
		assert.ok(
			result.steps.some((s) => s.kind === "warn" && s.label === "branch is a bare issue id"),
			`expected a warn step, got ${JSON.stringify(result.steps)}`,
		);
	} finally {
		net.restore();
		restoreKey();
		repo.restore();
	}
});

test("e2e: --exact keeps the bare id and skips the lookup", async () => {
	const repo = makeRepo(LINEAR_META);
	const restoreKey = withApiKey("lin_api_test");
	const net = mockFetch({ issue: { identifier: "FE-68", branchName: "jdoe/fe-68-landing-page" } });
	try {
		const result = await runCreate("FE-68", { work: false, exact: true });
		assert.ok(result.ok, `expected success, got ${JSON.stringify(result)}`);
		if (!result.ok) return;

		assert.equal(git(result.worktreePath, "branch", "--show-current"), "FE-68");
		assert.equal(net.calls.length, 0);
		assert.equal(result.bareIssueBranch?.reason, "--exact");
	} finally {
		net.restore();
		restoreKey();
		repo.restore();
	}
});

test("e2e: a GitHub repo is untouched by the guard", async () => {
	const repo = makeRepo(GITHUB_META);
	const restoreKey = withApiKey("lin_api_test");
	const net = mockFetch({ issue: { identifier: "FE-68", branchName: "SHOULD-NOT-BE-USED" } });
	try {
		const ok = await runCreate("feat/100-landing-page", { work: false });
		assert.ok(ok.ok, `expected success, got ${JSON.stringify(ok)}`);
		if (!ok.ok) return;
		assert.equal(git(ok.worktreePath, "branch", "--show-current"), "feat/100-landing-page");
		assert.equal(ok.bareIssueBranch, undefined);

		// A bare id on a GitHub repo still fails the way it always has — the
		// guard adds no Linear-flavoured advice to a repo that has no Linear.
		const bad = await runCreate("FE-68", { work: false });
		assert.equal(bad.ok, false);
		if (bad.ok) return;
		assert.match(bad.message, /Invalid branch name/);
		assert.equal(net.calls.length, 0);
	} finally {
		net.restore();
		restoreKey();
		repo.restore();
	}
});

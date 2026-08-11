import { test } from "node:test";
import assert from "node:assert/strict";

import {
	parseBranch,
	parseLinearBranch,
	extractLinearIssueId,
	issueIdFromWorktreeDirName,
	isParseError,
	type ParsedBranch,
} from "../source/lib/branch.js";

function ok(result: ReturnType<typeof parseBranch>): ParsedBranch {
	assert.ok(!isParseError(result), `expected parse to succeed, got error: ${JSON.stringify(result)}`);
	return result as ParsedBranch;
}

// --- Convention parser stays exactly as before (regression guard) ---

test("parseBranch: GitHub convention branch", () => {
	const p = ok(parseBranch("feat/100-readme-update"));
	assert.equal(p.branch, "feat/100-readme-update");
	assert.equal(p.type, "feat");
	assert.equal(p.issueId, "100");
	assert.equal(p.desc, "readme-update");
	assert.equal(p.worktreeDirName, "100");
});

test("parseBranch: Linear convention branch upper-cases the team key", () => {
	const p = ok(parseBranch("feat/be-256-x"));
	assert.equal(p.branch, "feat/BE-256-x");
	assert.equal(p.issueId, "BE-256");
	assert.equal(p.worktreeDirName, "BE-256");
});

test("parseBranch: rejects an unknown type", () => {
	const r = parseBranch("jdoe/fe-68-landing-page");
	assert.ok(isParseError(r));
});

// --- extractLinearIssueId ---

test("extractLinearIssueId: user-prefixed Linear branch", () => {
	assert.equal(
		extractLinearIssueId("jdoe/fe-68-landing-page", ["FE", "BE"]),
		"FE-68",
	);
});

test("extractLinearIssueId: no user prefix", () => {
	assert.equal(extractLinearIssueId("fe-68-landing", ["FE"]), "FE-68");
});

test("extractLinearIssueId: case-insensitive on the team key, normalises to upper", () => {
	assert.equal(extractLinearIssueId("jdoe/Fe-68-x", ["FE"]), "FE-68");
});

test("extractLinearIssueId: only matches a configured team key", () => {
	// "foo" is not a configured team → no match even though it looks like an id.
	assert.equal(extractLinearIssueId("user/foo-12-bar", ["FE", "BE"]), null);
});

test("extractLinearIssueId: does not match a key buried inside a slug word", () => {
	// "ofe-68" should not match team "FE" — the token boundary protects it.
	assert.equal(extractLinearIssueId("user/ofe-68-x", ["FE"]), null);
});

test("extractLinearIssueId: falls back to first letters-digits token when no keys", () => {
	assert.equal(extractLinearIssueId("user/fe-68-landing", []), "FE-68");
});

test("extractLinearIssueId: picks the configured team even when slug has trailing numbers", () => {
	assert.equal(extractLinearIssueId("u/fe-68-fix-3-bug", ["FE"]), "FE-68");
});

// --- parseLinearBranch ---

test("parseLinearBranch: keeps the branch verbatim, derives a bare upper-case dir", () => {
	const p = ok(parseLinearBranch("jdoe/fe-68-landing-page", ["FE"]));
	assert.equal(p.branch, "jdoe/fe-68-landing-page");
	assert.equal(p.issueId, "FE-68");
	assert.equal(p.worktreeDirName, "FE-68");
	// No convention type/desc for a Linear branch.
	assert.equal(p.type, undefined);
	assert.equal(p.desc, undefined);
});

test("parseLinearBranch: trims surrounding whitespace", () => {
	const p = ok(parseLinearBranch("  jdoe/fe-68-x  ", ["FE"]));
	assert.equal(p.branch, "jdoe/fe-68-x");
	assert.equal(p.issueId, "FE-68");
});

test("parseLinearBranch: rejects an empty branch", () => {
	assert.ok(isParseError(parseLinearBranch("   ", ["FE"])));
});

test("parseLinearBranch: rejects invalid git-ref characters", () => {
	assert.ok(isParseError(parseLinearBranch("jdoe/fe 68 x", ["FE"])));
	assert.ok(isParseError(parseLinearBranch("jdoe/fe-68~x", ["FE"])));
});

test("parseLinearBranch: rejects when no Linear id is present", () => {
	const r = parseLinearBranch("just-a-plain-branch", ["FE", "BE"]);
	assert.ok(isParseError(r));
});

// --- issueIdFromWorktreeDirName ---

test("issueIdFromWorktreeDirName: bare GitHub id", () => {
	assert.equal(issueIdFromWorktreeDirName("100"), "100");
});

test("issueIdFromWorktreeDirName: bare Linear id", () => {
	assert.equal(issueIdFromWorktreeDirName("BE-347"), "BE-347");
});

test("issueIdFromWorktreeDirName: legacy <id>-<desc> dir", () => {
	assert.equal(issueIdFromWorktreeDirName("BE-347-buscador-global"), "BE-347");
	assert.equal(issueIdFromWorktreeDirName("100-readme-update"), "100");
});

test("issueIdFromWorktreeDirName: null for a non-issue dir name", () => {
	assert.equal(issueIdFromWorktreeDirName("be-338-flip"), null);
	assert.equal(issueIdFromWorktreeDirName("detached-abc"), null);
});

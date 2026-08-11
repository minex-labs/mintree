import { test } from "node:test";
import assert from "node:assert/strict";

import { buildCreateMarkers, buildOrchestrateMarkers } from "../source/lib/markers.js";

test("buildOrchestrateMarkers: emits cd + orchestrate + prompt-file + permission mode", () => {
	const lines = buildOrchestrateMarkers({
		repoRoot: "/repo",
		promptFile: "/tmp/mintree-prompt-1.txt",
		permissionMode: "auto",
	});
	assert.deepEqual(lines, [
		"MINTREE_CD:/repo",
		"MINTREE_ORCHESTRATE:1",
		"MINTREE_ORCHESTRATE_PROMPT_FILE:/tmp/mintree-prompt-1.txt",
		"MINTREE_PERMISSION_MODE:auto",
	]);
});

test("buildOrchestrateMarkers: omits the permission-mode line when absent", () => {
	const lines = buildOrchestrateMarkers({
		repoRoot: "/repo",
		promptFile: "/tmp/p.txt",
	});
	assert.deepEqual(lines, [
		"MINTREE_CD:/repo",
		"MINTREE_ORCHESTRATE:1",
		"MINTREE_ORCHESTRATE_PROMPT_FILE:/tmp/p.txt",
	]);
});

test("buildOrchestrateMarkers: emits the rc-name line when given", () => {
	const lines = buildOrchestrateMarkers({
		repoRoot: "/repo",
		promptFile: "/tmp/p.txt",
		permissionMode: "default",
		rcName: "orchestrator-FE-12_BE-16_FE-3",
	});
	assert.deepEqual(lines, [
		"MINTREE_CD:/repo",
		"MINTREE_ORCHESTRATE:1",
		"MINTREE_ORCHESTRATE_PROMPT_FILE:/tmp/p.txt",
		"MINTREE_PERMISSION_MODE:default",
		"MINTREE_ORCHESTRATE_RC_NAME:orchestrator-FE-12_BE-16_FE-3",
	]);
});

test("buildCreateMarkers: still emits the worktree work block unchanged", () => {
	const lines = buildCreateMarkers({
		worktreePath: "/repo/.mintree/worktrees/100",
		work: true,
		promptFile: "/tmp/p.txt",
		permissionMode: "default",
	});
	assert.deepEqual(lines, [
		"MINTREE_CD:/repo/.mintree/worktrees/100",
		"MINTREE_WORK:1",
		"MINTREE_WORK_PROMPT_FILE:/tmp/p.txt",
		"MINTREE_PERMISSION_MODE:default",
	]);
});

import { test } from "node:test";
import assert from "node:assert/strict";

import { removeFailure } from "../source/lib/worktreeRemove.js";

// removeFailure turns a git stderr into a RemoveResult, adding a Docker hint
// on "Permission denied" (a compose stack from `make worktree-up` still bound
// to the worktree is the usual cause) and passing anything else through bare.

test("removeFailure: adds a Docker hint on Permission denied", () => {
	const r = removeFailure(
		"error: failed to delete '/repo/.mintree/worktrees/BE-347': Permission denied",
	);
	assert.equal(r.ok, false);
	assert.match(r.message, /git worktree remove failed:/);
	assert.ok(r.hint, "expected a hint");
	assert.match(r.hint!, /Docker Compose stack/i);
});

test("removeFailure: case-insensitive on the permission text", () => {
	const r = removeFailure("permission denied");
	assert.ok(r.hint, "expected a hint regardless of case");
});

test("removeFailure: no hint for unrelated errors", () => {
	const r = removeFailure("fatal: 'foo' is not a working tree");
	assert.equal(r.ok, false);
	assert.equal(r.hint, undefined);
});

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildCaffeinateArgs, shouldCaffeinate } from "../source/lib/caffeinate.js";

test("caffeinate is bound to the Claude pid and only blocks idle sleep", () => {
	assert.deepEqual(buildCaffeinateArgs(4242), ["-i", "-w", "4242"]);
});

test("caffeinate runs on macOS by default", () => {
	assert.equal(shouldCaffeinate("darwin", {}), true);
});

test("caffeinate is skipped off macOS", () => {
	assert.equal(shouldCaffeinate("linux", {}), false);
	assert.equal(shouldCaffeinate("win32", {}), false);
});

test("MINTREE_NO_CAFFEINATE opts out; falsy values don't", () => {
	assert.equal(shouldCaffeinate("darwin", { MINTREE_NO_CAFFEINATE: "1" }), false);
	assert.equal(shouldCaffeinate("darwin", { MINTREE_NO_CAFFEINATE: "true" }), false);
	assert.equal(shouldCaffeinate("darwin", { MINTREE_NO_CAFFEINATE: "0" }), true);
	assert.equal(shouldCaffeinate("darwin", { MINTREE_NO_CAFFEINATE: "false" }), true);
	assert.equal(shouldCaffeinate("darwin", { MINTREE_NO_CAFFEINATE: "" }), true);
});

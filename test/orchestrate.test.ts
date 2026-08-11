import { test } from "node:test";
import assert from "node:assert/strict";

import { buildOrchestratorRcName } from "../source/lib/orchestrate.js";

test("buildOrchestratorRcName: joins ids with underscores after the prefix", () => {
	assert.equal(
		buildOrchestratorRcName(["FE-12", "BE-16", "FE-3"]),
		"orchestrator-FE-12_BE-16_FE-3",
	);
});

test("buildOrchestratorRcName: single id", () => {
	assert.equal(buildOrchestratorRcName(["FE-32"]), "orchestrator-FE-32");
});

test("buildOrchestratorRcName: returns null with no ids (caller falls back to a hash)", () => {
	assert.equal(buildOrchestratorRcName([]), null);
});

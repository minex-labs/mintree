import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { readMetadata, removeIssue, upsertIssue, setInitFailed } from "../source/lib/metadata.js";

// readMetadata reads `<repoRoot>/.mintree/metadata.json`. We write one into a
// temp dir and assert the new `defaultPermissionMode` / `promptTemplate`
// fields are picked up (and invalid values dropped).

function withMetadata(metadata: unknown): { root: string; cleanup: () => void } {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mintree-meta-")));
	fs.mkdirSync(path.join(root, ".mintree"), { recursive: true });
	fs.writeFileSync(
		path.join(root, ".mintree", "metadata.json"),
		JSON.stringify(metadata, null, 2),
	);
	return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("readMetadata: reads defaultPermissionMode and promptTemplate", () => {
	const { root, cleanup } = withMetadata({
		version: 1,
		provider: "linear",
		issues: {},
		linear: { workspaceSlug: "acme", teams: [{ key: "FE" }] },
		defaultPermissionMode: "auto",
		promptTemplate: "Trabajá en {{id}}: {{url}}",
	});
	try {
		const meta = readMetadata(root);
		assert.equal(meta.defaultPermissionMode, "auto");
		assert.equal(meta.promptTemplate, "Trabajá en {{id}}: {{url}}");
	} finally {
		cleanup();
	}
});

test("readMetadata: drops an invalid defaultPermissionMode", () => {
	const { root, cleanup } = withMetadata({
		version: 1,
		issues: {},
		defaultPermissionMode: "yolo",
	});
	try {
		assert.equal(readMetadata(root).defaultPermissionMode, undefined);
	} finally {
		cleanup();
	}
});

test("readMetadata: drops a blank promptTemplate", () => {
	const { root, cleanup } = withMetadata({
		version: 1,
		issues: {},
		promptTemplate: "   ",
	});
	try {
		assert.equal(readMetadata(root).promptTemplate, undefined);
	} finally {
		cleanup();
	}
});

test("readMetadata: both fields absent stay undefined", () => {
	const { root, cleanup } = withMetadata({ version: 1, issues: {} });
	try {
		const meta = readMetadata(root);
		assert.equal(meta.defaultPermissionMode, undefined);
		assert.equal(meta.promptTemplate, undefined);
		assert.equal(meta.orchestratorPromptTemplate, undefined);
	} finally {
		cleanup();
	}
});

test("readMetadata: reads orchestratorPromptTemplate", () => {
	const { root, cleanup } = withMetadata({
		version: 1,
		issues: {},
		orchestratorPromptTemplate: "Orquestá {{count}}: {{ids}}",
	});
	try {
		assert.equal(readMetadata(root).orchestratorPromptTemplate, "Orquestá {{count}}: {{ids}}");
	} finally {
		cleanup();
	}
});

test("readMetadata: drops a blank orchestratorPromptTemplate", () => {
	const { root, cleanup } = withMetadata({
		version: 1,
		issues: {},
		orchestratorPromptTemplate: "   ",
	});
	try {
		assert.equal(readMetadata(root).orchestratorPromptTemplate, undefined);
	} finally {
		cleanup();
	}
});

test("readMetadata: reads linkFiles and normalises/de-dupes entries", () => {
	const { root, cleanup } = withMetadata({
		version: 1,
		issues: {},
		linkFiles: [".env", "./.env", "config/secrets.json"],
	});
	try {
		// "./.env" normalises to ".env" and collapses into the first entry.
		// Bare strings are the pre-modes shape and mean "copy".
		assert.deepEqual(readMetadata(root).linkFiles, [
			{ path: ".env", mode: "copy" },
			{ path: "config/secrets.json", mode: "copy" },
		]);
	} finally {
		cleanup();
	}
});

test("readMetadata: drops unsafe linkFiles entries (absolute, parent-escape, non-string)", () => {
	const { root, cleanup } = withMetadata({
		version: 1,
		issues: {},
		linkFiles: ["/etc/passwd", "../../secret", "ok.env", 42, "  "],
	});
	try {
		assert.deepEqual(readMetadata(root).linkFiles, [{ path: "ok.env", mode: "copy" }]);
	} finally {
		cleanup();
	}
});

// --- linkFiles: per-entry mode (BE-155) ---

test("readMetadata: reads an explicit per-entry mode", () => {
	const { root, cleanup } = withMetadata({
		version: 1,
		issues: {},
		linkFiles: [".env", { path: ".env.local", mode: "link" }, { path: "a.json", mode: "copy" }],
	});
	try {
		assert.deepEqual(readMetadata(root).linkFiles, [
			{ path: ".env", mode: "copy" },
			{ path: ".env.local", mode: "link" },
			{ path: "a.json", mode: "copy" },
		]);
	} finally {
		cleanup();
	}
});

test("readMetadata: an unknown mode falls back to copy instead of dropping the entry", () => {
	const { root, cleanup } = withMetadata({
		version: 1,
		issues: {},
		linkFiles: [{ path: ".env.local", mode: "symlink" }],
	});
	try {
		// "copy" is the conservative fallback: it can't mutate the main
		// checkout's file, and a typo shouldn't silently stop the file from
		// reaching new worktrees at all.
		assert.deepEqual(readMetadata(root).linkFiles, [{ path: ".env.local", mode: "copy" }]);
	} finally {
		cleanup();
	}
});

test("readMetadata: object entries get the same path validation as bare strings", () => {
	const { root, cleanup } = withMetadata({
		version: 1,
		issues: {},
		linkFiles: [
			{ path: "/etc/passwd", mode: "link" },
			{ path: "../../secret", mode: "link" },
			{ mode: "link" },
			{ path: "ok.env", mode: "link" },
		],
	});
	try {
		// Otherwise `mode: "link"` would be a way to point a symlink anywhere.
		assert.deepEqual(readMetadata(root).linkFiles, [{ path: "ok.env", mode: "link" }]);
	} finally {
		cleanup();
	}
});

test("writeMetadata: copy entries round-trip back to bare strings", () => {
	const { root, cleanup } = withMetadata({
		version: 1,
		issues: {},
		linkFiles: [".env", { path: ".env.local", mode: "link" }],
	});
	try {
		// Every upsertIssue rewrites the whole file, so a repo that never opted
		// into modes must not have its metadata churned into the object shape.
		upsertIssue(root, "BE-1", { base_branch: "main" });
		const raw = JSON.parse(fs.readFileSync(path.join(root, ".mintree/metadata.json"), "utf-8"));
		assert.deepEqual(raw.linkFiles, [".env", { path: ".env.local", mode: "link" }]);
	} finally {
		cleanup();
	}
});

test("readMetadata: drops linkFiles when it ends up empty or is not an array", () => {
	const a = withMetadata({ version: 1, issues: {}, linkFiles: ["../nope"] });
	try {
		assert.equal(readMetadata(a.root).linkFiles, undefined);
	} finally {
		a.cleanup();
	}
	const b = withMetadata({ version: 1, issues: {}, linkFiles: ".env" });
	try {
		assert.equal(readMetadata(b.root).linkFiles, undefined);
	} finally {
		b.cleanup();
	}
});

// --- setInitFailed (BE-155) ---

test("setInitFailed: records the flag, then clears it on a later success", () => {
	const { root, cleanup } = withMetadata({ version: 1, issues: {} });
	try {
		setInitFailed(root, "BE-1", true);
		assert.equal(readMetadata(root).issues["BE-1"]?.init_failed, true);

		setInitFailed(root, "BE-1", false);
		// Absent, not false — presence of the key is the signal.
		assert.ok(readMetadata(root).issues["BE-1"] !== undefined);
		assert.ok(!("init_failed" in (readMetadata(root).issues["BE-1"] ?? {})));
	} finally {
		cleanup();
	}
});

test("setInitFailed: preserves the rest of the issue entry", () => {
	const { root, cleanup } = withMetadata({
		version: 1,
		issues: { "BE-1": { base_branch: "main", session_id: "abc" } },
	});
	try {
		setInitFailed(root, "BE-1", true);
		const entry = readMetadata(root).issues["BE-1"];
		assert.equal(entry?.base_branch, "main");
		assert.equal(entry?.session_id, "abc");
		assert.equal(entry?.init_failed, true);

		setInitFailed(root, "BE-1", false);
		const cleared = readMetadata(root).issues["BE-1"];
		assert.equal(cleared?.session_id, "abc", "clearing the flag must not drop the session id");
	} finally {
		cleanup();
	}
});

// --- removeIssue ---

test("removeIssue: deletes the entry and persists", () => {
	const { root, cleanup } = withMetadata({
		version: 1,
		provider: "linear",
		issues: {
			"BE-347": { base_branch: "main", session_id: "abc" },
			"FE-75": { base_branch: "main" },
		},
		linear: { workspaceSlug: "acme", teams: [{ key: "BE" }, { key: "FE" }] },
	});
	try {
		assert.equal(removeIssue(root, "BE-347"), true);
		const meta = readMetadata(root);
		assert.ok(!("BE-347" in meta.issues), "BE-347 should be gone");
		assert.ok("FE-75" in meta.issues, "FE-75 should remain");
		// Re-read from disk to confirm it was persisted, not just mutated in memory.
		assert.ok(!("BE-347" in readMetadata(root).issues));
	} finally {
		cleanup();
	}
});

test("removeIssue: no-op returns false for a missing entry", () => {
	const { root, cleanup } = withMetadata({
		version: 1,
		issues: { "BE-1": { base_branch: "main" } },
	});
	try {
		assert.equal(removeIssue(root, "NOPE-9"), false);
		assert.ok("BE-1" in readMetadata(root).issues);
	} finally {
		cleanup();
	}
});

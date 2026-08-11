import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { runCreate } from "../source/lib/worktreeCreate.js";
import { runRemove, runRemoveByPath } from "../source/lib/worktreeRemove.js";
import { buildWorktreeIndex } from "../source/lib/dashboard.js";
import { readMetadata } from "../source/lib/metadata.js";

// Covers two behaviours that go together:
//  - removing a worktree now prunes the issue's metadata entry (it used to be
//    preserved for re-attach, and only ever accumulated);
//  - directories left in `.mintree/worktrees/` that git no longer tracks are
//    discovered by a filesystem scan and can be deleted outright. These appear
//    when the repo dir is renamed: git stores absolute paths on both ends of a
//    worktree, so the rename breaks the link and a later prune drops the
//    reference while the checkout stays on disk.

type Repo = { dir: string; restoreCwd: () => void };

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

const LINEAR_META = {
	version: 1,
	provider: "linear",
	issues: {},
	linear: { workspaceSlug: "acme", teams: [{ key: "FE" }] },
};

function makeRepo(): Repo {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mintree-orphan-")));
	git(dir, "init", "-b", "main");
	git(dir, "config", "user.email", "test@example.com");
	git(dir, "config", "user.name", "Test");
	fs.writeFileSync(path.join(dir, "README.md"), "# test\n");
	git(dir, "add", ".");
	git(dir, "commit", "-m", "init");

	const mintreeDir = path.join(dir, ".mintree");
	fs.mkdirSync(path.join(mintreeDir, "worktrees"), { recursive: true });
	fs.writeFileSync(path.join(mintreeDir, "metadata.json"), JSON.stringify(LINEAR_META, null, 2));

	const prevCwd = process.cwd();
	process.chdir(dir);
	return {
		dir,
		restoreCwd: () => {
			process.chdir(prevCwd);
			fs.rmSync(dir, { recursive: true, force: true });
		},
	};
}

/**
 * Reproduces the real-world breakage: the checkout stays in
 * `.mintree/worktrees/<id>` while git's admin dir for it is gone, so
 * `git worktree list` no longer reports it.
 */
function strandWorktree(repoDir: string, issueId: string): string {
	const adminDir = path.join(repoDir, ".git", "worktrees", issueId);
	fs.rmSync(adminDir, { recursive: true, force: true });
	return path.join(repoDir, ".mintree", "worktrees", issueId);
}

test("runRemove: prunes the issue's metadata entry", async () => {
	const repo = makeRepo();
	try {
		const branch = "jdoe/fe-68-landing-page";
		const created = await runCreate(branch, { work: false });
		assert.ok(created.ok);

		// The create seeded an entry for the issue.
		assert.ok(readMetadata(repo.dir).issues["FE-68"], "expected a metadata entry after create");

		const result = runRemove(branch, false);
		assert.ok(result.ok, `expected success, got: ${JSON.stringify(result)}`);
		if (!result.ok) return;

		assert.equal(result.prunedIssueId, "FE-68");
		assert.equal(readMetadata(repo.dir).issues["FE-68"], undefined);
		// The branch itself survives — it may still have an open PR.
		assert.match(git(repo.dir, "branch", "--list", branch), /fe-68/);
	} finally {
		repo.restoreCwd();
	}
});

test("buildWorktreeIndex: finds a directory git no longer tracks", async () => {
	const repo = makeRepo();
	try {
		const created = await runCreate("jdoe/fe-68-landing-page", { work: false });
		assert.ok(created.ok);

		// Sanity: while registered it's indexed as a normal worktree.
		const before = buildWorktreeIndex(repo.dir).get("FE-68");
		assert.ok(before, "expected the registered worktree in the index");
		assert.notEqual(before!.unregistered, true);

		const strandedPath = strandWorktree(repo.dir, "FE-68");

		const after = buildWorktreeIndex(repo.dir).get("FE-68");
		assert.ok(after, "expected the stranded directory to still be indexed");
		assert.equal(after!.unregistered, true);
		// Nothing git-derived is trustworthy without the admin dir.
		assert.equal(after!.branch, null);
		assert.equal(after!.dirty, false);
		assert.equal(path.resolve(after!.path), path.resolve(strandedPath));
	} finally {
		repo.restoreCwd();
	}
});

test("buildWorktreeIndex: ignores loose files and unparseable dir names", async () => {
	const repo = makeRepo();
	try {
		const worktrees = path.join(repo.dir, ".mintree", "worktrees");
		fs.writeFileSync(path.join(worktrees, ".DS_Store"), "junk");
		fs.mkdirSync(path.join(worktrees, "scratch"));

		assert.equal(buildWorktreeIndex(repo.dir).size, 0);
	} finally {
		repo.restoreCwd();
	}
});

test("runRemoveByPath: refuses an unregistered directory without force", async () => {
	const repo = makeRepo();
	try {
		const created = await runCreate("jdoe/fe-68-landing-page", { work: false });
		assert.ok(created.ok);
		const strandedPath = strandWorktree(repo.dir, "FE-68");

		const result = runRemoveByPath(strandedPath, false);
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.match(result.message, /not registered with git/i);
		assert.ok(result.hint, "expected a hint pointing at --force");
		// Nothing was touched.
		assert.ok(fs.existsSync(strandedPath));
	} finally {
		repo.restoreCwd();
	}
});

test("runRemoveByPath: force-deletes an unregistered directory and prunes metadata", async () => {
	const repo = makeRepo();
	try {
		const created = await runCreate("jdoe/fe-68-landing-page", { work: false });
		assert.ok(created.ok);
		const strandedPath = strandWorktree(repo.dir, "FE-68");
		assert.ok(readMetadata(repo.dir).issues["FE-68"]);

		const result = runRemoveByPath(strandedPath, true);
		assert.ok(result.ok, `expected success, got: ${JSON.stringify(result)}`);
		if (!result.ok) return;

		assert.equal(result.variant, "removed-unregistered");
		assert.equal(result.prunedIssueId, "FE-68");
		assert.equal(fs.existsSync(strandedPath), false);
		assert.equal(readMetadata(repo.dir).issues["FE-68"], undefined);
		// It's gone from the dashboard's view too.
		assert.equal(buildWorktreeIndex(repo.dir).has("FE-68"), false);
	} finally {
		repo.restoreCwd();
	}
});

test("runRemoveByPath: refuses to rm -rf outside .mintree/worktrees/", () => {
	const repo = makeRepo();
	try {
		// A directory that git doesn't track and that lives outside the
		// mintree-managed area must never be deleted, force or not.
		const outside = path.join(repo.dir, "important");
		fs.mkdirSync(outside);
		fs.writeFileSync(path.join(outside, "keep.txt"), "do not delete");

		const result = runRemoveByPath(outside, true);
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.match(result.message, /outside \.mintree\/worktrees\//);
		assert.ok(fs.existsSync(path.join(outside, "keep.txt")));
	} finally {
		repo.restoreCwd();
	}
});

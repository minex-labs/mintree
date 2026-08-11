import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { runCreate } from "../source/lib/worktreeCreate.js";

// End-to-end create against a real (local, offline) git repo. The "Linear
// provider" is mocked purely by metadata: runCreate reads `provider` +
// `linear.teams` from `.mintree/metadata.json` to pick the branch parser — it
// never hits the network on the create path.

type Repo = { dir: string; restoreCwd: () => void };

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function makeRepo(metadata: unknown): Repo {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mintree-test-")));
	git(dir, "init", "-b", "main");
	git(dir, "config", "user.email", "test@example.com");
	git(dir, "config", "user.name", "Test");
	fs.writeFileSync(path.join(dir, "README.md"), "# test\n");
	git(dir, "add", ".");
	git(dir, "commit", "-m", "init");

	const mintreeDir = path.join(dir, ".mintree");
	fs.mkdirSync(path.join(mintreeDir, "worktrees"), { recursive: true });
	fs.writeFileSync(path.join(mintreeDir, "metadata.json"), JSON.stringify(metadata, null, 2));

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

const LINEAR_META = {
	version: 1,
	provider: "linear",
	issues: {},
	linear: { workspaceSlug: "acme", teams: [{ key: "FE" }, { key: "BE" }] },
};

const GITHUB_META = { version: 1, provider: "github", issues: {} };

test("runCreate (linear): creates a worktree from a Linear branchName", async () => {
	const repo = makeRepo(LINEAR_META);
	try {
		const branch = "jdoe/fe-68-landing-page";
		const result = await runCreate(branch, { work: false });

		assert.ok(result.ok, `expected success, got: ${JSON.stringify(result)}`);
		if (!result.ok) return;

		// Branch is kept verbatim; the worktree dir is the bare upper-case id.
		assert.equal(result.branch, branch);
		assert.equal(result.issueId, "FE-68");
		assert.equal(path.basename(result.worktreePath), "FE-68");
		assert.ok(fs.existsSync(result.worktreePath));

		// The git branch actually exists with the Linear name.
		const branches = git(repo.dir, "branch", "--list", branch);
		assert.ok(branches.includes(branch), `branch not found: ${branches}`);

		// Metadata records the issue under its canonical id.
		const meta = JSON.parse(fs.readFileSync(path.join(repo.dir, ".mintree/metadata.json"), "utf-8"));
		assert.ok(meta.issues["FE-68"], "expected issue FE-68 in metadata");
	} finally {
		repo.restoreCwd();
	}
});

test("runCreate (linear): still accepts a convention branch as fallback", async () => {
	const repo = makeRepo(LINEAR_META);
	try {
		const result = await runCreate("feat/FE-70-x", { work: false });
		assert.ok(result.ok, `expected success, got: ${JSON.stringify(result)}`);
		if (!result.ok) return;
		assert.equal(result.branch, "feat/FE-70-x");
		assert.equal(result.issueId, "FE-70");
		assert.equal(path.basename(result.worktreePath), "FE-70");
	} finally {
		repo.restoreCwd();
	}
});

test("runCreate (github): rejects a Linear-style branch (behaviour unchanged)", async () => {
	const repo = makeRepo(GITHUB_META);
	try {
		const result = await runCreate("jdoe/fe-68-landing-page", { work: false });
		assert.equal(result.ok, false);
	} finally {
		repo.restoreCwd();
	}
});

test("runCreate (github): convention branch works", async () => {
	const repo = makeRepo(GITHUB_META);
	try {
		const result = await runCreate("feat/100-readme-update", { work: false });
		assert.ok(result.ok, `expected success, got: ${JSON.stringify(result)}`);
		if (!result.ok) return;
		assert.equal(result.issueId, "100");
		assert.equal(path.basename(result.worktreePath), "100");
	} finally {
		repo.restoreCwd();
	}
});

test("runCreate: copies metadata.linkFiles into the new worktree", async () => {
	const repo = makeRepo({ ...GITHUB_META, linkFiles: [".env"] });
	try {
		fs.writeFileSync(path.join(repo.dir, ".env"), "SECRET=staging\n");
		const result = await runCreate("feat/100-x", { work: false });
		assert.ok(result.ok, `expected success, got: ${JSON.stringify(result)}`);
		if (!result.ok) return;

		const copy = path.join(result.worktreePath, ".env");
		const stat = fs.lstatSync(copy);
		assert.ok(stat.isFile(), "expected .env to be a regular file");
		assert.ok(!stat.isSymbolicLink(), "expected .env to NOT be a symlink");
		// The copy starts identical to the main repo's .env...
		assert.equal(fs.readFileSync(copy, "utf-8"), "SECRET=staging\n");

		// ...but is independent: editing it does NOT mutate the main repo's .env.
		fs.writeFileSync(copy, "SECRET=worktree-local\n");
		assert.equal(fs.readFileSync(path.join(repo.dir, ".env"), "utf-8"), "SECRET=staging\n");

		const step = result.steps.find((s) => s.label === "copied .env");
		assert.ok(step && step.kind === "ok", "expected an ok step for the copied .env");
	} finally {
		repo.restoreCwd();
	}
});

test("runCreate: skips a linkFiles entry absent from the repo root", async () => {
	const repo = makeRepo({ ...GITHUB_META, linkFiles: [".env"] });
	try {
		// No .env created in the main repo this time.
		const result = await runCreate("feat/101-x", { work: false });
		assert.ok(result.ok, `expected success, got: ${JSON.stringify(result)}`);
		if (!result.ok) return;

		assert.ok(!fs.existsSync(path.join(result.worktreePath, ".env")), "no copy should be made");
		const step = result.steps.find((s) => s.label === "skipped copy .env");
		assert.ok(step && step.kind === "skip", "expected a skip step for the absent .env");
	} finally {
		repo.restoreCwd();
	}
});

// --- linkFiles: mode "link" (BE-155) ---

test('runCreate: a "link" entry becomes a symlink back to the main checkout', async () => {
	const repo = makeRepo({ ...GITHUB_META, linkFiles: [{ path: ".env.local", mode: "link" }] });
	try {
		fs.writeFileSync(path.join(repo.dir, ".env.local"), "PACT_TOKEN=shared\n");
		const result = await runCreate("feat/110-x", { work: false });
		assert.ok(result.ok, `expected success, got: ${JSON.stringify(result)}`);
		if (!result.ok) return;

		const link = path.join(result.worktreePath, ".env.local");
		assert.ok(fs.lstatSync(link).isSymbolicLink(), "expected .env.local to be a symlink");
		assert.equal(fs.readFileSync(link, "utf-8"), "PACT_TOKEN=shared\n");

		// Relative, so the link survives the tree being moved or mounted
		// elsewhere.
		assert.ok(!path.isAbsolute(fs.readlinkSync(link)), "expected a relative symlink target");

		// Single source of truth: rotating the credential in the main checkout
		// is visible from the worktree without re-creating it.
		fs.writeFileSync(path.join(repo.dir, ".env.local"), "PACT_TOKEN=rotated\n");
		assert.equal(fs.readFileSync(link, "utf-8"), "PACT_TOKEN=rotated\n");

		const step = result.steps.find((s) => s.label === "linked .env.local");
		assert.ok(step && step.kind === "ok", "expected an ok step for the linked .env.local");
	} finally {
		repo.restoreCwd();
	}
});

// --- init.sh failure (BE-155) ---

// Writes an executable .mintree/init.sh. `body` is the script after the
// shebang, so a test can make it fail on purpose.
function writeInitScript(repoDir: string, body: string): void {
	const p = path.join(repoDir, ".mintree", "init.sh");
	fs.writeFileSync(p, `#!/bin/sh\n${body}\n`);
	fs.chmodSync(p, 0o755);
}

test("runCreate: a failing init.sh is reported as an error step, not a warn", async () => {
	const repo = makeRepo(GITHUB_META);
	try {
		writeInitScript(repo.dir, 'echo "isolation setup blew up" >&2\nexit 3');
		const result = await runCreate("feat/120-x", { work: false });

		// The worktree is still created — the branch and any git work survive.
		assert.ok(result.ok, `expected success, got: ${JSON.stringify(result)}`);
		if (!result.ok) return;
		assert.ok(fs.existsSync(result.worktreePath), "worktree should still exist");

		assert.equal(result.initFailed, true);
		const step = result.steps.find((s) => s.label === "init.sh failed");
		assert.ok(step, "expected an init.sh failed step");
		assert.equal(step?.kind, "error", "a failed hook must not be a warn");
	} finally {
		repo.restoreCwd();
	}
});

test("runCreate: the failure detail carries the hook's own stderr, not just 'Command failed'", async () => {
	const repo = makeRepo(GITHUB_META);
	try {
		writeInitScript(repo.dir, 'echo "COMPOSE_PROJECT_NAME rename failed" >&2\nexit 3');
		const result = await runCreate("feat/121-x", { work: false });
		assert.ok(result.ok);
		if (!result.ok) return;

		const detail = result.steps.find((s) => s.label === "init.sh failed")?.detail ?? "";
		assert.match(detail, /COMPOSE_PROJECT_NAME rename failed/, `stderr was dropped: ${detail}`);
		assert.match(detail, /exit 3/, `exit status was dropped: ${detail}`);
		assert.equal(result.initError, detail);
	} finally {
		repo.restoreCwd();
	}
});

test("runCreate: a silent non-zero exit still reports the status", async () => {
	const repo = makeRepo(GITHUB_META);
	try {
		writeInitScript(repo.dir, "exit 1");
		const result = await runCreate("feat/122-x", { work: false });
		assert.ok(result.ok);
		if (!result.ok) return;

		assert.equal(result.initFailed, true);
		assert.match(result.initError ?? "", /exit 1/);
	} finally {
		repo.restoreCwd();
	}
});

test("runCreate: a failed init.sh withholds the --work hand-off", async () => {
	const repo = makeRepo(GITHUB_META);
	try {
		writeInitScript(repo.dir, "exit 1");
		const result = await runCreate("feat/123-x", {
			work: true,
			prompt: "arrancá el ticket",
		});
		assert.ok(result.ok);
		if (!result.ok) return;

		// This is the whole point: never hand an uninitialised worktree to an
		// agent, because its tooling can still be pointed at the main checkout.
		assert.equal(result.work, false, "--work must not survive a failed init.sh");
		assert.equal(result.promptFile, undefined, "no prompt should be staged for a hand-off");
		assert.ok(
			result.steps.some((s) => s.kind === "error" && s.label.includes("not launching Claude")),
			"expected an explicit step saying the launch was withheld",
		);
	} finally {
		repo.restoreCwd();
	}
});

test("runCreate: a failed init.sh is recorded in metadata", async () => {
	const repo = makeRepo(GITHUB_META);
	try {
		writeInitScript(repo.dir, "exit 1");
		const result = await runCreate("feat/124-x", { work: false });
		assert.ok(result.ok);
		if (!result.ok) return;

		const meta = JSON.parse(fs.readFileSync(path.join(repo.dir, ".mintree/metadata.json"), "utf-8"));
		assert.equal(meta.issues["124"]?.init_failed, true);
	} finally {
		repo.restoreCwd();
	}
});

test("runCreate: a successful init.sh leaves no failure marker and keeps --work", async () => {
	const repo = makeRepo(GITHUB_META);
	try {
		writeInitScript(repo.dir, 'echo "ok"\nexit 0');
		const result = await runCreate("feat/125-x", { work: true });
		assert.ok(result.ok);
		if (!result.ok) return;

		assert.equal(result.initFailed, false);
		assert.equal(result.work, true);
		const meta = JSON.parse(fs.readFileSync(path.join(repo.dir, ".mintree/metadata.json"), "utf-8"));
		assert.ok(!("init_failed" in (meta.issues["125"] ?? {})), "no marker on success");
		const step = result.steps.find((s) => s.label === "ran .mintree/init.sh");
		assert.ok(step && step.kind === "ok");
	} finally {
		repo.restoreCwd();
	}
});

test("runCreate: a repo with no init.sh is unaffected", async () => {
	const repo = makeRepo(GITHUB_META);
	try {
		const result = await runCreate("feat/126-x", { work: true });
		assert.ok(result.ok);
		if (!result.ok) return;

		assert.equal(result.initFailed, false);
		assert.equal(result.work, true, "no hook means nothing to fail — the hand-off proceeds");
	} finally {
		repo.restoreCwd();
	}
});

test("runCreate: a non-executable init.sh fails closed", async () => {
	const repo = makeRepo(GITHUB_META);
	try {
		const p = path.join(repo.dir, ".mintree", "init.sh");
		fs.writeFileSync(p, "#!/bin/sh\nexit 0\n");
		fs.chmodSync(p, 0o644);

		const result = await runCreate("feat/127-x", { work: true });
		assert.ok(result.ok);
		if (!result.ok) return;

		// A hook that exists but can't run leaves the worktree just as
		// uninitialised as one that ran and failed.
		assert.equal(result.initFailed, true);
		assert.equal(result.work, false);
		assert.match(result.initError ?? "", /not executable/);
	} finally {
		repo.restoreCwd();
	}
});

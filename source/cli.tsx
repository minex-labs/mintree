#!/usr/bin/env node
import Pastel from "pastel";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

const app = new Pastel({
	importMeta: import.meta,
	name: "mintree",
	version,
	description:
		"Issue-driven worktrees + Claude Code sessions for repos that already have an opinionated SDD+TDD flow.",
});

await app.run();

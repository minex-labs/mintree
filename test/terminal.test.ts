import { test } from "node:test";
import assert from "node:assert/strict";

import { isITerm, buildBadgeSequence } from "../source/lib/terminal.js";

const BEL = String.fromCharCode(7);
const ESC = String.fromCharCode(27);

// Snapshot/restore the env keys these helpers read so tests don't leak state.
function withEnv(overrides: Record<string, string | undefined>, fn: () => void) {
	const keys = ["TERM_PROGRAM", "LC_TERMINAL", "TMUX"];
	const saved: Record<string, string | undefined> = {};
	for (const k of keys) saved[k] = process.env[k];
	try {
		for (const k of keys) delete process.env[k];
		for (const [k, v] of Object.entries(overrides)) {
			if (v !== undefined) process.env[k] = v;
		}
		fn();
	} finally {
		for (const k of keys) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	}
}

test("isITerm: true when TERM_PROGRAM is iTerm.app", () => {
	withEnv({ TERM_PROGRAM: "iTerm.app" }, () => {
		assert.equal(isITerm(), true);
	});
});

test("isITerm: true when LC_TERMINAL is iTerm2 (e.g. through tmux/ssh)", () => {
	withEnv({ LC_TERMINAL: "iTerm2" }, () => {
		assert.equal(isITerm(), true);
	});
});

test("isITerm: false for other terminals", () => {
	withEnv({ TERM_PROGRAM: "Apple_Terminal" }, () => {
		assert.equal(isITerm(), false);
	});
});

test("buildBadgeSequence: wraps a base64 SetBadgeFormat payload", () => {
	withEnv({}, () => {
		const seq = buildBadgeSequence("FE-68");
		const b64 = Buffer.from("FE-68", "utf8").toString("base64");
		assert.equal(seq, `${ESC}]1337;SetBadgeFormat=${b64}${BEL}`);
	});
});

test("buildBadgeSequence: empty text encodes the clear payload", () => {
	withEnv({}, () => {
		const seq = buildBadgeSequence("");
		assert.equal(seq, `${ESC}]1337;SetBadgeFormat=${BEL}`);
	});
});

test("buildBadgeSequence: wraps in tmux DCS passthrough when $TMUX is set", () => {
	withEnv({ TMUX: "/tmp/tmux-501/default,1,0" }, () => {
		const seq = buildBadgeSequence("FE-68");
		const b64 = Buffer.from("FE-68", "utf8").toString("base64");
		const inner = `${ESC}${ESC}]1337;SetBadgeFormat=${b64}${BEL}`;
		assert.equal(seq, `${ESC}Ptmux;${inner}${ESC}\\`);
	});
});

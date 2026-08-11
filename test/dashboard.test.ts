import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";

import { IssueListRow, RemoveOverlayView } from "../source/commands/dashboard.js";

// Minimal DashboardIssue stub — IssueListRow only touches issue.id/title/
// priority and project.statusColor. Cast keeps the fixture small.
function makeIssue(id: string, title: string) {
	return {
		issue: { id, title, priority: null },
		project: { statusColor: "gray" },
	} as never;
}

function frame(checkbox?: "on" | "off"): string {
	const { lastFrame } = render(
		React.createElement(IssueListRow, {
			d: makeIssue("FE-46", "some worktree"),
			selected: false,
			identifierWidth: 6,
			rowWidth: 60,
			checkbox,
		}),
	);
	return lastFrame() ?? "";
}

// Regression guard for 0.5.15: the Worktrees/Orchestrate tabs pass a `checkbox`
// prop so each row renders a leading [ ]/[✔]. A row with no checkbox (Issues
// tab) must keep the plain indent — no brackets.
test("IssueListRow: renders an empty checkbox when checkbox='off'", () => {
	const out = frame("off");
	assert.match(out, /\[ \]/);
	assert.doesNotMatch(out, /\[✔\]/);
});

test("IssueListRow: renders a ticked checkbox when checkbox='on'", () => {
	const out = frame("on");
	assert.match(out, /\[✔\]/);
});

test("IssueListRow: renders no checkbox brackets when checkbox is undefined", () => {
	const out = frame(undefined);
	assert.doesNotMatch(out, /\[[ ✔]\]/);
});

// --- RemoveOverlayView -----------------------------------------------------

function makeTargets(n: number, dirty = false) {
	return Array.from({ length: n }, (_, i) => ({
		issue: makeIssue(`BE-${100 + i}`, `worktree ${i}`),
		branch: `fix/BE-${100 + i}-something`,
		worktreePath: `/tmp/wt/BE-${100 + i}`,
		dirty,
	}));
}

// The progress line renders an <ink-spinner>, whose interval keeps the test
// process alive — unmount before returning the frame.
function removeFrame(overlay: unknown, maxListRows = 40): string {
	const { lastFrame, unmount } = render(
		React.createElement(RemoveOverlayView, { overlay, maxListRows } as never),
	);
	const out = lastFrame() ?? "";
	unmount();
	return out;
}

// Regression guard: the batch removal used to run every `runRemove` in one
// synchronous tick, so the frozen confirmation stayed on screen with no sign
// the removal had started. While `progress` is set the overlay must show the
// running counter instead of the confirmation prompt.
test("RemoveOverlayView: shows a progress counter while the batch is running", () => {
	const out = removeFrame({
		kind: "remove",
		targets: makeTargets(104, true),
		error: null,
		progress: { done: 11, total: 104, current: "BE-172", failed: 0 },
	});
	assert.match(out, /Removing 12\/104/);
	assert.match(out, /BE-172/);
	assert.doesNotMatch(out, /to force-remove/);
});

test("RemoveOverlayView: surfaces the failure count in the progress line", () => {
	const out = removeFrame({
		kind: "remove",
		targets: makeTargets(5),
		error: null,
		progress: { done: 3, total: 5, current: "BE-103", failed: 2 },
	});
	assert.match(out, /\(2 failed\)/);
});

test("RemoveOverlayView: shows the confirmation prompt before the batch starts", () => {
	const out = removeFrame({
		kind: "remove",
		targets: makeTargets(3, true),
		error: null,
		progress: null,
	});
	assert.match(out, /to force-remove/);
	assert.doesNotMatch(out, /Removing \d+\//);
});

// A batch bigger than the terminal used to render one row per worktree and push
// the confirm/progress line off screen — the reason the running state was
// invisible in the first place.
test("RemoveOverlayView: caps the target list and reports the remainder", () => {
	const out = removeFrame(
		{ kind: "remove", targets: makeTargets(104), error: null, progress: null },
		10,
	);
	assert.match(out, /… and 94 more/);
	assert.match(out, /BE-109/);
	assert.doesNotMatch(out, /BE-11[0-9]/);
});

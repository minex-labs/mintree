import { test } from "node:test";
import assert from "node:assert/strict";
import React, { useState } from "react";
import { render } from "ink-testing-library";

import { MultilineTextArea } from "../source/lib/MultilineTextArea.js";

const noop = () => {};

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Controlled wrapper mirroring the dashboard's usage: the parent owns `value`
// and updates it from onChange. Exposes the latest value via the ref so a test
// can assert the buffer after feeding keystrokes.
function Harness({ latest }: { latest: { current: string } }) {
	const [v, setV] = useState("");
	latest.current = v;
	return React.createElement(MultilineTextArea, {
		value: v,
		onChange: setV,
		onSubmit: noop,
		onCancel: noop,
		width: 40,
		height: 6,
	});
}

// 0.5.18: the Extra field is a multi-line box (ported from santree) so a long,
// multi-line paste no longer corrupts the overlay layout the way the old
// single-line ink-text-input did.

test("MultilineTextArea: shows the placeholder when empty", () => {
	const { lastFrame } = render(
		React.createElement(MultilineTextArea, {
			value: "",
			onChange: noop,
			onSubmit: noop,
			onCancel: noop,
			placeholder: "Type or paste extra context…",
			width: 40,
			height: 4,
		}),
	);
	assert.match(lastFrame() ?? "", /Type or paste extra context…/);
});

test("MultilineTextArea: renders a bordered box", () => {
	const { lastFrame } = render(
		React.createElement(MultilineTextArea, {
			value: "hello",
			onChange: noop,
			onSubmit: noop,
			onCancel: noop,
			width: 40,
			height: 4,
		}),
	);
	// Round border corners drawn by Ink's borderStyle="round".
	assert.match(lastFrame() ?? "", /╭|╮|╰|╯/);
});

test("MultilineTextArea: renders every line of a multi-line value", () => {
	const { lastFrame } = render(
		React.createElement(MultilineTextArea, {
			value: "primera linea\nsegunda linea\ntercera linea",
			onChange: noop,
			onSubmit: noop,
			onCancel: noop,
			width: 40,
			height: 6,
		}),
	);
	const out = lastFrame() ?? "";
	assert.match(out, /primera linea/);
	assert.match(out, /segunda linea/);
	assert.match(out, /tercera linea/);
});

// 0.5.21 regression: a large paste reaches stdin as several `data` chunks that
// all fire before React re-renders. Reading the stale `value` prop per chunk
// dropped text; chaining through refs must keep every chunk in order.
test("MultilineTextArea: keeps every chunk of a fragmented paste (in order)", async () => {
	const latest = { current: "" };
	const { stdin, unmount } = render(React.createElement(Harness, { latest }));
	await delay(10);
	// Three chunks written back-to-back in the same tick — no await between them,
	// so they land before the parent's setState re-renders.
	stdin.write("AAAA");
	stdin.write("BBBB");
	stdin.write("CCCC");
	await delay(30);
	assert.equal(latest.current, "AAAABBBBCCCC");
	unmount();
});

test("MultilineTextArea: types characters into the buffer", async () => {
	const latest = { current: "" };
	const { stdin, unmount } = render(React.createElement(Harness, { latest }));
	await delay(10);
	stdin.write("hola");
	await delay(30);
	assert.equal(latest.current, "hola");
	unmount();
});

// 0.5.22: launch key is Ctrl+X (\x18). Enter stays a newline.
test("MultilineTextArea: Ctrl+X fires onSubmit, Enter does not", async () => {
	let submits = 0;
	const latest = { current: "" };
	function SubmitHarness() {
		const [v, setV] = useState("");
		latest.current = v;
		return React.createElement(MultilineTextArea, {
			value: v,
			onChange: setV,
			onSubmit: () => {
				submits += 1;
			},
			onCancel: noop,
			width: 40,
			height: 6,
		});
	}
	const { stdin, unmount } = render(React.createElement(SubmitHarness));
	await delay(10);
	stdin.write("\r"); // Enter → newline, not submit
	await delay(20);
	assert.equal(submits, 0);
	assert.equal(latest.current, "\n");
	stdin.write("\x18"); // Ctrl+X → submit
	await delay(20);
	assert.equal(submits, 1);
	unmount();
});

// 0.5.24: Ctrl+L (\x0c) clears the whole box regardless of cursor position.
test("MultilineTextArea: Ctrl+L clears all text", async () => {
	const latest = { current: "seed" };
	function ClearHarness() {
		const [v, setV] = useState("seed");
		latest.current = v;
		return React.createElement(MultilineTextArea, {
			value: v,
			onChange: setV,
			onSubmit: noop,
			onCancel: noop,
			width: 40,
			height: 6,
		});
	}
	const { stdin, unmount } = render(React.createElement(ClearHarness));
	await delay(10);
	stdin.write("more text");
	await delay(20);
	assert.equal(latest.current, "seedmore text");
	stdin.write("\x0c"); // Ctrl+L → clear
	await delay(20);
	assert.equal(latest.current, "");
	unmount();
});

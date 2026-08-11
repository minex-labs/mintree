import { useRef, useState } from "react";
import { Box, Text, useInput } from "ink";

// Multi-line text box for Ink, adapted from santree's MultilineTextArea. Unlike
// `ink-text-input` (single line) this handles Enter-as-newline and — crucially —
// pasting a long, multi-line block without corrupting the layout: the paste is
// inserted as one chunk and the box scrolls internally instead of overflowing
// the terminal. Keybindings: Ctrl+X submits, Ctrl+G cancels, Ctrl+L clears the
// whole box, Enter inserts a newline. Tab and Esc are swallowed so the parent
// overlay can own them (field navigation / cancel).
//
// The buffer + cursor are mirrored into refs (valueRef / cursorRef) that update
// synchronously on every edit. A large paste arrives split across several stdin
// `data` events that all fire before React re-renders; reading the `value` prop
// (stale until the next render) would make each chunk overwrite the previous one
// and silently drop text. Chaining edits through the refs keeps every chunk.

interface MultilineTextAreaProps {
	value: string;
	onChange: (value: string) => void;
	onSubmit: () => void;
	onCancel: () => void;
	placeholder?: string;
	width?: number;
	height?: number;
	focus?: boolean;
}

// ── Word boundary helpers (whitespace-delimited) ────────────────────────────

function prevWordStart(text: string, pos: number): number {
	let p = pos;
	while (p > 0 && /\s/.test(text[p - 1]!)) p--;
	while (p > 0 && /\S/.test(text[p - 1]!)) p--;
	return p;
}

function nextWordEnd(text: string, pos: number): number {
	let p = pos;
	while (p < text.length && /\s/.test(text[p]!)) p++;
	while (p < text.length && /\S/.test(text[p]!)) p++;
	return p;
}

function lineStart(text: string, pos: number): number {
	const before = text.lastIndexOf("\n", pos - 1);
	return before === -1 ? 0 : before + 1;
}

function lineEnd(text: string, pos: number): number {
	const after = text.indexOf("\n", pos);
	return after === -1 ? text.length : after;
}

// ── Visual layout (soft-wrap each logical line at inner width) ──────────────

interface VisualRow {
	logicalLine: number;
	startCol: number;
	text: string;
}

function buildVisualRows(value: string, innerWidth: number): VisualRow[] {
	const lines = value.length === 0 ? [""] : value.split("\n");
	const rows: VisualRow[] = [];
	const w = Math.max(1, innerWidth);
	for (let li = 0; li < lines.length; li++) {
		const line = lines[li]!;
		if (line.length === 0) {
			rows.push({ logicalLine: li, startCol: 0, text: "" });
			continue;
		}
		for (let i = 0; i < line.length; i += w) {
			rows.push({ logicalLine: li, startCol: i, text: line.slice(i, i + w) });
		}
	}
	return rows;
}

function cursorVisualPos(
	rows: VisualRow[],
	value: string,
	cursor: number,
	innerWidth: number,
): { vRow: number; vCol: number } {
	const lines = value.length === 0 ? [""] : value.split("\n");
	let logicalLine = 0;
	let lineStartOffset = 0;
	for (let li = 0; li < lines.length; li++) {
		const len = lines[li]!.length;
		if (cursor <= lineStartOffset + len) {
			logicalLine = li;
			break;
		}
		lineStartOffset += len + 1;
	}
	const colInLine = cursor - lineStartOffset;
	const candidates = rows
		.map((r, i) => ({ r, i }))
		.filter(({ r }) => r.logicalLine === logicalLine);
	for (let ci = 0; ci < candidates.length; ci++) {
		const { r, i } = candidates[ci]!;
		if (colInLine >= r.startCol && colInLine < r.startCol + r.text.length) {
			return { vRow: i, vCol: colInLine - r.startCol };
		}
		if (colInLine === r.startCol + r.text.length) {
			// Cursor sits at the end of this visual row. If the row is exactly
			// width-full AND there's another visual row in the same logical line,
			// the next typed char belongs at the start of that next row — defer.
			if (r.text.length === innerWidth && ci + 1 < candidates.length) {
				continue;
			}
			// Last row of this logical line and exactly width-full → return a
			// virtual row past the end so the cursor renders at col 0 of a fresh
			// row instead of overflowing the right edge.
			if (r.text.length === innerWidth) {
				return { vRow: i + 1, vCol: 0 };
			}
			return { vRow: i, vCol: colInLine - r.startCol };
		}
	}
	const last = candidates[candidates.length - 1];
	if (last) return { vRow: last.i, vCol: last.r.text.length };
	return { vRow: 0, vCol: 0 };
}

export function MultilineTextArea({
	value,
	onChange,
	onSubmit,
	onCancel,
	placeholder,
	width,
	height = 6,
	focus = true,
}: MultilineTextAreaProps) {
	// `cursor` state exists only to trigger re-renders; cursorRef is the source
	// of truth read/written synchronously during an input burst.
	const [, setCursorState] = useState(value.length);
	const valueRef = useRef(value);
	const cursorRef = useRef(value.length);
	// The last value we emitted via onChange. Lets us tell our own updates (which
	// come back as an equal `value` prop) apart from an external reset.
	const lastEmittedRef = useRef(value);

	// Reconcile an external `value` change (e.g. the parent clears the field)
	// during render. We skip our own echoes so a burst of paste chunks chains
	// onto valueRef instead of being reset to the stale prop mid-burst.
	if (value !== lastEmittedRef.current) {
		valueRef.current = value;
		lastEmittedRef.current = value;
		if (cursorRef.current > value.length) cursorRef.current = value.length;
	}

	const setCursor = (n: number) => {
		const clamped = Math.max(0, Math.min(valueRef.current.length, n));
		cursorRef.current = clamped;
		setCursorState(clamped);
	};

	const emit = (next: string) => {
		valueRef.current = next;
		lastEmittedRef.current = next;
		onChange(next);
	};

	const insertAt = (pos: number, text: string) => {
		const base = valueRef.current;
		emit(base.slice(0, pos) + text + base.slice(pos));
		setCursor(pos + text.length);
	};

	const deleteRange = (from: number, to: number) => {
		if (from === to) return;
		const base = valueRef.current;
		const lo = Math.min(from, to);
		const hi = Math.max(from, to);
		emit(base.slice(0, lo) + base.slice(hi));
		setCursor(lo);
	};

	useInput(
		(input, key) => {
			// Read the live buffer/cursor from refs — during a paste burst the
			// `value` prop and `cursor` state are one or more chunks behind.
			const value = valueRef.current;
			const cursor = cursorRef.current;

			// Ctrl+X: submit (launch). Enter is reserved for inserting a newline, so
			// launching needs a distinct key; Ctrl+X (nano-style) works with no
			// terminal config, unlike Option+Enter (needs iTerm "Esc+") or Ctrl+D
			// (collided with an iTerm hotkey).
			if (key.ctrl && input === "x") {
				onSubmit();
				return;
			}

			// Ctrl+G: cancel (Emacs abort). Ctrl+C can't be used because Ink's
			// exitOnCtrlC fires at the app level before useInput sees it.
			if (key.ctrl && input === "g") {
				onCancel();
				return;
			}

			// Ctrl+L: clear the whole box (wipe all text). Distinct from Ctrl+U
			// (delete to line start) — this empties the buffer regardless of where
			// the cursor is. Ctrl+L (screen-clear mnemonic) is free here.
			if (key.ctrl && input === "l") {
				emit("");
				setCursor(0);
				return;
			}

			// Esc and Tab: swallow so the parent overlay owns them (cancel / field
			// navigation). Without this, Tab would type a literal char below.
			if (key.escape) return;
			if (key.tab) return;

			// ── Readline-ish line editing ───────────────────────────────────
			if (key.ctrl && input === "a") {
				setCursor(lineStart(value, cursor));
				return;
			}
			if (key.ctrl && input === "e") {
				setCursor(lineEnd(value, cursor));
				return;
			}
			if (key.ctrl && input === "w") {
				deleteRange(prevWordStart(value, cursor), cursor);
				return;
			}
			if (key.ctrl && input === "u") {
				deleteRange(lineStart(value, cursor), cursor);
				return;
			}
			if (key.ctrl && input === "k") {
				deleteRange(cursor, lineEnd(value, cursor));
				return;
			}

			// Option+Backspace: delete word backwards
			if (key.meta && (key.backspace || key.delete)) {
				deleteRange(prevWordStart(value, cursor), cursor);
				return;
			}

			// Option+Left / Option+Right: word jump. Mac terminals often send the
			// emacs-style `\x1bb` / `\x1bf`, reported as `key.meta && input === b|f`.
			if (key.meta && (key.leftArrow || input === "b")) {
				setCursor(prevWordStart(value, cursor));
				return;
			}
			if (key.meta && (key.rightArrow || input === "f")) {
				setCursor(nextWordEnd(value, cursor));
				return;
			}
			// Option+Up / Option+Down: doc start/end
			if (key.meta && key.upArrow) {
				setCursor(0);
				return;
			}
			if (key.meta && key.downArrow) {
				setCursor(value.length);
				return;
			}

			if (key.backspace || key.delete) {
				if (cursor === 0) return;
				deleteRange(cursor - 1, cursor);
				return;
			}

			// Plain arrows: visual-row navigation when possible; left/right by 1.
			if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) {
				if (key.leftArrow) {
					setCursor(Math.max(0, cursor - 1));
					return;
				}
				if (key.rightArrow) {
					setCursor(Math.min(value.length, cursor + 1));
					return;
				}
				const innerW = Math.max(1, (width ?? 80) - 4);
				const rows = buildVisualRows(value, innerW);
				const { vRow, vCol } = cursorVisualPos(rows, value, cursor, innerW);
				const targetVRow = key.upArrow ? vRow - 1 : vRow + 1;
				if (targetVRow < 0) {
					setCursor(0);
					return;
				}
				if (targetVRow >= rows.length) {
					setCursor(value.length);
					return;
				}
				const target = rows[targetVRow]!;
				const targetColInLine = target.startCol + Math.min(vCol, target.text.length);
				let offset = 0;
				const lines = value.length === 0 ? [""] : value.split("\n");
				for (let li = 0; li < target.logicalLine; li++) offset += lines[li]!.length + 1;
				setCursor(offset + targetColInLine);
				return;
			}

			// Enter: insert newline (also handles a paste that carries \r).
			if (key.return) {
				const chunk = input ? input.replace(/\r\n?/g, "\n") : "\n";
				insertAt(cursor, chunk);
				return;
			}

			if (key.ctrl || key.meta) return;
			if (!input) return;

			// Strip terminal escape noise that leaks into a paste: OSC responses
			// (terminal-side answers to OSC 11/52 queries during a refresh) in both
			// the full `\x1b]…\x07` form and the bracket-only fragment Ink leaves
			// when it consumed the leading ESC; and bracketed-paste guards
			// (`\x1b[200~` / `\x1b[201~`) some terminals wrap pastes in.
			const cleaned = input
				.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
				.replace(/^\][0-9]+;[^\x07]*\x07?/, "")
				.replace(/\x1b\[20[01]~/g, "")
				.replace(/\[20[01]~/g, "");
			if (!cleaned) return;

			insertAt(cursor, cleaned.replace(/\r\n?/g, "\n"));
		},
		{ isActive: focus },
	);

	const text = valueRef.current;
	const cursor = cursorRef.current;
	const innerWidth = Math.max(1, (width ?? 80) - 4);
	const rows = buildVisualRows(text, innerWidth);
	const { vRow: cursorVRow, vCol: cursorVCol } = cursorVisualPos(rows, text, cursor, innerWidth);
	const totalRows = Math.max(rows.length, cursorVRow + 1);

	let scrollStart = 0;
	if (cursorVRow >= height) scrollStart = cursorVRow - height + 1;
	const visibleRows = rows.slice(scrollStart, scrollStart + height);
	const isEmpty = text.length === 0;
	const hiddenAbove = scrollStart;
	const hiddenBelow = Math.max(0, totalRows - scrollStart - height);

	return (
		<Box flexDirection="column" width={width}>
			<Box
				flexDirection="column"
				width={width}
				borderStyle="round"
				borderColor={focus ? "cyan" : "gray"}
				paddingX={1}
				minHeight={height + 2}
			>
				{isEmpty && placeholder ? (
					<Box minHeight={1}>
						{focus && <Text inverse> </Text>}
						<Text dimColor>{placeholder}</Text>
					</Box>
				) : (
					Array.from({ length: height }).map((_, i) => {
						const row = visibleRows[i];
						const absoluteVRow = scrollStart + i;
						const isCursorRow = focus && absoluteVRow === cursorVRow;
						if (!row) {
							// Phantom row past the end (cursor on a fresh line at wrap boundary)
							if (isCursorRow) {
								return (
									<Box key={`phantom-${i}`} minHeight={1}>
										<Text inverse> </Text>
									</Box>
								);
							}
							return <Box key={`pad-${i}`} minHeight={1} />;
						}
						if (!isCursorRow) {
							return (
								<Box key={i} minHeight={1}>
									<Text>{row.text}</Text>
								</Box>
							);
						}
						const before = row.text.slice(0, cursorVCol);
						const atCursor = cursorVCol < row.text.length ? row.text[cursorVCol]! : " ";
						const after = cursorVCol < row.text.length ? row.text.slice(cursorVCol + 1) : "";
						return (
							<Box key={i} minHeight={1}>
								<Text>{before}</Text>
								<Text inverse>{atCursor}</Text>
								<Text>{after}</Text>
							</Box>
						);
					})
				)}
			</Box>
			{(hiddenAbove > 0 || hiddenBelow > 0) && (
				<Box justifyContent="space-between" paddingX={1}>
					<Text dimColor>{hiddenAbove > 0 ? `↑ ${hiddenAbove} more above` : ""}</Text>
					<Text dimColor>{hiddenBelow > 0 ? `${hiddenBelow} more below ↓` : ""}</Text>
				</Box>
			)}
		</Box>
	);
}

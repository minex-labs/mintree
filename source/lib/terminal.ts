// iTerm2 badge integration.
//
// Claude Code overwrites the terminal title (OSC 0/2) while it runs and exposes
// no way to disable that or pin a custom title, so a tab title we set before
// launching wouldn't survive. The iTerm2 *badge* — a large translucent label
// drawn over the session — is independent of the title and Claude never touches
// it, so it's the one reliable way to identify a mintree session at a glance
// (e.g. the worktree issue id `FE-68`, or `orchestrator-FE-12_BE-16`).
//
// Everything here is a no-op outside iTerm2, so callers can invoke it
// unconditionally.

const BEL = String.fromCharCode(7); // \a (BEL)
const ESC = String.fromCharCode(27); // \e (ESC)

/** True when the active terminal is iTerm2 (also detected through tmux). */
export function isITerm(): boolean {
	return process.env["TERM_PROGRAM"] === "iTerm.app" || process.env["LC_TERMINAL"] === "iTerm2";
}

// tmux swallows unknown escape sequences unless they're wrapped in its DCS
// passthrough (with every inner ESC doubled). Harmless when not in tmux, but we
// only wrap when $TMUX is set to keep the common case clean.
function wrapForTmux(seq: string): string {
	if (!process.env["TMUX"]) return seq;
	const doubled = seq.split(ESC).join(ESC + ESC);
	return `${ESC}Ptmux;${doubled}${ESC}\\`;
}

/**
 * Builds the raw iTerm2 SetBadgeFormat escape sequence for `text`. Pure (no I/O)
 * so it can be unit-tested; an empty string clears the badge. The badge format
 * supports `\(...)` interpolation in iTerm2, but plain ids/labels carry no
 * parens so the base64-encoded literal renders verbatim.
 */
export function buildBadgeSequence(text: string): string {
	const b64 = Buffer.from(text, "utf8").toString("base64");
	return wrapForTmux(`${ESC}]1337;SetBadgeFormat=${b64}${BEL}`);
}

function writeToTty(seq: string): void {
	// We only call this right before spawning Claude / right after it exits,
	// moments when the parent process owns the TTY. Skip when stdout isn't a TTY
	// (piped/CI) — there's no terminal to talk to.
	if (process.stdout.isTTY) process.stdout.write(seq);
}

/** Sets the iTerm2 badge to `text`. No-op outside iTerm2 or with empty text. */
export function setITermBadge(text: string): void {
	if (!isITerm() || !text) return;
	writeToTty(buildBadgeSequence(text));
}

/** Clears the iTerm2 badge. No-op outside iTerm2. */
export function clearITermBadge(): void {
	if (!isITerm()) return;
	writeToTty(buildBadgeSequence(""));
}

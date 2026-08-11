/** True when the active terminal is iTerm2 (also detected through tmux). */
export declare function isITerm(): boolean;
/**
 * Builds the raw iTerm2 SetBadgeFormat escape sequence for `text`. Pure (no I/O)
 * so it can be unit-tested; an empty string clears the badge. The badge format
 * supports `\(...)` interpolation in iTerm2, but plain ids/labels carry no
 * parens so the base64-encoded literal renders verbatim.
 */
export declare function buildBadgeSequence(text: string): string;
/** Sets the iTerm2 badge to `text`. No-op outside iTerm2 or with empty text. */
export declare function setITermBadge(text: string): void;
/** Clears the iTerm2 badge. No-op outside iTerm2. */
export declare function clearITermBadge(): void;

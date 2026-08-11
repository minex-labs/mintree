/**
 * Issue priority, normalised across providers.
 *
 * Linear exposes a native `priority` field on the 0-4 scale:
 *   0 = No priority, 1 = Urgent, 2 = High, 3 = Medium, 4 = Low.
 * GitHub Issues has no native priority concept, so its provider always yields
 * `null` here — the dashboard simply renders no priority glyph for those rows.
 *
 * `ProviderIssue.priority` stores the raw Linear number (or null), and these
 * helpers turn it into a compact dashboard glyph and a sort rank. Keeping the
 * mapping in one module means the render path (dashboard.tsx) and the sort
 * path (dashboard.ts) stay in lock-step.
 */
export type PriorityValue = number | null | undefined;
export type PriorityDisplay = {
    /** Human label, e.g. "Urgent". Empty string when there's no priority. */
    label: string;
    /** Single-width glyph for the list row. A space when there's no priority. */
    icon: string;
    /** Ink-renderable colour name for the glyph. */
    color: string;
};
/**
 * Maps a raw priority value to its dashboard glyph. Urgent reads as a bold
 * red bang; High/Medium/Low use arrows that step down in weight and colour.
 * "No priority" (0) and null both render as a blank, keeping rows aligned
 * without drawing the eye.
 */
export declare function priorityDisplay(priority: PriorityValue): PriorityDisplay;
/**
 * Sort rank for "highest priority first". Urgent (1) sorts before Low (4);
 * "No priority" (0) and null sort last. Used as a tie-break inside a status
 * group before the newest-first fallback.
 */
export declare function prioritySortRank(priority: PriorityValue): number;

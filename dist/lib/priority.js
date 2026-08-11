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
const NONE = { label: "", icon: " ", color: "gray" };
/**
 * Maps a raw priority value to its dashboard glyph. Urgent reads as a bold
 * red bang; High/Medium/Low use arrows that step down in weight and colour.
 * "No priority" (0) and null both render as a blank, keeping rows aligned
 * without drawing the eye.
 */
export function priorityDisplay(priority) {
    switch (priority) {
        case 1:
            return { label: "Urgent", icon: "!", color: "red" };
        case 2:
            return { label: "High", icon: "↑", color: "red" };
        case 3:
            return { label: "Medium", icon: "=", color: "yellow" };
        case 4:
            return { label: "Low", icon: "↓", color: "blue" };
        default:
            return NONE;
    }
}
/**
 * Sort rank for "highest priority first". Urgent (1) sorts before Low (4);
 * "No priority" (0) and null sort last. Used as a tie-break inside a status
 * group before the newest-first fallback.
 */
export function prioritySortRank(priority) {
    if (priority == null || priority === 0)
        return Number.POSITIVE_INFINITY;
    return priority;
}

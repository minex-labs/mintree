/**
 * Variables available to a `promptTemplate` in `.mintree/metadata.json`.
 * Kept intentionally small — the template seeds Claude's first message, it
 * doesn't need the whole issue object.
 */
export type PromptVars = {
    id: string;
    title: string;
    url: string;
};
export declare const PROMPT_PLACEHOLDERS: readonly ["{{id}}", "{{title}}", "{{url}}"];
/**
 * Renders a `promptTemplate` by substituting the `{{id}}`, `{{title}}` and
 * `{{url}}` placeholders with the issue's values. Whitespace inside the braces
 * is tolerated (`{{ id }}`). Unknown placeholders are left untouched so a typo
 * is visible in the launched prompt instead of silently vanishing.
 */
export declare function renderPromptTemplate(template: string, vars: PromptVars): string;
/**
 * Variables available to an `orchestratorPromptTemplate`. The orchestrator
 * works a batch of tickets, so it only needs the list of ids and the count —
 * not per-issue title/url (the orchestrator looks those up itself).
 */
export type OrchestratorVars = {
    ids: string;
    count: number;
};
export declare const ORCHESTRATOR_PLACEHOLDERS: readonly ["{{ids}}", "{{count}}"];
/**
 * Renders an `orchestratorPromptTemplate` by substituting the `{{ids}}` and
 * `{{count}}` placeholders. Whitespace inside the braces is tolerated
 * (`{{ ids }}`); unknown placeholders are left untouched so a typo is visible
 * in the launched prompt instead of silently vanishing.
 */
export declare function renderOrchestratorTemplate(template: string, vars: OrchestratorVars): string;
/**
 * Built-in default for the orchestrator message, used when the repo doesn't
 * configure an `orchestratorPromptTemplate`. Mirrors the manual flow the user
 * was running by hand: act as an orchestrator over the selected tickets,
 * resolve them with minimal intervention, parallelise via subagents unless
 * dependencies force sequential work, and for each ticket follow the repo
 * conventions, create the worktree with mintree, use the right skills, move it
 * to "in progress" on start and close it when done.
 */
export declare function defaultOrchestratorPrompt(ids: string): string;

// Placeholder tokens a user can drop into their `promptTemplate`. Documented
// here so the README and any future `init`/help output stay in sync.
export const PROMPT_PLACEHOLDERS = ["{{id}}", "{{title}}", "{{url}}"];
/**
 * Renders a `promptTemplate` by substituting the `{{id}}`, `{{title}}` and
 * `{{url}}` placeholders with the issue's values. Whitespace inside the braces
 * is tolerated (`{{ id }}`). Unknown placeholders are left untouched so a typo
 * is visible in the launched prompt instead of silently vanishing.
 */
export function renderPromptTemplate(template, vars) {
    return template
        .replace(/\{\{\s*id\s*\}\}/g, vars.id)
        .replace(/\{\{\s*title\s*\}\}/g, vars.title)
        .replace(/\{\{\s*url\s*\}\}/g, vars.url);
}
// Placeholder tokens for an `orchestratorPromptTemplate`. Kept in sync with
// the README and any `init`/help output.
export const ORCHESTRATOR_PLACEHOLDERS = ["{{ids}}", "{{count}}"];
/**
 * Renders an `orchestratorPromptTemplate` by substituting the `{{ids}}` and
 * `{{count}}` placeholders. Whitespace inside the braces is tolerated
 * (`{{ ids }}`); unknown placeholders are left untouched so a typo is visible
 * in the launched prompt instead of silently vanishing.
 */
export function renderOrchestratorTemplate(template, vars) {
    return template
        .replace(/\{\{\s*ids\s*\}\}/g, vars.ids)
        .replace(/\{\{\s*count\s*\}\}/g, String(vars.count));
}
/**
 * Built-in default for the orchestrator message, used when the repo doesn't
 * configure an `orchestratorPromptTemplate`. Mirrors the manual flow the user
 * was running by hand: act as an orchestrator over the selected tickets,
 * resolve them with minimal intervention, parallelise via subagents unless
 * dependencies force sequential work, and for each ticket follow the repo
 * conventions, create the worktree with mintree, use the right skills, move it
 * to "in progress" on start and close it when done.
 */
export function defaultOrchestratorPrompt(ids) {
    return [
        `Quiero que hagas de orquestador con los tickets ${ids}.`,
        "",
        "La idea es que resuelvas esos tickets con la menor intervención mía posible.",
        "Trabajá los tickets en paralelo creando subagentes (a no ser que tengan",
        "dependencias entre sí y no se puedan paralelizar, en cuyo caso trabajalos",
        "secuencialmente). Para cada ticket: seguí los lineamientos del repo, creá el",
        "worktree usando mintree, usá las skills correctas para cada caso, poné el ticket",
        'en "in progress" al empezar y cerralo al terminar.',
    ].join("\n");
}

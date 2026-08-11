/**
 * Factory + shared UI helpers for the issue providers. Callers ask for a
 * provider given the repo's metadata; the factory picks the implementation
 * based on `metadata.provider` (defaults to github for back-compat). All
 * other code talks to `IssueProvider` without caring which backend is in
 * use.
 */
import { readMetadata } from "../metadata.js";
import { GithubProvider } from "./github.js";
import { LinearProvider } from "./linear.js";
/**
 * Returns the IssueProvider for this repo. Reads metadata.provider — when
 * omitted (i.e. repos initialised before the provider field existed) we
 * default to github so the change is invisible to existing users.
 */
export function createProvider(repoRoot) {
    const metadata = readMetadata(repoRoot);
    const kind = metadata.provider ?? "github";
    switch (kind) {
        case "github":
            return new GithubProvider(repoRoot);
        case "linear":
            return new LinearProvider(repoRoot);
    }
}
/**
 * Maps a TransitionResult to a UI-renderable row (icon kind + label +
 * optional detail). Provider-agnostic — both providers produce the same
 * TransitionResult shape — so the dashboard and create command share this
 * single mapping.
 */
export function describeTransition(result) {
    switch (result.kind) {
        case "transitioned":
            return {
                kind: "ok",
                label: `issue → ${result.to}`,
                detail: result.from ? `${result.projectTitle} (was: ${result.from})` : result.projectTitle,
            };
        case "noop-already":
            return {
                kind: "skip",
                label: "issue already In Progress",
                detail: result.projectTitle,
            };
        case "noop-protected":
            return {
                kind: "skip",
                label: `issue kept at ${result.current}`,
                detail: `${result.projectTitle} (status is protected)`,
            };
        case "skip-no-repo":
            return { kind: "skip", label: "no GitHub repo — skipping project update" };
        case "skip-no-issue":
            return { kind: "skip", label: "issue not found — skipping project update" };
        case "skip-no-project":
            return { kind: "skip", label: "issue not on any project — skipping project update" };
        case "skip-ambiguous":
            return {
                kind: "warn",
                label: "multiple matching projects — skipping",
                detail: `set .mintree/metadata.json project.url to one of: ${result.projects.join(", ")}`,
            };
        case "skip-no-status-field":
            return {
                kind: "skip",
                label: "no Status field on project — skipping",
                detail: result.projects.join(", "),
            };
        case "skip-no-in-progress-option":
            return {
                kind: "skip",
                label: "no In Progress option on Status field — skipping",
                detail: result.projects.join(", "),
            };
        case "error":
            return {
                kind: "warn",
                label: "project update failed",
                detail: result.hint ? `${result.message} — ${result.hint}` : result.message,
            };
    }
}

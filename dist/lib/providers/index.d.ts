/**
 * Factory + shared UI helpers for the issue providers. Callers ask for a
 * provider given the repo's metadata; the factory picks the implementation
 * based on `metadata.provider` (defaults to github for back-compat). All
 * other code talks to `IssueProvider` without caring which backend is in
 * use.
 */
import type { IssueProvider, TransitionResult } from "./types.js";
/**
 * Returns the IssueProvider for this repo. Reads metadata.provider — when
 * omitted (i.e. repos initialised before the provider field existed) we
 * default to github so the change is invisible to existing users.
 */
export declare function createProvider(repoRoot: string): IssueProvider;
/**
 * Maps a TransitionResult to a UI-renderable row (icon kind + label +
 * optional detail). Provider-agnostic — both providers produce the same
 * TransitionResult shape — so the dashboard and create command share this
 * single mapping.
 */
export declare function describeTransition(result: TransitionResult): {
    kind: "ok" | "skip" | "warn";
    label: string;
    detail?: string;
};
export type { IssueProvider, TransitionResult } from "./types.js";
export type { ProviderIssue, IssueProjectInfo, IssueId } from "./types.js";

import { type DashboardIssue } from "../lib/dashboard.js";
export declare const description = "Interactive dashboard listing open issues assigned to you with worktree + session state";
type RemoveTarget = {
    issue: DashboardIssue;
    branch: string | null;
    worktreePath: string;
    dirty: boolean;
    unregistered: boolean;
};
type RemoveOverlay = {
    kind: "remove";
    targets: RemoveTarget[];
    error: string | null;
    progress: RemoveProgress | null;
};
type RemoveProgress = {
    done: number;
    total: number;
    current: string;
    failed: number;
};
export declare function RemoveOverlayView({ overlay, maxListRows, }: {
    overlay: RemoveOverlay;
    maxListRows: number;
}): import("react/jsx-runtime").JSX.Element;
export declare function IssueListRow({ d, selected, identifierWidth, rowWidth, checkbox, }: {
    d: DashboardIssue;
    selected: boolean;
    identifierWidth: number;
    rowWidth: number;
    checkbox?: "on" | "off";
}): import("react/jsx-runtime").JSX.Element;
export default function Dashboard(): import("react/jsx-runtime").JSX.Element;
export {};

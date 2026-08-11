export declare const PACKAGE_NAME = "mintree";
export type UpdateResult = {
    ok: true;
    output: string;
} | {
    ok: false;
    message: string;
    hint?: string;
};
/**
 * Reinstalls `mintree@latest` globally via npm. Returns a discriminated result
 * so the command can render a precise message instead of dumping a raw stack.
 * The common failure — EACCES on a root-owned global prefix — gets a targeted
 * hint pointing at the usual fixes.
 */
export declare function installLatest(): Promise<UpdateResult>;

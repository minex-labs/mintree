/** Env var that turns the caffeinate off (`MINTREE_NO_CAFFEINATE=1`). */
export declare const NO_CAFFEINATE_ENV = "MINTREE_NO_CAFFEINATE";
/** True when mintree should keep the machine awake: macOS, not opted out. */
export declare function shouldCaffeinate(platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv): boolean;
/** argv for a caffeinate that holds an idle-sleep assertion while `pid` lives. */
export declare function buildCaffeinateArgs(pid: number): string[];
/**
 * Best-effort: spawns `caffeinate` tied to `pid`. Never throws — a missing
 * binary or a failed spawn just means the machine may sleep, which is no
 * reason to block launching Claude.
 */
export declare function caffeinateWhile(pid: number | undefined): void;

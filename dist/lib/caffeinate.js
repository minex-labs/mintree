// Keep the Mac awake for the whole life of a mintree-launched Claude session.
//
// Claude Code already runs `caffeinate -i -t 300` on its own, but only while a
// turn is in progress. Between turns — the session sitting idle, waiting for a
// reply that often comes from a phone through Remote Control — nothing holds
// the machine awake, so it can idle-sleep and the session stops being
// reachable. mintree closes that gap with a `caffeinate -i -w <claude pid>`
// bound to the Claude process: it lives exactly as long as Claude does and
// exits on its own when Claude exits, even if mintree itself dies first.
//
// `-i` prevents idle *system* sleep only. The display can still sleep and the
// screen can still lock — that doesn't stop running processes. Closing the lid
// on battery still sleeps the machine; no caffeinate flag prevents that.
import { spawn } from "child_process";
/** Env var that turns the caffeinate off (`MINTREE_NO_CAFFEINATE=1`). */
export const NO_CAFFEINATE_ENV = "MINTREE_NO_CAFFEINATE";
/** True when mintree should keep the machine awake: macOS, not opted out. */
export function shouldCaffeinate(platform = process.platform, env = process.env) {
    if (platform !== "darwin")
        return false;
    const optOut = env[NO_CAFFEINATE_ENV];
    return !optOut || optOut === "0" || optOut.toLowerCase() === "false";
}
/** argv for a caffeinate that holds an idle-sleep assertion while `pid` lives. */
export function buildCaffeinateArgs(pid) {
    return ["-i", "-w", String(pid)];
}
/**
 * Best-effort: spawns `caffeinate` tied to `pid`. Never throws — a missing
 * binary or a failed spawn just means the machine may sleep, which is no
 * reason to block launching Claude.
 */
export function caffeinateWhile(pid) {
    if (!pid || !shouldCaffeinate())
        return;
    try {
        const child = spawn("caffeinate", buildCaffeinateArgs(pid), { stdio: "ignore" });
        child.on("error", () => { });
        child.unref();
    }
    catch {
        // ignore
    }
}

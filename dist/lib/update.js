// Self-update: reinstall the globally-installed mintree from npm. The CLI is
// distributed via `npm i -g mintree`, so updating is just re-running that
// install for the `@latest` tag. We shell out to `npm` rather than reuse the
// registry probe in version.ts because npm owns the global prefix, perms, and
// bin-linking we can't replicate reliably here.
import { exec } from "child_process";
import { promisify } from "util";
const execAsync = promisify(exec);
// npm global installs can be slow on a cold cache; give them room before we
// give up. 2 minutes mirrors what a fresh `npm i -g` typically needs.
const INSTALL_TIMEOUT_MS = 120_000;
export const PACKAGE_NAME = "mintree";
/**
 * Reinstalls `mintree@latest` globally via npm. Returns a discriminated result
 * so the command can render a precise message instead of dumping a raw stack.
 * The common failure — EACCES on a root-owned global prefix — gets a targeted
 * hint pointing at the usual fixes.
 */
export async function installLatest() {
    try {
        const { stdout, stderr } = await execAsync(`npm install -g ${PACKAGE_NAME}@latest`, {
            timeout: INSTALL_TIMEOUT_MS,
        });
        return { ok: true, output: (stdout || stderr || "").trim() };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, message, hint: hintForError(message) };
    }
}
function hintForError(message) {
    const m = message.toLowerCase();
    if (m.includes("eacces") || m.includes("permission denied")) {
        return "npm couldn't write to its global prefix. Either fix the prefix ownership (npm docs: 'resolving EACCES permissions errors') or re-run with sudo.";
    }
    if (m.includes("command not found") || m.includes("not recognized")) {
        return "npm wasn't found on your PATH. Install Node.js (which bundles npm) and try again.";
    }
    if (m.includes("etimedout") || m.includes("network") || m.includes("enotfound")) {
        return "Looks like a network problem reaching the npm registry. Check your connection and retry.";
    }
    return undefined;
}

import { useEffect } from "react";
import { argument } from "pastel";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// At build time this file lives at dist/commands/helpers/shell-init.js — the
// shell templates ship at <pkg>/shell/. Three levels up from __dirname.
const shellDir = path.resolve(__dirname, "..", "..", "..", "shell");

export const description = "Output shell integration script (eval in your shell rc)";

export const args = z.tuple([
	z
		.enum(["zsh", "bash"])
		.default("zsh")
		.describe(
			argument({
				name: "shell",
				description: "Target shell: zsh (default) or bash",
			}),
		),
]);

type Props = {
	args: z.infer<typeof args>;
};

/**
 * Wraps the integration body in a bootstrap that:
 *  1. Computes a per-shell cache path under XDG_CACHE_HOME/mintree/.
 *  2. Writes the body verbatim to that cache file (using a heredoc so the
 *     body is parsed by the cache, not by this bootstrap).
 *  3. Sources the cache so this shell gets the integration immediately.
 *
 * The cache file starts with a self-validation guard: if the `mintree`
 * binary on $PATH is newer than the cache, it re-runs the bootstrap so the
 * cache regenerates after an update. Subsequent shells can skip the bootstrap
 * entirely — see the .rc one-liner in the comment header.
 */
function buildBootstrap(shell: "zsh" | "bash", body: string): string {
	const cachePath =
		shell === "zsh"
			? `\${MINTREE_CACHE_DIR:-\${XDG_CACHE_HOME:-$HOME/.cache}/mintree}/init-zsh.zsh`
			: `\${MINTREE_CACHE_DIR:-\${XDG_CACHE_HOME:-$HOME/.cache}/mintree}/init-bash.bash`;

	const mkdirParent =
		shell === "zsh" ? `mkdir -p "\${_mintree_cache:h}"` : `mkdir -p "$(dirname "$_mintree_cache")"`;

	// `${(%):-%x}` in zsh is the script path of the file being sourced. In
	// bash that's `${BASH_SOURCE[0]}`. We use it to compare against the
	// `mintree` binary's mtime (`-nt`) — when mintree is newer, the cache
	// is stale and we regenerate.
	const sourcePathExpansion = shell === "zsh" ? `\${(%):-%x}` : `\${BASH_SOURCE[0]}`;
	const commandLookup = shell === "zsh" ? `\${commands[mintree]:-}` : `$(command -v mintree)`;

	const headerComment =
		shell === "zsh"
			? `# mintree shell integration bootstrap (zsh) — self-caching
#
# Caches the integration body in \${XDG_CACHE_HOME:-~/.cache}/mintree/init-zsh.zsh
# on first run so subsequent shells can source it without spawning node.
# After upgrading mintree the cache self-invalidates by mtime.
#
# .zshrc one-liner with first-run fallback:
#   _SI=\${XDG_CACHE_HOME:-$HOME/.cache}/mintree/init-zsh.zsh
#   [[ -f $_SI ]] && source $_SI || eval "$(mintree helpers shell-init zsh)"`
			: `# mintree shell integration bootstrap (bash) — self-caching
#
# Caches the integration body in \${XDG_CACHE_HOME:-~/.cache}/mintree/init-bash.bash
# on first run so subsequent shells can source it without spawning node.
# After upgrading mintree the cache self-invalidates by mtime.
#
# .bashrc one-liner with first-run fallback:
#   _SI=\${XDG_CACHE_HOME:-$HOME/.cache}/mintree/init-bash.bash
#   [[ -f "$_SI" ]] && source "$_SI" || eval "$(mintree helpers shell-init bash)"`;

	// Trailing-newline-stripped body — we add our own newline structure.
	const trimmedBody = body.endsWith("\n") ? body.slice(0, -1) : body;

	return `${headerComment}

_mintree_cache="${cachePath}"
${mkdirParent}

# Single-quoted heredoc delimiter so $vars and \`commands\` in the body
# aren't expanded here — they're only evaluated when the cache file is
# sourced.
cat > "$_mintree_cache" <<'MINTREE_INIT_BODY_EOF__'
# AUTO-GENERATED CACHE — do not edit. Regenerate with:
#   eval "$(mintree helpers shell-init ${shell})"

# Self-validation: when the mintree binary is newer than this cache,
# re-run the bootstrap so the body refreshes, then return so the (now
# stale) definitions below aren't re-loaded into the shell.
if [[ ${commandLookup} -nt ${sourcePathExpansion} ]]; then
    eval "$(command mintree helpers shell-init ${shell})"
    return
fi

${trimmedBody}
MINTREE_INIT_BODY_EOF__

# Source the cache we just wrote so this shell gets the integration now.
source "$_mintree_cache"
unset _mintree_cache
`;
}

export default function ShellInit({ args }: Props) {
	const [shell] = args;

	useEffect(() => {
		const filePath = path.join(shellDir, `init.${shell}`);
		try {
			const body = fs.readFileSync(filePath, "utf-8");
			const bootstrap = buildBootstrap(shell, body);
			process.stdout.write(bootstrap);
			process.exit(0);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			process.stderr.write(`mintree: failed to read ${filePath}: ${message}\n`);
			process.exit(1);
		}
	}, [shell]);

	return null;
}

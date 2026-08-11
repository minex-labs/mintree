// Update check: ask the npm registry for the latest published version and
// compare it against what's running. Best-effort — any failure (offline,
// timeout, private registry) resolves to null and the dashboard simply
// doesn't show an update hint.

const REGISTRY_TIMEOUT_MS = 3000;

export async function getLatestVersion(pkg: string): Promise<string | null> {
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), REGISTRY_TIMEOUT_MS);
		const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`, {
			signal: controller.signal,
			headers: { accept: "application/json" },
		});
		clearTimeout(timer);
		if (!res.ok) return null;
		const data = (await res.json()) as { version?: unknown };
		return typeof data.version === "string" ? data.version : null;
	} catch {
		return null;
	}
}

// Returns true when `latest` is strictly newer than `current`. Both are
// expected as plain `major.minor.patch` strings; anything unparseable is
// treated as "not newer" so we never nag on a bad comparison.
export function isNewerVersion(current: string, latest: string): boolean {
	const parse = (v: string) =>
		v
			.trim()
			.split(".")
			.map((n) => parseInt(n, 10));
	const a = parse(current);
	const b = parse(latest);
	for (let i = 0; i < 3; i++) {
		const ca = a[i] ?? 0;
		const cb = b[i] ?? 0;
		if (Number.isNaN(ca) || Number.isNaN(cb)) return false;
		if (cb > ca) return true;
		if (cb < ca) return false;
	}
	return false;
}

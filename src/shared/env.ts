const cache = new Map<string, string>();

// Env values are trimmed on read. A trailing newline or carriage
// return from a paste or `fly secrets set VAR="$(cat file)"` silently
// corrupts HTTP headers that embed the value ("Bearer <key>\n" fails
// Bun's fetch header validation). Leading/trailing whitespace is
// never semantically meaningful for our API keys, URLs, or flags.

export function getEnv(key: string): string {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const raw = process.env[key];
  if (raw === undefined || raw === "") {
    throw new Error(`missing required env var: ${key}`);
  }
  const v = raw.trim();
  if (v === "") {
    throw new Error(`env var ${key} is whitespace-only`);
  }
  cache.set(key, v);
  return v;
}

export function getEnvOptional(key: string): string | undefined {
  const raw = process.env[key];
  if (raw === undefined) return undefined;
  const v = raw.trim();
  return v === "" ? undefined : v;
}

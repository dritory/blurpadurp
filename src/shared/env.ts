const cache = new Map<string, string>();

export function getEnv(key: string): string {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const v = process.env[key];
  if (v === undefined || v === "") {
    throw new Error(`missing required env var: ${key}`);
  }
  cache.set(key, v);
  return v;
}

export function getEnvOptional(key: string): string | undefined {
  return process.env[key] || undefined;
}

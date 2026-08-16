import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Glob } from "bun";
import { db } from "../../src/db/index.ts";

// Runtime config lives in the `config` table and is *set* by migrations,
// while the code that reads it carries its own fallback:
//
//   getConfigNumber("compose.auto_publish_hours", 24)
//
// That's a deliberate and reasonable split — it gives the knobs an audit
// trail and makes a prompt-version bump atomic with the schema change —
// but it leaves two things nothing checks.
//
// The first is a typo. `getConfigNumber("compose.auto_publish_hour", 24)`
// compiles, runs, and quietly returns the fallback forever; the operator
// changes the value at /admin/config and nothing happens. There is no
// error anywhere in that story.
//
// The second is disagreement. When a migration moves a default and the
// code fallback doesn't follow (or the reverse), the system's behaviour
// depends on whether a row happens to exist — and CLAUDE.md, which
// quotes these numbers extensively ("24h", "72h", "6 lifetime
// attempts"), starts describing neither.
//
// Both are cheap to catch against a migrated database, which CI already
// has for the integration job.
//
// Scope: the `getConfig*` helpers only. The scorer and composer read the
// whole config table through their own bespoke loaders with their own
// required-key validation (loadConfig in score.ts / compose.ts), which
// already fails loudly on a missing key — that's why they're not here.

const RUN = process.env.RUN_INTEGRATION === "1";

const HELPERS = ["getConfigNumber", "getConfigNumberOrNull", "getConfigBool"];

// config-store.ts declares the helpers; its own text isn't a call site.
const SKIP_FILES = new Set(["src/shared/config-store.ts"]);

interface CallSite {
  file: string;
  key: string;
  /** Source text of the fallback argument, or null when there is none. */
  fallbackExpr: string | null;
}

/**
 * Extract the argument list of a call starting at `open` (the index of
 * the "("), balancing parentheses so a nested call in the fallback
 * position doesn't truncate the match. Returns the top-level arguments.
 *
 * A regex can't do this: several call sites wrap the helper in
 * `(await getConfigNumber(...))` or span multiple lines.
 */
function readArgs(src: string, open: number): string[] | null {
  let depth = 0;
  let i = open;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) return null;

  const inner = src.slice(open + 1, i);
  const args: string[] = [];
  let current = "";
  let nest = 0;
  for (const ch of inner) {
    if (ch === "(" || ch === "[" || ch === "{") nest++;
    else if (ch === ")" || ch === "]" || ch === "}") nest--;
    if (ch === "," && nest === 0) {
      args.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "") args.push(current.trim());
  return args;
}

function findCallSites(file: string, src: string): CallSite[] {
  const sites: CallSite[] = [];
  for (const helper of HELPERS) {
    let from = 0;
    for (;;) {
      const at = src.indexOf(`${helper}(`, from);
      if (at === -1) break;
      from = at + helper.length;

      // Skip the declaration itself ("export async function getConfigX(").
      const before = src.slice(Math.max(0, at - 20), at);
      if (/function\s+$/.test(before)) continue;

      const args = readArgs(src, at + helper.length);
      if (args === null || args.length === 0) continue;
      const keyMatch = args[0]?.match(/^"([^"]+)"$/);
      if (!keyMatch?.[1]) continue; // computed key — not statically checkable

      sites.push({
        file,
        key: keyMatch[1],
        fallbackExpr: args[1] ?? null,
      });
    }
  }
  return sites;
}

/**
 * Resolve a fallback expression to a value. Literals directly; a bare
 * identifier by looking for a `const NAME = <literal>` in the same file
 * (several call sites name their default, e.g. DEFAULT_MAX_PASSES).
 * Anything else returns undefined and is skipped rather than guessed at.
 */
function resolveFallback(expr: string, src: string): number | boolean | undefined {
  const trimmed = expr.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);

  if (/^[A-Z_][A-Z0-9_]*$/.test(trimmed)) {
    const decl = src.match(
      new RegExp(`const\\s+${trimmed}\\s*(?::[^=]+)?=\\s*([^;]+);`),
    );
    const value = decl?.[1]?.trim();
    if (value === undefined) return undefined;
    if (value === "true") return true;
    if (value === "false") return false;
    if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  }
  return undefined;
}

function collectCallSites(): CallSite[] {
  const sites: CallSite[] = [];
  for (const file of new Glob("src/**/*.{ts,tsx}").scanSync(".")) {
    const path = file.split("\\").join("/");
    if (SKIP_FILES.has(path) || path.endsWith(".test.ts")) continue;
    sites.push(...findCallSites(path, readFileSync(path, "utf8")));
  }
  return sites;
}

describe.skipIf(!RUN)("config defaults (integration)", () => {
  const sites = collectCallSites();

  test("the scanner found the call sites", () => {
    // Guards the rest of the file: a refactor that renames the helpers
    // would otherwise leave every assertion below vacuously passing.
    expect(sites.length).toBeGreaterThan(5);
  });

  test("every key read by the code is set by a migration", async () => {
    const rows = await db.selectFrom("config").select("key").execute();
    const known = new Set(rows.map((r) => r.key));

    const missing = [
      ...new Set(
        sites.filter((s) => !known.has(s.key)).map((s) => `${s.key} (${s.file})`),
      ),
    ].sort();

    expect(
      missing,
      "config keys read in code but never inserted by a migration — these silently return their fallback forever, and editing them at /admin/config does nothing",
    ).toEqual([]);
  });

  test("code fallbacks agree with the migrated values", async () => {
    const rows = await db.selectFrom("config").select(["key", "value"]).execute();
    const values = new Map(rows.map((r) => [r.key, r.value]));

    const disagreements: string[] = [];
    for (const site of sites) {
      if (site.fallbackExpr === null) continue;
      const src = readFileSync(site.file, "utf8");
      const fallback = resolveFallback(site.fallbackExpr, src);
      if (fallback === undefined) continue; // not a literal — skipped, not guessed
      if (!values.has(site.key)) continue; // reported by the test above

      const stored = values.get(site.key);
      // The /admin/config editor round-trips values as text, which is
      // why getConfigBool accepts "true"/"false" — compare the same way.
      const normalise = (v: unknown) =>
        typeof v === "string" ? v : JSON.stringify(v);
      if (normalise(stored) !== normalise(fallback)) {
        disagreements.push(
          `${site.key}: code falls back to ${JSON.stringify(fallback)} but the migrations set ${JSON.stringify(stored)} (${site.file})`,
        );
      }
    }

    expect(
      [...new Set(disagreements)].sort(),
      "the fallback in code and the value in the database disagree — behaviour then depends on whether the row happens to exist, and the documented default is wrong in one place or the other",
    ).toEqual([]);
  });
});

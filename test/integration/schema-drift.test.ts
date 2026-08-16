import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { sql } from "kysely";
import { db } from "../../src/db/index.ts";

// `src/db/schema.ts` is hand-maintained ("keep in sync with migrations by
// hand"), which was fine at migration 010 and is not fine at 077. The drift
// is silent in the direction that matters: a migration adds or renames a
// column, the Kysely types don't know, and every query still type-checks
// while lying about what comes back.
//
// This test closes that by diffing the declared `Database` interface against
// `information_schema` on a database that has had all migrations applied.
// It lives in the integration suite because it needs that real database —
// which CI already stands up for the integration job, so this costs nothing
// beyond the file.
//
// It parses schema.ts as text rather than reaching for the TypeScript
// compiler API: the interface is written in one regular shape, and a
// ~60-line parser is a smaller dependency than tsc. If the file's shape ever
// gets more adventurous than `name: Type;`, the parser fails loudly (see the
// sanity check at the bottom) rather than silently matching nothing.

const RUN = process.env.RUN_INTEGRATION === "1";

const SCHEMA_PATH = "src/db/schema.ts";

// Tables that exist in the database but deliberately have no Kysely type.
// Empty on purpose — a new table should be typed, not excused. Adding an
// entry here is a decision worth making explicitly in review.
const UNTYPED_TABLES = new Set<string>([]);

// ---------------------------------------------------------------------------
// Parsing src/db/schema.ts
// ---------------------------------------------------------------------------

type ParsedColumn = {
  /** The select-side TS type, with Generated<>/unions/aliases resolved. */
  base: string;
  nullable: boolean;
  generated: boolean;
  raw: string;
};

/** Split a type union on top-level `|`, ignoring `|` inside angle brackets. */
function splitUnion(type: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of type) {
    if (ch === "<" || ch === "[") depth++;
    else if (ch === ">" || ch === "]") depth--;
    if (ch === "|" && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "") parts.push(current.trim());
  return parts;
}

/** Local aliases declared at the top of schema.ts. */
function expandAlias(type: string): string {
  if (type === "Id") return "Generated<number>";
  if (type === "Created") return "Generated<Date>";
  // Jsonb = ColumnType<unknown, string, string> — select side is `unknown`.
  if (type === "Jsonb") return "unknown";
  return type;
}

function unwrap(type: string, wrapper: string): string | null {
  const prefix = `${wrapper}<`;
  if (!type.startsWith(prefix) || !type.endsWith(">")) return null;
  return type.slice(prefix.length, -1).trim();
}

function normalizeType(raw: string): ParsedColumn {
  let type = expandAlias(raw.trim());
  let generated = false;

  const inner = unwrap(type, "Generated");
  if (inner !== null) {
    generated = true;
    type = expandAlias(inner);
  }

  let nullable = false;
  const members: string[] = [];
  for (const member of splitUnion(type)) {
    const expanded = expandAlias(member);
    if (expanded === "null") {
      nullable = true;
      continue;
    }
    members.push(expanded);
  }

  // `kind: "trigger" | "penalty" | "uncertainty"` — a union of string
  // literals is a text column with a narrowed type, not a distinct base type.
  const allLiterals =
    members.length > 0 &&
    members.every((m) => /^"[^"]*"$/.test(m) || /^'[^']*'$/.test(m));

  let base = allLiterals ? "string" : (members[0] ?? "unknown");

  // ColumnType<Select, Insert, Update> — only the select side describes what
  // a read produces, which is what a type lie would hurt.
  const columnType = unwrap(base, "ColumnType");
  if (columnType !== null) {
    base = splitUnion(columnType.split(",")[0] ?? "unknown")
      .filter((m) => m !== "null")[0]
      ?.trim() ?? "unknown";
    if (columnType.split(",")[0]?.includes("null")) nullable = true;
  }

  return { base, nullable, generated, raw: raw.trim() };
}

function parseSchemaFile(source: string): Map<string, Map<string, ParsedColumn>> {
  const tables = new Map<string, Map<string, ParsedColumn>>();
  const lines = source.split("\n");

  let inDatabase = false;
  let currentTable: string | null = null;

  for (const line of lines) {
    if (!inDatabase) {
      if (/^export interface Database\s*\{/.test(line)) inDatabase = true;
      continue;
    }
    // Closing brace of the interface itself, at column 0.
    if (/^\}/.test(line)) break;

    const stripped = line.replace(/\/\/.*$/, "").trimEnd();
    if (stripped.trim() === "") continue;

    if (currentTable === null) {
      const open = stripped.match(/^ {2}([a-z_][a-z0-9_]*)\s*:\s*\{$/);
      if (open?.[1]) {
        currentTable = open[1];
        tables.set(currentTable, new Map());
      }
      continue;
    }

    if (/^ {2}\};?$/.test(stripped)) {
      currentTable = null;
      continue;
    }

    const column = stripped.match(/^ {4}([a-z_][a-z0-9_]*)\s*:\s*(.+);$/);
    if (column?.[1] && column[2]) {
      tables.get(currentTable)?.set(column[1], normalizeType(column[2]));
    }
  }

  return tables;
}

// ---------------------------------------------------------------------------
// What the database actually has
// ---------------------------------------------------------------------------

type DbColumn = {
  udt: string;
  nullable: boolean;
  hasDefault: boolean;
};

// pg type → the TS select type Kysely + node-postgres actually produce.
// `numeric` is deliberately `string`: node-postgres does not parse numerics
// into JS numbers (they don't round-trip), so typing one as `number` is a
// lie that survives compilation.
const PG_TO_TS: Record<string, string[]> = {
  text: ["string"],
  varchar: ["string"],
  bpchar: ["string"],
  int2: ["number"],
  int4: ["number"],
  int8: ["number"],
  float4: ["number"],
  float8: ["number"],
  numeric: ["string"],
  bool: ["boolean"],
  timestamptz: ["Date"],
  timestamp: ["Date"],
  date: ["Date"],
  time: ["string"],
  timetz: ["string"],
  jsonb: ["unknown"],
  json: ["unknown"],
  halfvec: ["string"],
  vector: ["string"],
  _text: ["string[]"],
  _int2: ["number[]"],
  _int4: ["number[]"],
  _int8: ["number[]"],
};

async function loadDbSchema(): Promise<Map<string, Map<string, DbColumn>>> {
  const rows = await sql<{
    table_name: string;
    column_name: string;
    udt_name: string;
    is_nullable: string;
    has_default: boolean;
  }>`
    SELECT c.table_name,
           c.column_name,
           c.udt_name,
           c.is_nullable,
           (c.column_default IS NOT NULL OR c.is_identity = 'YES') AS has_default
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public'
      AND t.table_type = 'BASE TABLE'
    ORDER BY c.table_name, c.ordinal_position
  `.execute(db);

  const tables = new Map<string, Map<string, DbColumn>>();
  for (const row of rows.rows) {
    if (!tables.has(row.table_name)) tables.set(row.table_name, new Map());
    tables.get(row.table_name)?.set(row.column_name, {
      udt: row.udt_name,
      nullable: row.is_nullable === "YES",
      hasDefault: row.has_default,
    });
  }
  return tables;
}

// ---------------------------------------------------------------------------

describe.skipIf(!RUN)("db/schema.ts drift (integration)", () => {
  const declared = parseSchemaFile(readFileSync(SCHEMA_PATH, "utf8"));

  test("the parser actually found the interface", () => {
    // Guards the whole file: if schema.ts is reformatted into a shape the
    // parser doesn't recognise, every other assertion here would vacuously
    // pass on an empty map. Fail loudly instead.
    expect(declared.size).toBeGreaterThan(10);
    for (const [table, columns] of declared) {
      expect(columns.size, `${table} parsed with no columns`).toBeGreaterThan(0);
    }
  });

  test("every table in the database is declared, and vice versa", async () => {
    const actual = await loadDbSchema();

    const missing = [...actual.keys()]
      .filter((t) => !UNTYPED_TABLES.has(t) && !declared.has(t))
      .sort();
    const extra = [...declared.keys()].filter((t) => !actual.has(t)).sort();

    expect(
      missing,
      `tables in the database with no type in ${SCHEMA_PATH} — a migration added them and the types never caught up`,
    ).toEqual([]);
    expect(
      extra,
      `tables typed in ${SCHEMA_PATH} that do not exist — a migration dropped or renamed them`,
    ).toEqual([]);
  });

  test("every column matches in name, nullability and type", async () => {
    const actual = await loadDbSchema();
    const problems: string[] = [];

    for (const [table, actualColumns] of actual) {
      const declaredColumns = declared.get(table);
      if (!declaredColumns) continue; // reported by the table test above

      for (const [name, col] of actualColumns) {
        const decl = declaredColumns.get(name);
        if (!decl) {
          problems.push(`${table}.${name}: in the database, missing from ${SCHEMA_PATH}`);
          continue;
        }

        if (decl.nullable !== col.nullable) {
          problems.push(
            col.nullable
              ? `${table}.${name}: database is NULLABLE but the type is \`${decl.raw}\` — reads can hand back null where the type promises a value`
              : `${table}.${name}: database is NOT NULL but the type is \`${decl.raw}\` — an insert of null type-checks and fails at runtime`,
          );
        }

        const allowed = PG_TO_TS[col.udt];
        if (!allowed) {
          problems.push(
            `${table}.${name}: pg type "${col.udt}" has no mapping in PG_TO_TS — add one`,
          );
        } else if (decl.base !== "unknown" && !allowed.includes(decl.base)) {
          problems.push(
            `${table}.${name}: database is ${col.udt}, expected TS ${allowed.join(" | ")}, got \`${decl.raw}\``,
          );
        }

        // The dangerous direction only. `Generated<T>` makes a column
        // optional on insert; if the database has no default and the column
        // is NOT NULL, that omission is a runtime constraint violation.
        // The reverse (a defaulted column typed as required) merely means
        // you always pass it, which is safe.
        if (decl.generated && !col.hasDefault && !col.nullable) {
          problems.push(
            `${table}.${name}: typed \`${decl.raw}\` but the column is NOT NULL with no default — an insert that omits it will fail`,
          );
        }
      }

      for (const name of declaredColumns.keys()) {
        if (!actualColumns.has(name)) {
          problems.push(`${table}.${name}: typed in ${SCHEMA_PATH}, not in the database`);
        }
      }
    }

    expect(problems.sort()).toEqual([]);
  });
});

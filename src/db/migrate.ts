import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "kysely";
import { db } from "./index.ts";

const MIGRATIONS_DIR = "migrations";

export async function runMigrations(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migration (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const appliedRows = await db
    .selectFrom("schema_migration")
    .select("name")
    .execute();
  const applied = new Set(appliedRows.map((r) => r.name));

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`skip ${file}`);
      continue;
    }
    const text = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    console.log(`applying ${file}...`);
    await db.transaction().execute(async (trx) => {
      await sql.raw(text).execute(trx);
      await trx
        .insertInto("schema_migration")
        .values({ name: file })
        .execute();
    });
  }
  console.log("migrations complete");
}

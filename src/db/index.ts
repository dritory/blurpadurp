import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { getEnv } from "../shared/env.ts";
import type { Database } from "./schema.ts";

const pool = new pg.Pool({ connectionString: getEnv("DATABASE_URL") });

export const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool }),
});

export async function closeDb(): Promise<void> {
  await db.destroy();
}

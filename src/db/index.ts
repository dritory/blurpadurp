import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { getEnv } from "../shared/env.ts";
import type { Database } from "./schema.ts";

// Pin the TLS mode explicitly. `pg-connection-string` currently treats
// sslmode=prefer|require|verify-ca as aliases for verify-full, but warns
// (loudly, with a stack trace) that its next major will adopt weaker
// libpq semantics for them — which would silently change the Neon
// handshake. Rewriting the alias to verify-full preserves exactly
// today's behavior (Neon presents valid public certs, so full
// verification already succeeds) while removing the deprecation warning
// and surviving the pg v9 upgrade. See runbook #13.
function pinSslMode(connectionString: string): string {
  return connectionString.replace(
    /([?&]sslmode=)(prefer|require|verify-ca)\b/i,
    "$1verify-full",
  );
}

const pool = new pg.Pool({
  connectionString: pinSslMode(getEnv("DATABASE_URL")),
});

export const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool }),
});

export async function closeDb(): Promise<void> {
  await db.destroy();
}

// Test bootstrap (loaded via bunfig.toml `[test] preload`).
//
// Several modules construct the Postgres pool at import time
// (src/db/index.ts does `new pg.Pool({ connectionString: getEnv(...) })`),
// which throws if DATABASE_URL is unset. The pool is lazy — it never opens
// a socket until a query runs — so a dummy URL lets unit tests import those
// modules and exercise their *pure* functions without a live database.
// Tests that need real DB behavior belong in a separate integration suite
// with a Postgres service; those are not run here.
process.env.DATABASE_URL ??=
  "postgres://test:test@127.0.0.1:5432/blurpadurp_test";

// Likewise, some AI-stage modules read their provider API key at import
// time. Unit tests never make a network call; a dummy keeps the import from
// throwing.
process.env.ANTHROPIC_API_KEY ??= "test-anthropic-key";

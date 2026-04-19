// Hono app: public archive, subscription endpoints, preference pages.
// Stub — just a health check and a placeholder landing.

import { Hono } from "hono";

export const app = new Hono();

app.get("/", (c) => c.text("blurpadurp: coming soon"));
app.get("/health", (c) => c.json({ ok: true }));

// Run directly: `bun run src/api/index.ts`
if (import.meta.main) {
  const port = Number(process.env.PORT ?? 3000);
  console.log(`listening on http://localhost:${port}`);
  Bun.serve({ port, fetch: app.fetch });
}

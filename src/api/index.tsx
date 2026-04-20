// Hono app: public archive, subscription endpoints, preference pages.
// No accounts — subscription is the identity. All routes are public.

import { Hono } from "hono";
import { z } from "zod";

import { db } from "../db/index.ts";
import { About } from "../views/about.tsx";
import { Archive, type ArchiveEntry } from "../views/archive.tsx";
import { Home, type Flash } from "../views/home.tsx";
import { IssuePage, type IssueView } from "../views/issue.tsx";

export const app = new Hono();

app.get("/health", (c) => c.json({ ok: true }));

app.get("/", async (c) => {
  const latest = await loadLatestIssue();
  const flash = parseFlash(c.req.query("subscribed"), c.req.query("error"));
  return c.html(<Home latest={latest} flash={flash} />);
});

app.get("/archive", async (c) => {
  const issues = await loadArchive();
  return c.html(<Archive issues={issues} />);
});

app.get("/issue/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id) || id <= 0) return c.notFound();
  const issue = await loadIssue(id);
  if (issue === null) return c.notFound();
  return c.html(<IssuePage issue={issue} />);
});

app.get("/about", (c) => c.html(<About />));

const SubscribeSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
});

app.post("/subscribe", async (c) => {
  const body = await c.req.parseBody();
  // Honeypot: bots fill every field; humans leave this hidden one empty.
  // Silently redirect as if it succeeded — no signal to the bot.
  if (typeof body.company === "string" && body.company.length > 0) {
    return c.redirect("/?subscribed=1", 303);
  }
  const parsed = SubscribeSchema.safeParse({ email: body.email });
  if (!parsed.success) {
    return c.redirect("/?error=invalid_email", 303);
  }
  await db
    .insertInto("email_subscription")
    .values({ email: parsed.data.email })
    .onConflict((oc) => oc.column("email").doNothing())
    .execute();
  return c.redirect("/?subscribed=1", 303);
});

// --- data loaders ---

async function loadLatestIssue(): Promise<IssueView | null> {
  const row = await db
    .selectFrom("issue")
    .select(["id", "published_at", "is_event_driven", "composed_html"])
    .orderBy("published_at", "desc")
    .limit(1)
    .executeTakeFirst();
  if (!row) return null;
  return {
    id: Number(row.id),
    publishedAt: row.published_at,
    isEventDriven: row.is_event_driven,
    html: row.composed_html,
  };
}

async function loadIssue(id: number): Promise<IssueView | null> {
  const row = await db
    .selectFrom("issue")
    .select(["id", "published_at", "is_event_driven", "composed_html"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) return null;
  return {
    id: Number(row.id),
    publishedAt: row.published_at,
    isEventDriven: row.is_event_driven,
    html: row.composed_html,
  };
}

async function loadArchive(): Promise<ArchiveEntry[]> {
  const rows = await db
    .selectFrom("issue")
    .select(["id", "published_at", "is_event_driven"])
    .orderBy("published_at", "desc")
    .execute();
  return rows.map((r) => ({
    id: Number(r.id),
    publishedAt: r.published_at,
    isEventDriven: r.is_event_driven,
  }));
}

function parseFlash(
  subscribed: string | undefined,
  error: string | undefined,
): Flash {
  if (subscribed) {
    return {
      kind: "ok",
      msg: "Subscribed. You'll get the next issue when the gate fires.",
    };
  }
  if (error === "invalid_email") {
    return { kind: "error", msg: "That email didn't parse. Try again." };
  }
  return null;
}

// Run directly: `bun run src/api/index.ts`
if (import.meta.main) {
  const port = Number(process.env.PORT ?? 3000);
  console.log(`listening on http://localhost:${port}`);
  Bun.serve({ port, fetch: app.fetch });
}

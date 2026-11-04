import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "kysely";
import { db } from "../../src/db/index.ts";
import {
  drainConfirmationQueue,
  loadConfirmationQueueFacts,
  queueConfirmation,
  sendConfirmation,
} from "../../src/shared/confirmation.ts";

const RUN = process.env.RUN_INTEGRATION === "1";

// The signup send cap used to DROP confirmations on a trip (mig 079's
// header has the story). Now it queues them and the dispatch stage
// drains the queue, so the properties worth pinning are the ones that
// decide who gets a mail: FIFO within a batch, expiry past max age,
// and never to a row that confirmed or unsubscribed while waiting.
//
// The mailer logs-and-succeeds with no RESEND_API_KEY, so a "send" here
// is the row bookkeeping, which is exactly what the drain is for.

describe.skipIf(!RUN)("confirmation queue (integration)", () => {
  // sendConfirmation mints a signed /confirm link, and the signer reads
  // its secret from the environment at call time. Same convention as
  // tokens.test.ts: the test owns its own prerequisite rather than
  // leaning on CI to export one.
  beforeAll(() => {
    process.env.BLURPADURP_TOKEN_SECRET ??= "itest-secret-do-not-use-in-prod";
  });

  const PREFIX = "itest-cq-";
  const NOW = new Date("2026-11-04T12:00:00Z");
  const HOUR = 3_600_000;

  const clear = async () => {
    await sql`DELETE FROM email_subscription WHERE email LIKE ${`${PREFIX}%`}`.execute(db);
  };
  beforeEach(clear);
  afterEach(clear);

  async function sub(
    name: string,
    over: {
      queuedAt?: Date | null;
      confirmedAt?: Date | null;
      unsubscribedAt?: Date | null;
    } = {},
  ): Promise<number> {
    const row = await db
      .insertInto("email_subscription")
      .values({
        email: `${PREFIX}${name}@example.test`,
        confirmation_queued_at: over.queuedAt ?? null,
        confirmed_at: over.confirmedAt ?? null,
        unsubscribed_at: over.unsubscribedAt ?? null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return Number(row.id);
  }

  async function state(id: number) {
    return db
      .selectFrom("email_subscription")
      .select(["confirmation_queued_at", "last_confirmation_sent_at"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
  }

  test("queueConfirmation keeps the first queue time on a resubmit", async () => {
    const id = await sub("a");
    await queueConfirmation(id);
    const first = (await state(id)).confirmation_queued_at;
    expect(first).not.toBeNull();
    await queueConfirmation(id);
    expect((await state(id)).confirmation_queued_at?.getTime()).toBe(first?.getTime());
  });

  test("sendConfirmation stamps the send and clears the queue mark", async () => {
    const id = await sub("b", { queuedAt: NOW });
    await sendConfirmation({ id, email: `${PREFIX}b@example.test`, locale: "en" });
    const s = await state(id);
    expect(s.confirmation_queued_at).toBeNull();
    expect(s.last_confirmation_sent_at).not.toBeNull();
  });

  test("drain sends oldest first, bounded by the batch, and reports the rest", async () => {
    const old = await sub("old", { queuedAt: new Date(NOW.getTime() - 2 * HOUR) });
    const mid = await sub("mid", { queuedAt: new Date(NOW.getTime() - HOUR) });
    const young = await sub("young", { queuedAt: NOW });

    const r = await drainConfirmationQueue({ now: NOW, batch: 2, maxAgeMs: 24 * HOUR });
    expect(r).toEqual({ sent: 2, expired: 0, remaining: 1 });
    expect((await state(old)).last_confirmation_sent_at).not.toBeNull();
    expect((await state(mid)).last_confirmation_sent_at).not.toBeNull();
    expect((await state(young)).last_confirmation_sent_at).toBeNull();
    expect((await state(young)).confirmation_queued_at).not.toBeNull();

    const facts = await loadConfirmationQueueFacts();
    expect(facts.depth).toBe(1);
    expect(facts.oldestQueuedAt?.getTime()).toBe(NOW.getTime());
  });

  test("drain expires stale, confirmed and unsubscribed rows without sending", async () => {
    const stale = await sub("stale", { queuedAt: new Date(NOW.getTime() - 30 * HOUR) });
    const confirmed = await sub("confirmed", { queuedAt: NOW, confirmedAt: NOW });
    const gone = await sub("gone", { queuedAt: NOW, unsubscribedAt: NOW });
    const live = await sub("live", { queuedAt: NOW });

    const r = await drainConfirmationQueue({ now: NOW, batch: 10, maxAgeMs: 24 * HOUR });
    expect(r).toEqual({ sent: 1, expired: 3, remaining: 0 });
    for (const id of [stale, confirmed, gone]) {
      const s = await state(id);
      expect(s.confirmation_queued_at).toBeNull();
      expect(s.last_confirmation_sent_at).toBeNull();
    }
    expect((await state(live)).last_confirmation_sent_at).not.toBeNull();
  });

  test("expiry does not eat the batch", async () => {
    // Expired rows in front of live ones must not starve the live ones.
    for (let i = 0; i < 5; i++) {
      await sub(`stale${i}`, { queuedAt: new Date(NOW.getTime() - 30 * HOUR) });
    }
    const live = await sub("live", { queuedAt: NOW });
    const r = await drainConfirmationQueue({ now: NOW, batch: 1, maxAgeMs: 24 * HOUR });
    expect(r).toEqual({ sent: 1, expired: 5, remaining: 0 });
    expect((await state(live)).last_confirmation_sent_at).not.toBeNull();
  });
});

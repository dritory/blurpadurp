// Thin Resend wrapper for transactional sends (confirmation, weekly
// brief). When RESEND_API_KEY is unset, the mailer logs the call and
// returns success — keeps local dev working without spending credits or
// sending real mail to a test inbox.
//
// Bounce classification is intentionally shallow: the Resend SDK's
// send-time errors are mostly your-API-call-is-wrong types, not real
// delivery signals. Asynchronous hard/soft bounces arrive via webhooks
// (out of scope for v0.1 per docs/dispatch.md). Here we only split
// transient (retry next sweep) from permanent (don't retry) on the
// immediate send path.

import { Resend } from "resend";
import { getEnvOptional } from "./env.ts";

const FROM_DEFAULT = "brief@blurpadurp.com";

export interface MailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
}

export type BounceKind = "transient" | "permanent" | "unknown";

export interface MailResult {
  ok: boolean;
  id: string | null;
  error: string | null;
  bounceKind?: BounceKind;
  noop?: boolean;
}

let client: Resend | null = null;

function getClient(apiKey: string): Resend {
  if (client === null) client = new Resend(apiKey);
  return client;
}

export async function sendMail(input: MailInput): Promise<MailResult> {
  const apiKey = getEnvOptional("RESEND_API_KEY");
  const from = getEnvOptional("FROM_EMAIL") ?? FROM_DEFAULT;

  if (apiKey === undefined || apiKey.length === 0) {
    console.log(
      `[mailer] NOOP → ${input.to} :: ${input.subject} (${input.text.length} chars text, ${input.html.length} html)`,
    );
    return { ok: true, id: null, error: null, noop: true };
  }

  try {
    const resp = await getClient(apiKey).emails.send({
      from,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
      headers: input.headers,
    });
    if (resp.error) {
      const name = resp.error.name ?? "";
      const msg = resp.error.message ?? "unknown error";
      // Resend validation errors (bad to/from, invalid format) are
      // permanent for this particular call; rate-limit is transient.
      const bounceKind: BounceKind = /rate.?limit/i.test(name)
        ? "transient"
        : /invalid|validation/i.test(name)
          ? "permanent"
          : "unknown";
      return { ok: false, id: null, error: `${name}: ${msg}`, bounceKind };
    }
    return { ok: true, id: resp.data?.id ?? null, error: null };
  } catch (e) {
    // Network or SDK crashes — always transient.
    return {
      ok: false,
      id: null,
      error: e instanceof Error ? e.message : String(e),
      bounceKind: "transient",
    };
  }
}

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
// Display name on the From header. Without one, every inbox and
// push notification shows the bare local part ("brief") — the address
// identifies the sender to a mail server, the display name identifies
// it to the reader. Overridable via FROM_NAME.
const FROM_NAME_DEFAULT = "Blurpadurp";

// Characters allowed in an unquoted RFC 5322 display name (atext plus
// space). Anything else — comma, period, colon, parens, quotes — has
// to be inside a quoted-string or the header is malformed.
const UNQUOTED_DISPLAY_NAME = /^[A-Za-z0-9 !#$%&'*+\-/=?^_`{|}~]+$/;

/** Build the From header from an address + optional display name.
 *
 *  Three shapes, in precedence order:
 *  - FROM_EMAIL already in mailbox form ("Name <addr>") → used verbatim;
 *    the operator has said exactly what they want.
 *  - address + name → `Name <addr>`, name quoted when it needs it.
 *  - address alone (name blank after sanitising) → bare address.
 *
 *  CR/LF are stripped from the name rather than escaped: a newline in a
 *  header value is header injection, and there is no legitimate name
 *  that needs one.
 */
export function formatFrom(address: string, name: string | undefined): string {
  if (address.includes("<")) return address;
  const clean = (name ?? "").replace(/[\r\n]+/g, " ").trim();
  if (clean === "") return address;
  const display = UNQUOTED_DISPLAY_NAME.test(clean)
    ? clean
    : `"${clean.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
  return `${display} <${address}>`;
}

/** Resolved From header for this process, from env + defaults. */
export function resolveFrom(): string {
  return formatFrom(
    getEnvOptional("FROM_EMAIL") ?? FROM_DEFAULT,
    getEnvOptional("FROM_NAME") ?? FROM_NAME_DEFAULT,
  );
}

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
  const from = resolveFrom();

  if (apiKey === undefined || apiKey.length === 0) {
    console.log(
      `[mailer] NOOP → ${input.to} :: ${input.subject} (from ${from}, ${input.text.length} chars text, ${input.html.length} html)`,
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

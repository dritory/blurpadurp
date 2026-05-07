// Admin notifications. Thin wrapper over sendMail that targets the
// ADMIN_EMAIL env recipient. When ADMIN_EMAIL is unset the call is a
// no-op (but still logs) — keeps local dev quiet without sprinkling
// env checks at every call site. All failures are swallowed; a notify
// call must never break the pipeline path that triggered it.
//
// Process-level dedup: passing a `dedupeKey` plus a `cooldownMs` will
// suppress repeat notifications for that key within the window. Useful
// for budget-exhaustion alerts, where the scorer would otherwise fire
// one mail per failed story.

import { getEnvOptional } from "./env.ts";
import { sendMail } from "./mailer.ts";

export interface AdminNotifyInput {
  subject: string;
  html: string;
  text: string;
  dedupeKey?: string;
  cooldownMs?: number;
}

const lastSentByKey = new Map<string, number>();
const DEFAULT_COOLDOWN_MS = 6 * 3600_000;

export async function notifyAdmin(input: AdminNotifyInput): Promise<void> {
  const to = getEnvOptional("ADMIN_EMAIL");
  if (to === undefined) {
    console.log(`[admin-notify] ADMIN_EMAIL unset — skipping: ${input.subject}`);
    return;
  }

  if (input.dedupeKey !== undefined) {
    const cooldown = input.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    const last = lastSentByKey.get(input.dedupeKey);
    if (last !== undefined && Date.now() - last < cooldown) {
      console.log(
        `[admin-notify] dedup ${input.dedupeKey} — suppressing: ${input.subject}`,
      );
      return;
    }
    lastSentByKey.set(input.dedupeKey, Date.now());
  }

  try {
    const res = await sendMail({
      to,
      subject: input.subject,
      html: input.html,
      text: input.text,
    });
    if (!res.ok) {
      console.error(
        `[admin-notify] send failed for "${input.subject}": ${res.error}`,
      );
    }
  } catch (e) {
    console.error(
      `[admin-notify] threw for "${input.subject}":`,
      e instanceof Error ? e.message : e,
    );
  }
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderAdminNotice(opts: {
  heading: string;
  bodyLines: string[];
  ctaLabel?: string;
  ctaUrl?: string;
}): { html: string; text: string } {
  const paras = opts.bodyLines.map((l) => `<p>${esc(l)}</p>`).join("\n");
  const cta =
    opts.ctaLabel !== undefined && opts.ctaUrl !== undefined
      ? `<p><a href="${esc(opts.ctaUrl)}">${esc(opts.ctaLabel)} →</a></p>`
      : "";
  const html = `<!DOCTYPE html><html><body style="font-family: -apple-system, Segoe UI, sans-serif; color:#1a1a1a; max-width: 640px; margin: 0 auto; padding: 24px;">
<h2 style="font-size: 18px; margin: 0 0 12px;">${esc(opts.heading)}</h2>
${paras}
${cta}
</body></html>`;
  const text = [
    opts.heading,
    "",
    ...opts.bodyLines,
    ...(opts.ctaUrl !== undefined
      ? ["", `${opts.ctaLabel ?? "Open"}: ${opts.ctaUrl}`]
      : []),
  ].join("\n");
  return { html, text };
}

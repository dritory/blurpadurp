// Email templates — the weekly brief + confirmation. Inline <style>
// blocks in <head>; most modern clients honour them, Outlook's
// quirks we accept. No external stylesheets (blocked by email clients)
// and no Google Fonts reference (Lora won't render — fallback to
// Georgia, which ships everywhere).
//
// The brief template wraps whatever composed_html the composer emitted
// (<h2>, <p>, <a>, <strong>, <em>, <span class="shrug-tag">,
// <span class="cite">) and adds header, issue title, footer.
//
// The wrapper is localized (mig 076); the composed body inside it is
// not. That asymmetry is deliberate and documented in shared/i18n.ts.

import {
  DATE_LOCALE,
  DEFAULT_LOCALE,
  HTML_LANG,
  fill,
  type Locale,
  localizePath,
  t,
} from "../shared/i18n.ts";

export interface BriefEmailCtx {
  brandUrl: string; // e.g. https://blurpadurp.com — no trailing slash
  issueUrl: string; // deep link to the published issue page
  unsubscribeUrl: string;
  manageUrl: string;
  title: string | null;
  date: Date;
  issueHtml: string;
  issueMarkdown: string;
  // Subscriber's language (email_subscription.locale, mig 076). Wraps
  // the brief in their chrome — the BODY is still the composer's
  // English prose, which is why the language of the frame is the only
  // thing this changes.
  locale?: Locale;
}

export interface ConfirmEmailCtx {
  brandUrl: string;
  confirmUrl: string;
  locale?: Locale;
}

export interface DraftReviewEmailCtx {
  brandUrl: string;
  previewUrl: string; // signed /draft/:id?token=… reviewer link
  title: string | null;
  date: Date;
}

export interface Rendered {
  subject: string;
  html: string;
  text: string;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function hostOf(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
}

function fmtDate(d: Date, locale: Locale = DEFAULT_LOCALE): string {
  return d.toLocaleDateString(DATE_LOCALE[locale], {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

const SANS =
  '-apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif';
const SERIF = 'Georgia, Charter, "Iowan Old Style", "Palatino Linotype", serif';

// Inline style block — strict subset that survives Gmail/Apple Mail. No
// CSS variables (Outlook rejects them); colors hard-coded to match the
// public site's baked-in palette.
const EMAIL_CSS = `
  body { margin: 0; padding: 0; background: #faf8f3; color: #1a1a1a; }
  .wrap { max-width: 640px; margin: 0 auto; padding: 28px 20px 40px; background: #faf8f3; font-family: ${SERIF}; font-size: 17px; line-height: 1.55; }
  .brand { font-family: ${SANS}; font-size: 18px; font-weight: 700; letter-spacing: -0.005em; margin: 0; }
  .meta { font-family: ${SANS}; font-size: 13px; color: #6b6b6b; margin: 4px 0 10px; }
  .title { font-family: ${SERIF}; font-size: 30px; font-weight: 700; letter-spacing: -0.02em; color: #1a1a1a; margin: 6px 0 28px; line-height: 1.1; }
  h2 { font-family: ${SANS}; font-size: 18px; font-weight: 600; margin: 32px 0 12px; color: #1a1a1a; }
  p { margin: 0 0 16px; }
  a { color: #5a4a36; text-underline-offset: 2px; }
  p strong:first-child { font-family: ${SANS}; font-weight: 600; }
  p > a { font-size: 0.84em; color: #6b6b6b; }
  .cite { font-size: 0.78em; color: #6b6b6b; white-space: nowrap; margin-left: 4px; }
  .cite a { color: #6b6b6b; }
  .shrug-tag { font-family: ${SANS}; font-size: 11px; color: #6b6b6b; text-transform: uppercase; letter-spacing: 0.06em; }
  .footer { margin-top: 48px; padding-top: 18px; border-top: 1px solid #dcd7cc; color: #6b6b6b; font-size: 12px; font-family: ${SANS}; line-height: 1.5; }
  .footer p { margin: 0 0 6px; }
  .footer a { color: #6b6b6b; }
  .cta-btn { display: inline-block; margin: 18px 0; padding: 12px 22px; background: #1a1a1a; color: #faf8f3; text-decoration: none; font-family: ${SANS}; font-weight: 600; font-size: 15px; }
`;

function docShell(
  subject: string,
  body: string,
  locale: Locale = DEFAULT_LOCALE,
): string {
  return `<!DOCTYPE html>
<html lang="${HTML_LANG[locale]}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(subject)}</title>
<style>${EMAIL_CSS}</style>
</head>
<body>
<div class="wrap">
${body}
</div>
</body>
</html>`;
}

export function renderBriefEmail(ctx: BriefEmailCtx): Rendered {
  const locale = ctx.locale ?? DEFAULT_LOCALE;
  const e = t(locale).email;
  const dateStr = fmtDate(ctx.date, locale);
  const subject =
    ctx.title !== null
      ? ctx.title
      : fill(e.briefSubjectFallback, { date: dateStr });
  const titleHtml =
    ctx.title !== null ? `<h1 class="title">${esc(ctx.title)}</h1>` : "";
  const privacyUrl = `${ctx.brandUrl}${localizePath(locale, "/privacy")}`;
  const brandHref = `${ctx.brandUrl}${localizePath(locale, "/")}`;
  const whyHtml = fill(e.briefWhyHtml, {
    link: `<a href="${esc(brandHref)}">${esc(hostOf(ctx.brandUrl))}</a>`,
  });
  const body = `
<p class="brand">Blurpadurp</p>
<p class="meta">${esc(dateStr)}</p>
${titleHtml}
${ctx.issueHtml}
<div class="footer">
  <p>${whyHtml}</p>
  <p><a href="${esc(ctx.unsubscribeUrl)}">${esc(e.unsubscribe)}</a> · <a href="${esc(ctx.manageUrl)}">${esc(e.preferences)}</a> · <a href="${esc(ctx.issueUrl)}">${esc(e.readOnWeb)}</a> · <a href="${esc(privacyUrl)}">${esc(e.privacy)}</a></p>
</div>`;
  const html = docShell(subject, body, locale);
  const text = [
    "BLURPADURP",
    dateStr,
    ctx.title !== null ? `\n${ctx.title}` : "",
    "",
    ctx.issueMarkdown.trim(),
    "",
    "---",
    fill(e.briefWhyText, { host: hostOf(ctx.brandUrl) }),
    `${e.readOnWeb}: ${ctx.issueUrl}`,
    `${e.preferences}: ${ctx.manageUrl}`,
    `${e.unsubscribe}: ${ctx.unsubscribeUrl}`,
    "",
  ]
    .filter((s) => s !== null && s !== undefined)
    .join("\n");
  return { subject, html, text };
}

// Sent to reviewers when compose persists a new draft — before it
// ships. Deliberately light: no issue body, just a nudge to the
// private preview page where they can read it and leave notes. The
// published brief (renderBriefEmail) arrives later, once it goes out.
export function renderDraftReviewEmail(ctx: DraftReviewEmailCtx): Rendered {
  const dateStr = fmtDate(ctx.date);
  const subject =
    ctx.title !== null
      ? `Draft for review: ${ctx.title}`
      : `A Blurpadurp draft is ready for review`;
  const titleHtml =
    ctx.title !== null ? `<h1 class="title">${esc(ctx.title)}</h1>` : "";
  const body = `
<p class="brand">Blurpadurp</p>
<p class="meta">Draft · ${esc(dateStr)}</p>
${titleHtml}
<p>
  A new issue is drafted and waiting for your read before it goes out.
  Open the private preview to read it and leave notes on anything —
  any heading or paragraph is clickable to attach a comment.
</p>
<p><a class="cta-btn" href="${esc(ctx.previewUrl)}">Read the draft &amp; leave notes</a></p>
<p style="font-size: 13px; color: #6b6b6b;">
  Or paste this into your browser:<br>
  <a href="${esc(ctx.previewUrl)}">${esc(ctx.previewUrl)}</a>
</p>
<div class="footer">
  <p>This is a draft preview — the published version may differ. You're
  getting it because you're a reviewer. The published brief still
  arrives separately once the issue ships.</p>
  <p>Private link, expires in 14 days.</p>
</div>`;
  const html = docShell(subject, body);
  const text = [
    "BLURPADURP",
    `Draft · ${dateStr}`,
    ctx.title !== null ? `\n${ctx.title}` : "",
    "",
    "A new issue is drafted and waiting for your read before it goes out.",
    "Open the private preview to read it and leave notes:",
    "",
    ctx.previewUrl,
    "",
    "This is a draft preview — the published version may differ.",
    "Private link, expires in 14 days.",
  ]
    .filter((s) => s !== null && s !== undefined)
    .join("\n");
  return { subject, html, text };
}

export function renderConfirmationEmail(ctx: ConfirmEmailCtx): Rendered {
  const locale = ctx.locale ?? DEFAULT_LOCALE;
  const e = t(locale).email;
  const subject = e.confirmSubject;
  const expiry = fill(e.confirmExpiry, { host: hostOf(ctx.brandUrl) });
  const body = `
<p class="brand">Blurpadurp</p>
<p class="meta">${esc(e.confirmMeta)}</p>
<p>${esc(e.confirmBody)}</p>
<p><a class="cta-btn" href="${esc(ctx.confirmUrl)}">${esc(e.confirmCta)}</a></p>
<p style="font-size: 13px; color: #6b6b6b;">
  ${esc(e.confirmPasteHint)}<br>
  <a href="${esc(ctx.confirmUrl)}">${esc(ctx.confirmUrl)}</a>
</p>
<div class="footer">
  <p>${esc(expiry)}</p>
  <p>${esc(e.confirmNoAccount)}</p>
</div>`;
  const html = docShell(subject, body, locale);
  const text = [
    "BLURPADURP",
    "",
    e.confirmBody,
    "",
    `${e.confirmCta}: ${ctx.confirmUrl}`,
    "",
    expiry,
  ].join("\n");
  return { subject, html, text };
}

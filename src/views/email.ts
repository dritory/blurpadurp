// Email templates — the weekly brief + confirmation. Inline <style>
// blocks in <head>; most modern clients honour them, Outlook's
// quirks we accept. No external stylesheets (blocked by email clients)
// and no Google Fonts reference (Lora won't render — fallback to
// Georgia, which ships everywhere).
//
// The brief template wraps whatever composed_html the composer emitted
// (<h2>, <p>, <a>, <strong>, <em>, <span class="shrug-tag">,
// <span class="cite">) and adds header, issue title, footer.

export interface BriefEmailCtx {
  brandUrl: string; // e.g. https://blurpadurp.com — no trailing slash
  issueUrl: string; // deep link to the published issue page
  unsubscribeUrl: string;
  manageUrl: string;
  title: string | null;
  date: Date;
  issueHtml: string;
  issueMarkdown: string;
}

export interface ConfirmEmailCtx {
  brandUrl: string;
  confirmUrl: string;
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

function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
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

function docShell(subject: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
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
  const dateStr = fmtDate(ctx.date);
  const subject = ctx.title !== null ? ctx.title : `Blurpadurp — ${dateStr}`;
  const titleHtml =
    ctx.title !== null ? `<h1 class="title">${esc(ctx.title)}</h1>` : "";
  const privacyUrl = `${ctx.brandUrl}/privacy`;
  const body = `
<p class="brand">Blurpadurp</p>
<p class="meta">${esc(dateStr)}</p>
${titleHtml}
${ctx.issueHtml}
<div class="footer">
  <p>You're receiving this because you subscribed at <a href="${esc(ctx.brandUrl)}">${esc(hostOf(ctx.brandUrl))}</a>. One brief a week when the gate fires, nothing otherwise.</p>
  <p><a href="${esc(ctx.unsubscribeUrl)}">Unsubscribe</a> · <a href="${esc(ctx.manageUrl)}">Preferences</a> · <a href="${esc(ctx.issueUrl)}">Read on web</a> · <a href="${esc(privacyUrl)}">Privacy</a></p>
</div>`;
  const html = docShell(subject, body);
  const text = [
    "BLURPADURP",
    dateStr,
    ctx.title !== null ? `\n${ctx.title}` : "",
    "",
    ctx.issueMarkdown.trim(),
    "",
    "---",
    `Read on web: ${ctx.issueUrl}`,
    `Preferences: ${ctx.manageUrl}`,
    `Unsubscribe: ${ctx.unsubscribeUrl}`,
    "",
  ]
    .filter((s) => s !== null && s !== undefined)
    .join("\n");
  return { subject, html, text };
}

export function renderConfirmationEmail(ctx: ConfirmEmailCtx): Rendered {
  const subject = "Confirm your Blurpadurp subscription";
  const body = `
<p class="brand">Blurpadurp</p>
<p class="meta">One tap and you're done.</p>
<p>
  Confirm your email so Blurp can send you the brief when the gate fires.
  If you didn't subscribe, ignore this — nothing happens without a click.
</p>
<p><a class="cta-btn" href="${esc(ctx.confirmUrl)}">Confirm subscription</a></p>
<p style="font-size: 13px; color: #6b6b6b;">
  Or paste this into your browser:<br>
  <a href="${esc(ctx.confirmUrl)}">${esc(ctx.confirmUrl)}</a>
</p>
<div class="footer">
  <p>Link expires in 14 days. Subscribe again from ${esc(hostOf(ctx.brandUrl))} if it does.</p>
  <p>No account, no password, no tracking.</p>
</div>`;
  const html = docShell(subject, body);
  const text = [
    "BLURPADURP",
    "",
    "Confirm your email so Blurp can send you the brief when the gate fires.",
    "If you didn't subscribe, ignore this — nothing happens without a click.",
    "",
    `Tap to confirm: ${ctx.confirmUrl}`,
    "",
    "Link expires in 14 days.",
  ].join("\n");
  return { subject, html, text };
}

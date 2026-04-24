// Inline CSS for the public site. Loaded once into a <style> tag by layout.
// Anti-engagement by design: no animations, no hovers that flash, no
// attention-grabbing color. Serif body for reading, sans for chrome.

export const STYLES = `
*, *::before, *::after { box-sizing: border-box; }
:root {
  --ink: #1a1a1a;
  --ink-soft: #6b6b6b;
  --paper: #faf8f3;
  --rule: #dcd7cc;
  --accent: #5a4a36;
  --flash-ok: #4a6b4a;
  --flash-err: #a63a3a;
  --sans: "Helvetica Neue", Helvetica, Arial, sans-serif;
  --serif: Lora, Charter, "Iowan Old Style", "Palatino Linotype", Georgia, serif;
  --logo: Comfortaa, "Helvetica Neue", Helvetica, Arial, sans-serif;
}
html, body { margin: 0; padding: 0; background: var(--paper); color: var(--ink); }
body { font-family: var(--serif); font-size: 18px; line-height: 1.55; }

/* Skip-to-content link: invisible until focused, jumps past the header. */
.skip-link {
  position: absolute; top: -40px; left: 12px; padding: 8px 14px;
  background: var(--ink); color: var(--paper); font-family: var(--sans);
  font-size: 14px; text-decoration: none; z-index: 10;
}
.skip-link:focus { top: 12px; }

/* Visible focus ring for keyboard users. Consistent across all links/buttons. */
:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.wrap { max-width: 680px; margin: 0 auto; padding: 56px 24px 96px; }

header {
  display: flex; align-items: center; gap: 16px;
  border-bottom: 1px solid var(--rule);
  padding-bottom: 18px; margin-bottom: 40px;
}
header .brand-mark-link { flex-shrink: 0; display: block; line-height: 0; }
header .brand-mark { display: block; width: 104px; height: 104px; }
header .brand-text { flex: 1; min-width: 0; }
header .brand-word { margin: 0; font-size: 32px; letter-spacing: -0.01em; font-family: var(--logo); font-weight: 700; line-height: 1; }
header .brand-word a { color: inherit; text-decoration: none; }
header .brand-word a:hover { opacity: 0.85; }
header p.tag { margin: 4px 0 0; color: var(--ink-soft); font-size: 14px; font-family: var(--sans); line-height: 1.3; }
header nav { margin-top: 6px; font-family: var(--sans); font-size: 13px; }
header nav a { color: var(--ink-soft); text-decoration: none; }
header nav a:hover { color: var(--ink); }
header nav a.current { color: var(--ink); font-weight: 500; }
header nav a + a::before { content: "|"; margin: 0 10px; color: var(--ink-soft); opacity: 0.45; }

/* Subscribe: letter-by-letter wave, triggered by JS only if ≥10s since
   last wave (sessionStorage). Per-letter delay is set inline in layout. */
header nav a[href="/subscribe"] span { display: inline-block; transform-origin: 50% 100%; }
header nav a[href="/subscribe"].waving span {
  animation: subscribe-wave 900ms ease-in-out 1;
}
@keyframes subscribe-wave {
  0%, 100% { transform: translateY(0); }
  40% { transform: translateY(-5px); }
}
@media (prefers-reduced-motion: reduce) {
  header nav a[href="/subscribe"].waving span { animation: none; }
}

h2, h3 { font-family: var(--sans); letter-spacing: -0.01em; font-weight: 600; }
h2 { font-size: 22px; margin: 40px 0 12px; }
h3 { font-size: 18px; margin: 28px 0 8px; }
p { margin: 0 0 16px; }
ul, ol { margin: 0 0 16px; padding-left: 22px; }
li { margin-bottom: 6px; }
a { color: var(--accent); text-underline-offset: 2px; }
hr { border: none; border-top: 1px solid var(--rule); margin: 40px 0; }
em { color: var(--ink-soft); }

.subscribe { background: #fff; border: 1px solid var(--rule); padding: 20px 22px; margin: 0 0 40px; }
.subscribe label { display: block; font-size: 14px; color: var(--ink-soft); margin-bottom: 10px; font-family: var(--sans); }
.subscribe .row { display: flex; gap: 8px; flex-wrap: wrap; }
.subscribe input[type=email] { flex: 1 1 240px; padding: 10px 12px; border: 1px solid var(--rule); font-size: 16px; font-family: inherit; background: var(--paper); }
.subscribe button { padding: 10px 18px; font-size: 15px; font-family: var(--sans); background: var(--ink); color: var(--paper); border: none; cursor: pointer; }
.subscribe .hp { position: absolute; left: -9999px; width: 1px; height: 1px; opacity: 0; }
.subscribe .fine { margin: 10px 0 0; font-size: 12px; color: var(--ink-soft); font-family: var(--sans); }

.flash { padding: 10px 14px; margin: 0 0 24px; border-left: 3px solid var(--flash-ok); background: #fff; font-size: 15px; font-family: var(--sans); }
.flash.error { border-left-color: var(--flash-err); }

.issue-meta { font-size: 14px; color: var(--ink-soft); margin: 0 0 8px; font-family: var(--sans); }

/* Title — display roman: big non-italic serif with tight tracking. */
.issue-title {
  font: 700 44px/1.05 var(--serif);
  letter-spacing: -0.02em;
  color: var(--ink);
  margin: 0 0 28px;
}

/* Opener paragraph — italic 20px serif with a hairline beneath that
   separates the synthesis from the body. Matches only when the composer
   emits a synthesis before the first <h2>; silently no-op otherwise. */
.issue-body > div > p:first-child {
  font-size: 20px;
  line-height: 1.5;
  font-style: italic;
  color: var(--ink);
  padding-bottom: 24px;
  border-bottom: 1px solid var(--rule);
  margin: 0 0 32px;
}

/* Section heads — no rules between sections; the subtitle's hairline
   does the structural work, whitespace carries the rest. */
.issue-body h2 { font-size: 20px; font-weight: 600; margin: 40px 0 16px; }
.issue-body h2:first-child { margin-top: 0; }

/* Each item's lede in sans for scannable hierarchy against the body serif. */
.issue-body p strong:first-child { font-family: var(--sans); font-weight: 600; }

/* Inline citations. v0.6+ wraps the whole cluster in <span class="cite">;
   we style that as one tiny, non-wrapping unit so the parens never orphan
   onto their own line. The bare-link fallback below handles pre-v0.6
   HTML — less tight, but passable. */
.issue-body .cite {
  font-size: 0.76em;
  color: var(--ink-soft);
  white-space: nowrap;
  margin-left: 4px;
  letter-spacing: 0.01em;
}
.issue-body .cite a {
  color: var(--ink-soft);
  text-decoration-thickness: 0.5px; text-underline-offset: 3px;
}
.issue-body .cite a:hover { color: var(--ink); }

/* Fallback for pre-v0.6 issues without <span class="cite">. */
.issue-body p > a {
  font-size: 0.82em; color: var(--ink-soft);
  text-decoration-thickness: 0.5px; text-underline-offset: 3px;
}
.issue-body p > a:hover { color: var(--ink); }
.issue-body p strong a { font-size: inherit; color: var(--accent); }

/* Shrug section — last H2 plus everything after it — muted to read as
   dismissal, not news. Composer always emits shrug last. */
.issue-body h2:last-of-type,
.issue-body h2:last-of-type ~ p { color: var(--ink-soft); }

@media (max-width: 640px) {
  .issue-title { font-size: 32px; margin-bottom: 22px; }
  .issue-body > div > p:first-child { font-size: 18px; padding-bottom: 20px; margin-bottom: 24px; }
  .issue-body h2 { margin: 32px 0 12px; }
}

.archive-list { list-style: none; padding: 0; margin: 0; }
.archive-list li { padding: 14px 0; border-bottom: 1px solid var(--rule); margin: 0; }
.archive-list a { display: block; text-decoration: none; color: var(--ink); }
.archive-list a:hover .title { text-decoration: underline; }
.archive-list .date { font-family: var(--sans); font-size: 13px; color: var(--ink-soft); display: block; margin-bottom: 2px; }
.archive-list .title { font-family: var(--sans); font-size: 17px; font-weight: 500; }

.shrug-tag { font-family: var(--sans); font-size: 12px; color: var(--ink-soft); text-transform: uppercase; letter-spacing: 0.06em; }

footer { margin-top: 80px; padding-top: 20px; border-top: 1px solid var(--rule); color: var(--ink-soft); font-size: 13px; font-family: var(--sans); }
footer p { margin: 0; }

/* Phones and narrow tablets. Tighter chrome, stacked forms, slightly smaller body. */
@media (max-width: 640px) {
  .wrap { padding: 32px 16px 64px; }
  header { gap: 12px; margin-bottom: 28px; padding-bottom: 14px; }
  header .brand-mark { width: 80px; height: 80px; }
  header .brand-word { font-size: 24px; }
  header p.tag { font-size: 13px; }
  header nav { margin-top: 6px; font-size: 13px; }
  header nav a + a::before { margin: 0 8px; }

  body { font-size: 17px; }
  h2 { font-size: 20px; margin: 32px 0 10px; }
  h3 { font-size: 17px; margin: 22px 0 8px; }

  .subscribe { padding: 16px; }
  .subscribe .row { flex-direction: column; gap: 10px; }
  .subscribe input[type=email],
  .subscribe button { width: 100%; flex: 1 1 auto; }
  .subscribe button { padding: 12px 18px; }

  .archive-list .title { font-size: 16px; }
  hr { margin: 28px 0; }
  footer { margin-top: 56px; }
}

/* Very narrow phones. Trim further to avoid two-line nav. */
@media (max-width: 380px) {
  .wrap { padding: 24px 12px 56px; }
  header { gap: 10px; }
  header .brand-mark { width: 64px; height: 64px; }
  header .brand-word { font-size: 20px; }
  header nav a + a::before { margin: 0 6px; }
}
`;

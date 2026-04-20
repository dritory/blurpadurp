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
  --serif: Charter, "Iowan Old Style", "Palatino Linotype", Georgia, serif;
}
html, body { margin: 0; padding: 0; background: var(--paper); color: var(--ink); }
body { font-family: var(--serif); font-size: 18px; line-height: 1.55; }
.wrap { max-width: 680px; margin: 0 auto; padding: 56px 24px 96px; }

header { border-bottom: 1px solid var(--rule); padding-bottom: 18px; margin-bottom: 40px; }
header h1 { margin: 0; font-size: 30px; letter-spacing: -0.015em; font-family: var(--sans); font-weight: 700; }
header h1 a { color: inherit; text-decoration: none; }
header p.tag { margin: 4px 0 0; color: var(--ink-soft); font-size: 15px; font-family: var(--sans); }
header nav { margin-top: 18px; font-family: var(--sans); font-size: 14px; }
header nav a { color: var(--ink-soft); margin-right: 18px; text-decoration: none; }
header nav a:hover { color: var(--ink); }
header nav a.current { color: var(--ink); font-weight: 500; }

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

.issue-meta { font-size: 14px; color: var(--ink-soft); margin: 0 0 20px; font-family: var(--sans); }
.issue-body h2:first-child { margin-top: 0; }

.archive-list { list-style: none; padding: 0; margin: 0; }
.archive-list li { padding: 14px 0; border-bottom: 1px solid var(--rule); margin: 0; }
.archive-list a { display: block; text-decoration: none; color: var(--ink); }
.archive-list a:hover .title { text-decoration: underline; }
.archive-list .date { font-family: var(--sans); font-size: 13px; color: var(--ink-soft); display: block; margin-bottom: 2px; }
.archive-list .title { font-family: var(--sans); font-size: 17px; font-weight: 500; }

footer { margin-top: 80px; padding-top: 20px; border-top: 1px solid var(--rule); color: var(--ink-soft); font-size: 13px; font-family: var(--sans); }
footer p { margin: 0; }
`;

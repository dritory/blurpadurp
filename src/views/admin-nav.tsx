// Shared navigation for all /admin/* pages. Sits under the public
// header so admins can hop between tools without typing URLs.
//
// Carries the admin "shell" assets too: HTMX (for surgical form/list
// updates without full reloads) and the wider/denser CSS overrides
// applied via :has(.adm-nav). Per-page client islands declare
// themselves via the `clientBundles` prop — admin pages can drop a
// CodeMirror editor or a JSON tree island onto a page without
// affecting public routes.

import type { FC } from "hono/jsx";

// HTMX is self-hosted under public/vendor/ so it satisfies the strict
// `script-src 'self'` CSP — no third-party origin allowlist required.
// Filename includes the version so a bump is a deliberate two-step
// (drop new file, change this constant); old version stays cacheable.
const HTMX_SRC = "/assets/vendor/htmx-2.0.4.min.js";

export type AdminNavKey =
  | "issues"
  | "prompts"
  | "explore"
  | "themes"
  | "fixtures"
  | "eval"
  | "status"
  | "costs"
  | "config"
  | "review"
  | null;

const ITEMS: Array<{ key: Exclude<AdminNavKey, null>; href: string; label: string }> = [
  { key: "issues", href: "/admin/issues", label: "Issues" },
  { key: "prompts", href: "/admin/prompts", label: "Prompts" },
  { key: "explore", href: "/admin/explore", label: "Explore" },
  { key: "themes", href: "/admin/themes", label: "Themes" },
  { key: "fixtures", href: "/admin/fixtures", label: "Fixtures" },
  { key: "eval", href: "/admin/eval", label: "Eval" },
  { key: "status", href: "/admin/status", label: "Status" },
  { key: "costs", href: "/admin/costs", label: "Costs" },
  { key: "config", href: "/admin/config", label: "Config" },
];

const STYLES = `
  /* Admin shell wider than the public 680px reading column. Tables,
     editor inputs, and side-by-side panels routinely need 1400px+
     before they overflow gracefully. Capped at 1600 so the eye still
     has a comfortable scan width on big monitors. */
  body:has(.adm-nav) .wrap {
    max-width: min(1600px, calc(100vw - 32px));
    padding-left: 16px; padding-right: 16px;
  }
  /* Density bump: admin pages run tables, inputs, and metadata-heavy
     UI. Tighter line-height + slightly smaller default text leaves
     room for more information per screen without sacrificing
     readability. Applies only to admin pages via :has(.adm-nav). */
  body:has(.adm-nav) {
    font-size: 14px;
    line-height: 1.5;
  }
  body:has(.adm-nav) table {
    font-size: 13px;
  }
  body:has(.adm-nav) table th,
  body:has(.adm-nav) table td {
    padding: 6px 10px;
  }
  body:has(.adm-nav) h2 { margin-top: 0.6em; }
  body:has(.adm-nav) h3 { margin-top: 1.2em; margin-bottom: 0.4em; }
  /* Two-column admin layouts get an .adm-grid wrapper. Stacks on
     narrow viewports without the consumer having to write media
     queries. */
  .adm-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 24px;
  }
  .adm-grid > * { min-width: 0; }
  @media (max-width: 900px) {
    .adm-grid { grid-template-columns: minmax(0, 1fr); gap: 16px; }
  }

  .adm-nav {
    display: flex; flex-wrap: wrap; gap: 6px;
    padding: 10px 0 14px; margin: 0 0 20px;
    border-bottom: 1px solid var(--rule);
    font-family: var(--sans); font-size: 13px;
    position: sticky; top: 0;
    background: var(--paper); z-index: 10;
  }
  .adm-nav a {
    padding: 7px 12px; min-height: 32px;
    display: inline-flex; align-items: center;
    border: 1px solid var(--rule);
    text-decoration: none; color: var(--ink-soft); background: #fff;
  }
  .adm-nav a:hover { color: var(--ink); }
  .adm-nav a.current {
    background: var(--ink); color: var(--paper); border-color: var(--ink);
  }
  .adm-nav .spacer { flex: 1; }
  .adm-nav .back { color: var(--ink-soft); }

  /* Breadcrumb row under the main nav (sub-pages). */
  .adm-crumbs {
    font-family: var(--sans); font-size: 13px; color: var(--ink-soft);
    margin: -8px 0 18px;
  }
  .adm-crumbs a { color: var(--ink-soft); text-decoration: none; }
  .adm-crumbs a:hover { color: var(--ink); }
  .adm-crumbs .sep { margin: 0 8px; opacity: 0.6; }
  .adm-crumbs .here { color: var(--ink); font-weight: 500; }

  /* Horizontal scroll wrapper for wide admin tables on narrow screens. */
  .adm-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; margin: 0 0 18px; }
  .adm-scroll table { margin-bottom: 0; }

  /* Toast / inline ack for form actions. */
  .adm-toast {
    display: inline-block; padding: 6px 12px; margin-left: 10px;
    font-family: var(--sans); font-size: 13px; background: #eaf2e8;
    border: 1px solid #c6dbc0; color: #2f4a2d;
  }
  .adm-toast.error { background: #fbe8e8; border-color: #e3b9b9; color: #772b2b; }

  /* Mobile: wider nav taps, slightly larger font, tighter surrounding whitespace. */
  @media (max-width: 640px) {
    .adm-nav { gap: 4px; padding: 8px 0 10px; font-size: 14px; margin-bottom: 16px; }
    .adm-nav a { padding: 9px 12px; min-height: 40px; }
    .adm-nav .spacer { display: none; }
    .adm-nav .back { flex-basis: 100%; text-align: right; padding: 6px 0; border: none; background: transparent; min-height: 28px; }
    .adm-crumbs { margin: -4px 0 14px; }
  }
`;

export const AdminNav: FC<{
  current: AdminNavKey;
  /** Per-page client bundles to include after HTMX. Paths are URL-
   * absolute (e.g. "/assets/admin/prompt-editor.js"). Each bundle is
   * loaded with `defer` so DOM is ready when it runs. Public pages
   * never see these — they're only emitted on admin pages by
   * construction (this component is admin-only). */
  clientBundles?: string[];
}> = ({ current, clientBundles = [] }) => (
  <>
    <style dangerouslySetInnerHTML={{ __html: STYLES }} />
    <script src={HTMX_SRC} defer />
    {clientBundles.map((src) => (
      <script src={src} defer />
    ))}
    <nav class="adm-nav" aria-label="Admin">
      {ITEMS.map((i) => (
        <a href={i.href} class={current === i.key ? "current" : ""}>
          {i.label}
        </a>
      ))}
      <span class="spacer" />
      <a href="/" class="back">← public site</a>
    </nav>
  </>
);

export type Crumb = { label: string; href?: string };

export const AdminCrumbs: FC<{ trail: Crumb[] }> = ({ trail }) => (
  <nav class="adm-crumbs" aria-label="Breadcrumb">
    {trail.map((c, i) => {
      const last = i === trail.length - 1;
      return (
        <>
          {c.href !== undefined && !last ? (
            <a href={c.href}>{c.label}</a>
          ) : (
            <span class={last ? "here" : ""}>{c.label}</span>
          )}
          {!last ? <span class="sep">›</span> : null}
        </>
      );
    })}
  </nav>
);

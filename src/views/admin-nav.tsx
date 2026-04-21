// Shared navigation for all /admin/* pages. Sits under the public
// header so admins can hop between tools without typing URLs.

import type { FC } from "hono/jsx";

export type AdminNavKey =
  | "explore"
  | "themes"
  | "eval"
  | "config"
  | "costs"
  | "status"
  | "fixtures"
  | "review"
  | null;

const ITEMS: Array<{ key: Exclude<AdminNavKey, null>; href: string; label: string }> = [
  { key: "explore", href: "/admin/explore", label: "Explore" },
  { key: "themes", href: "/admin/themes", label: "Themes" },
  { key: "eval", href: "/admin/eval", label: "Eval" },
  { key: "config", href: "/admin/config", label: "Config" },
  { key: "costs", href: "/admin/costs", label: "Costs" },
  { key: "status", href: "/admin/status", label: "Status" },
  { key: "fixtures", href: "/admin/fixtures", label: "Fixtures" },
];

const STYLES = `
  .adm-nav {
    display: flex; flex-wrap: wrap; gap: 4px;
    padding: 10px 0 14px; margin: 0 0 16px;
    border-bottom: 1px solid var(--rule);
    font-family: var(--sans); font-size: 13px;
  }
  .adm-nav a {
    padding: 5px 10px; border: 1px solid var(--rule);
    text-decoration: none; color: var(--ink-soft); background: #fff;
  }
  .adm-nav a:hover { color: var(--ink); }
  .adm-nav a.current {
    background: var(--ink); color: var(--paper); border-color: var(--ink);
  }
  .adm-nav .spacer { flex: 1; }
  .adm-nav .back { color: var(--ink-soft); }
`;

export const AdminNav: FC<{ current: AdminNavKey }> = ({ current }) => (
  <>
    <style dangerouslySetInnerHTML={{ __html: STYLES }} />
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

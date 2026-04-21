// Admin themes page — list + filter + toggle is_long_running.
// A "long-running" theme gets editor-level priority and composer-level
// sidebar treatment (see editor-prompt.md and composer-prompt.md).

import type { FC } from "hono/jsx";
import { Layout } from "./layout.tsx";

export interface ThemeRow {
  id: number;
  name: string;
  category: string | null;
  firstSeenAt: Date;
  lastPublishedAt: Date | null;
  nStoriesPublished: number;
  rollingAvg: number | null;
  rolling30d: number | null;
  trajectory: "new" | "rising" | "stable" | "falling";
  isLongRunning: boolean;
}

export type ThemeFilter = "all" | "long_running" | "rising" | "active";

export interface ThemesData {
  rows: ThemeRow[];
  filter: ThemeFilter;
  total: number;
  flash: { kind: "ok" | "error"; msg: string } | null;
}

const STYLES = `
  .t-filters { display: flex; gap: 6px; font-family: var(--sans); font-size: 13px; margin: 0 0 16px; }
  .t-filters a { padding: 6px 12px; border: 1px solid var(--rule); text-decoration: none; color: var(--ink); background: #fff; }
  .t-filters a.current { background: var(--ink); color: var(--paper); border-color: var(--ink); }

  table.t-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  table.t-table th, table.t-table td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--rule); vertical-align: middle; }
  table.t-table th { font-family: var(--sans); font-weight: 600; font-size: 11px; color: var(--ink-soft); text-transform: uppercase; letter-spacing: 0.04em; }
  table.t-table td.num { text-align: right; font-variant-numeric: tabular-nums; }
  table.t-table .traj { font-family: var(--sans); font-size: 11px; padding: 1px 6px; border-radius: 2px; background: rgba(0,0,0,0.05); color: var(--ink-soft); }
  table.t-table .traj.rising { background: rgba(74, 107, 74, 0.2); color: #2b4f2b; }
  table.t-table .traj.falling { background: rgba(166, 58, 58, 0.15); color: #7a2929; }
  table.t-table .traj.new { background: rgba(197, 162, 74, 0.2); color: #6b551c; }

  form.toggle { display: inline; }
  form.toggle button {
    padding: 4px 10px; font-size: 12px; font-family: var(--sans);
    border: 1px solid var(--rule); background: #fff; color: var(--ink-soft); cursor: pointer;
  }
  form.toggle button.on { background: var(--ink); color: var(--paper); border-color: var(--ink); }
`;

export const AdminThemes: FC<{ data: ThemesData }> = ({ data }) => {
  const cls = (f: ThemeFilter) => (data.filter === f ? "current" : "");
  return (
    <Layout title="Themes — Blurpadurp admin">
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      <h2>Themes</h2>
      <p style="color: var(--ink-soft); font-size: 14px; font-family: var(--sans);">
        {data.total.toLocaleString()} themes total. Toggle "Long-running"
        to mark a theme for weekly treatment regardless of current-week
        volume — editor will always include an update if there's new
        material, composer anchors arcs in the longer story.
      </p>
      {data.flash !== null ? (
        <div class={`flash ${data.flash.kind === "error" ? "error" : ""}`}>
          {data.flash.msg}
        </div>
      ) : null}
      <nav class="t-filters" aria-label="Theme filter">
        <a href="/admin/themes?filter=all" class={cls("all")}>
          All
        </a>
        <a
          href="/admin/themes?filter=long_running"
          class={cls("long_running")}
        >
          ★ Long-running
        </a>
        <a href="/admin/themes?filter=rising" class={cls("rising")}>
          ↑ Rising
        </a>
        <a href="/admin/themes?filter=active" class={cls("active")}>
          Active (last 30d)
        </a>
      </nav>

      <table class="t-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Cat</th>
            <th class="num">Stories</th>
            <th class="num">Avg</th>
            <th class="num">30d</th>
            <th>Trajectory</th>
            <th>Last published</th>
            <th>Long-running</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((t) => (
            <tr>
              <td>{t.name}</td>
              <td>{t.category ?? "—"}</td>
              <td class="num">{t.nStoriesPublished}</td>
              <td class="num">
                {t.rollingAvg !== null ? t.rollingAvg.toFixed(1) : "—"}
              </td>
              <td class="num">
                {t.rolling30d !== null ? t.rolling30d.toFixed(1) : "—"}
              </td>
              <td>
                <span class={`traj ${t.trajectory}`}>{t.trajectory}</span>
              </td>
              <td>
                {t.lastPublishedAt !== null
                  ? t.lastPublishedAt.toISOString().slice(0, 10)
                  : "—"}
              </td>
              <td>
                <form class="toggle" method="post" action="/admin/themes/toggle">
                  <input type="hidden" name="theme_id" value={t.id} />
                  <input
                    type="hidden"
                    name="next"
                    value={t.isLongRunning ? "off" : "on"}
                  />
                  <input type="hidden" name="filter" value={data.filter} />
                  <button
                    type="submit"
                    class={t.isLongRunning ? "on" : ""}
                    title={
                      t.isLongRunning
                        ? "Click to unset"
                        : "Click to mark long-running"
                    }
                  >
                    {t.isLongRunning ? "★ on" : "off"}
                  </button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {data.rows.length === 0 ? (
        <p>
          <em>No themes match this filter.</em>
        </p>
      ) : null}
    </Layout>
  );
};

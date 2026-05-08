// Admin URL path-filter management. List, add, delete, toggle
// block↔tag, see lifetime hit count per pattern. Backed by table
// url_path_filter; consumed by ingest (src/pipeline/ingest.ts) on
// each run as a snapshot.

import type { FC } from "hono/jsx";
import { Layout } from "./layout.tsx";
import { AdminNav } from "./admin-nav.tsx";

export interface PathFilterRow {
  pattern: string;
  mode: "block" | "tag";
  hits: number;
  note: string | null;
  createdAt: Date;
  // Live count of currently persisted stories whose noise_pattern
  // equals this pattern. Only meaningful for tag-mode rows; for
  // block-mode rows the value is always 0 (those stories were never
  // persisted) and we hide it.
  liveStoryCount: number;
}

export interface PathFiltersData {
  rows: PathFilterRow[];
  flash: { added?: string; removed?: string; toggled?: string; error?: string } | null;
}

const STYLES = `
  table.pf { width: 100%; border-collapse: collapse; font-size: 13px; }
  table.pf th, table.pf td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--rule); vertical-align: middle; }
  table.pf th { font-family: var(--sans); font-weight: 600; font-size: 11px; color: var(--ink-soft); text-transform: uppercase; letter-spacing: 0.04em; }
  table.pf td.num { font-variant-numeric: tabular-nums; }
  .pf-pattern { font-family: ui-monospace, Menlo, monospace; font-size: 13px; }
  .pf-mode-block { color: #8a2a2a; font-weight: 600; }
  .pf-mode-tag { color: #6b551c; font-weight: 600; }
  .pf-actions form { display: inline; margin: 0 4px 0 0; }
  .pf-actions button { padding: 3px 9px; font-family: var(--sans); font-size: 12px; background: #fff; border: 1px solid var(--rule); cursor: pointer; }
  .pf-actions button:hover { border-color: var(--ink); }
  .pf-actions button.danger { color: #8a2a2a; border-color: #d4a4a4; }
  .pf-add { padding: 12px 14px; background: #fff; border: 1px solid var(--rule); margin-bottom: 16px; }
  .pf-add form { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .pf-add input[type=text] { font: inherit; padding: 4px 8px; border: 1px solid var(--rule); }
  .pf-add input[name=pattern] { width: 220px; font-family: ui-monospace, Menlo, monospace; }
  .pf-add input[name=note] { width: 280px; }
  .pf-add select { font: inherit; padding: 4px 8px; border: 1px solid var(--rule); background: #fff; }
  .pf-add button { padding: 4px 12px; font: inherit; font-family: var(--sans); border: 1px solid var(--rule); background: #fff; cursor: pointer; }
  .pf-flash { padding: 8px 12px; margin: 0 0 12px; font-family: var(--sans); font-size: 13px; background: rgba(74, 107, 74, 0.08); border-left: 3px solid #4a6b4a; }
  .pf-flash.error { background: rgba(166, 58, 58, 0.06); border-left-color: var(--flash-err); color: #8a2a2a; }
  .muted { color: var(--ink-soft); }
`;

export const AdminPathFilters: FC<{ d: PathFiltersData }> = ({ d }) => (
  <Layout title="Path filters — Blurpadurp admin">
    <style dangerouslySetInnerHTML={{ __html: STYLES }} />
    <AdminNav current="path-filters" />
    <h2>URL path filters</h2>
    <p style="color: var(--ink-soft); font-family: var(--sans); font-size: 13px; max-width: 680px;">
      Substring matched against lowercased <code>source_url</code> at ingest.
      <strong> block</strong> drops the story before persist (no
      embedding, no scoring spend). <strong>tag</strong> persists with
      <code> story.noise_pattern</code> set so you can audit false
      positives via <a href="/admin/explore/stories">Stories</a> before
      promoting to block.
    </p>

    {d.flash?.added ? (
      <div class="pf-flash">Added <code>{d.flash.added}</code>.</div>
    ) : null}
    {d.flash?.removed ? (
      <div class="pf-flash">Removed <code>{d.flash.removed}</code>.</div>
    ) : null}
    {d.flash?.toggled ? (
      <div class="pf-flash">Toggled <code>{d.flash.toggled}</code>.</div>
    ) : null}
    {d.flash?.error ? (
      <div class="pf-flash error">{d.flash.error}</div>
    ) : null}

    <div class="pf-add">
      <form method="post" action="/admin/path-filters/add">
        <label>
          pattern{" "}
          <input
            type="text"
            name="pattern"
            placeholder="/example/"
            required
            autocomplete="off"
          />
        </label>
        <label>
          mode{" "}
          <select name="mode">
            <option value="block">block</option>
            <option value="tag">tag</option>
          </select>
        </label>
        <label>
          note{" "}
          <input
            type="text"
            name="note"
            placeholder="optional"
            autocomplete="off"
          />
        </label>
        <button type="submit">add</button>
      </form>
    </div>

    <div class="adm-scroll">
      <table class="pf">
        <thead>
          <tr>
            <th>Pattern</th>
            <th>Mode</th>
            <th>Hits</th>
            <th>Live (tag)</th>
            <th>Note</th>
            <th>Added</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {d.rows.map((r) => (
            <tr>
              <td class="pf-pattern">{r.pattern}</td>
              <td class={r.mode === "block" ? "pf-mode-block" : "pf-mode-tag"}>
                {r.mode}
              </td>
              <td class="num">{r.hits.toLocaleString()}</td>
              <td class="num">
                {r.mode === "tag" ? (
                  <a
                    href={`/admin/explore/stories?noise=${encodeURIComponent(r.pattern)}`}
                  >
                    {r.liveStoryCount.toLocaleString()}
                  </a>
                ) : (
                  <span class="muted">—</span>
                )}
              </td>
              <td class="muted">{r.note ?? ""}</td>
              <td class="muted">{r.createdAt.toISOString().slice(0, 10)}</td>
              <td class="pf-actions">
                <form method="post" action="/admin/path-filters/toggle">
                  <input type="hidden" name="pattern" value={r.pattern} />
                  <button type="submit">
                    → {r.mode === "block" ? "tag" : "block"}
                  </button>
                </form>
                <form
                  method="post"
                  action="/admin/path-filters/delete"
                  data-confirm={`Delete pattern ${r.pattern}?`}
                >
                  <input type="hidden" name="pattern" value={r.pattern} />
                  <button type="submit" class="danger">
                    delete
                  </button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </Layout>
);

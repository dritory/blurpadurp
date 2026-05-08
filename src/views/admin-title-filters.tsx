// Admin title-regex filter management. Same shape as
// /admin/path-filters but matches against story.title via JS RegExp.
// Always case-insensitive — operators rarely want case-sensitive
// matches on news titles. Patterns are validated at insert time.

import type { FC } from "hono/jsx";
import { Layout } from "./layout.tsx";
import { AdminNav } from "./admin-nav.tsx";

export interface TitleFilterRow {
  pattern: string;
  mode: "block" | "tag";
  hits: number;
  note: string | null;
  createdAt: Date;
  // Live count of currently persisted stories whose
  // noise_title_pattern equals this pattern. Block-mode rows always
  // read 0 because those stories were dropped at ingest.
  liveStoryCount: number;
}

export interface TitleFiltersData {
  rows: TitleFilterRow[];
  flash: { added?: string; removed?: string; toggled?: string; error?: string } | null;
}

const STYLES = `
  table.tf { width: 100%; border-collapse: collapse; font-size: 13px; }
  table.tf th, table.tf td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--rule); vertical-align: middle; }
  table.tf th { font-family: var(--sans); font-weight: 600; font-size: 11px; color: var(--ink-soft); text-transform: uppercase; letter-spacing: 0.04em; }
  table.tf td.num { font-variant-numeric: tabular-nums; }
  .tf-pattern { font-family: ui-monospace, Menlo, monospace; font-size: 13px; max-width: 380px; word-break: break-all; }
  .tf-mode-block { color: #8a2a2a; font-weight: 600; }
  .tf-mode-tag { color: #6b551c; font-weight: 600; }
  .tf-actions form { display: inline; margin: 0 4px 0 0; }
  .tf-actions button { padding: 3px 9px; font-family: var(--sans); font-size: 12px; background: #fff; border: 1px solid var(--rule); cursor: pointer; }
  .tf-actions button:hover { border-color: var(--ink); }
  .tf-actions button.danger { color: #8a2a2a; border-color: #d4a4a4; }
  .tf-add { padding: 12px 14px; background: #fff; border: 1px solid var(--rule); margin-bottom: 16px; }
  .tf-add form { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .tf-add input[type=text] { font: inherit; padding: 4px 8px; border: 1px solid var(--rule); }
  .tf-add input[name=pattern] { width: 320px; font-family: ui-monospace, Menlo, monospace; }
  .tf-add input[name=note] { width: 240px; }
  .tf-add select { font: inherit; padding: 4px 8px; border: 1px solid var(--rule); background: #fff; }
  .tf-add button { padding: 4px 12px; font: inherit; font-family: var(--sans); border: 1px solid var(--rule); background: #fff; cursor: pointer; }
  .tf-flash { padding: 8px 12px; margin: 0 0 12px; font-family: var(--sans); font-size: 13px; background: rgba(74, 107, 74, 0.08); border-left: 3px solid #4a6b4a; }
  .tf-flash.error { background: rgba(166, 58, 58, 0.06); border-left-color: var(--flash-err); color: #8a2a2a; }
  .muted { color: var(--ink-soft); }
`;

export const AdminTitleFilters: FC<{ d: TitleFiltersData }> = ({ d }) => (
  <Layout title="Title filters — Blurpadurp admin">
    <style dangerouslySetInnerHTML={{ __html: STYLES }} />
    <AdminNav current="title-filters" />
    <h2>Title regex filters</h2>
    <p style="color: var(--ink-soft); font-family: var(--sans); font-size: 13px; max-width: 680px;">
      JavaScript regex matched against <code>story.title</code> at
      ingest. Always case-insensitive (the <code>i</code> flag is
      applied automatically). <strong>block</strong> drops the story
      before persist; <strong>tag</strong> persists with{" "}
      <code>story.noise_title_pattern</code> set so you can audit
      false positives before promoting to block.
    </p>

    {d.flash?.added ? (
      <div class="tf-flash">Added <code>{d.flash.added}</code>.</div>
    ) : null}
    {d.flash?.removed ? (
      <div class="tf-flash">Removed <code>{d.flash.removed}</code>.</div>
    ) : null}
    {d.flash?.toggled ? (
      <div class="tf-flash">Toggled <code>{d.flash.toggled}</code>.</div>
    ) : null}
    {d.flash?.error ? (
      <div class="tf-flash error">{d.flash.error}</div>
    ) : null}

    <div class="tf-add">
      <form method="post" action="/admin/title-filters/add">
        <label>
          regex{" "}
          <input
            type="text"
            name="pattern"
            placeholder="^\\d+\\s+best\\b"
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
      <table class="tf">
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
              <td class="tf-pattern">{r.pattern}</td>
              <td class={r.mode === "block" ? "tf-mode-block" : "tf-mode-tag"}>
                {r.mode}
              </td>
              <td class="num">{r.hits.toLocaleString()}</td>
              <td class="num">
                {r.mode === "tag" ? (
                  r.liveStoryCount.toLocaleString()
                ) : (
                  <span class="muted">—</span>
                )}
              </td>
              <td class="muted">{r.note ?? ""}</td>
              <td class="muted">{r.createdAt.toISOString().slice(0, 10)}</td>
              <td class="tf-actions">
                <form method="post" action="/admin/title-filters/toggle">
                  <input type="hidden" name="pattern" value={r.pattern} />
                  <button type="submit">
                    → {r.mode === "block" ? "tag" : "block"}
                  </button>
                </form>
                <form
                  method="post"
                  action="/admin/title-filters/delete"
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

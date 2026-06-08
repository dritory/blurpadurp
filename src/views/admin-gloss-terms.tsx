// Admin management for the gloss-linter's curated jargon list
// (gloss_term, mig 062). Unlike the path/title filters there's no
// block/tag mode — a term is just a name the /admin/review gloss panel
// should watch for. The linter's acronym detector handles all-caps
// names automatically, so this list is for the mixed/lowercase jargon
// the regex can't see ("Brent", "gilt", "tirzepatide").

import type { FC } from "hono/jsx";
import { Layout } from "./layout.tsx";
import { AdminNav } from "./admin-nav.tsx";

export interface GlossTermRow {
  term: string;
  note: string | null;
  hits: number;
  createdAt: Date;
}

export interface GlossTermsData {
  rows: GlossTermRow[];
  flash: { added?: string; removed?: string; error?: string } | null;
}

const STYLES = `
  table.gt { width: 100%; border-collapse: collapse; font-size: 13px; }
  table.gt th, table.gt td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--rule); vertical-align: middle; }
  table.gt th { font-family: var(--sans); font-weight: 600; font-size: 11px; color: var(--ink-soft); text-transform: uppercase; letter-spacing: 0.04em; }
  table.gt td.num { font-variant-numeric: tabular-nums; }
  .gt-term { font-family: ui-monospace, Menlo, monospace; font-size: 13px; }
  .gt-actions form { display: inline; margin: 0 4px 0 0; }
  .gt-actions button { padding: 3px 9px; font-family: var(--sans); font-size: 12px; background: #fff; border: 1px solid var(--rule); cursor: pointer; }
  .gt-actions button:hover { border-color: var(--ink); }
  .gt-actions button.danger { color: #8a2a2a; border-color: #d4a4a4; }
  .gt-add { padding: 12px 14px; background: #fff; border: 1px solid var(--rule); margin-bottom: 16px; }
  .gt-add form { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .gt-add input[type=text] { font: inherit; padding: 4px 8px; border: 1px solid var(--rule); }
  .gt-add input[name=term] { width: 200px; font-family: ui-monospace, Menlo, monospace; }
  .gt-add input[name=note] { width: 320px; }
  .gt-add button { padding: 4px 12px; font: inherit; font-family: var(--sans); border: 1px solid var(--rule); background: #fff; cursor: pointer; }
  .gt-flash { padding: 8px 12px; margin: 0 0 12px; font-family: var(--sans); font-size: 13px; background: rgba(74, 107, 74, 0.08); border-left: 3px solid #4a6b4a; }
  .gt-flash.error { background: rgba(166, 58, 58, 0.06); border-left-color: var(--flash-err); color: #8a2a2a; }
  .muted { color: var(--ink-soft); }
`;

export const AdminGlossTerms: FC<{ d: GlossTermsData }> = ({ d }) => (
  <Layout title="Gloss terms — Blurpadurp admin">
    <style dangerouslySetInnerHTML={{ __html: STYLES }} />
    <AdminNav current="gloss-terms" />
    <h2>Gloss terms</h2>
    <p style="color: var(--ink-soft); font-family: var(--sans); font-size: 13px; max-width: 680px;">
      Specialist names the composer should gloss on first use but a regex
      can't catch — <code>Brent</code>, <code>gilt</code>,{" "}
      <code>tirzepatide</code>. When a composed draft uses one of these
      <strong> un-glossed</strong> on first use, it's flagged on the{" "}
      <a href="/admin/issues">draft review</a> page. Bare un-glossed{" "}
      <em>acronyms</em> (VRA, IRGC) are detected automatically and don't
      belong here. <strong>Hits</strong> counts drafts that used the term
      un-glossed.
    </p>

    {d.flash?.added ? (
      <div class="gt-flash">Added <code>{d.flash.added}</code>.</div>
    ) : null}
    {d.flash?.removed ? (
      <div class="gt-flash">Removed <code>{d.flash.removed}</code>.</div>
    ) : null}
    {d.flash?.error ? <div class="gt-flash error">{d.flash.error}</div> : null}

    <div class="gt-add">
      <form method="post" action="/admin/gloss-terms/add">
        <label>
          term{" "}
          <input
            type="text"
            name="term"
            placeholder="Brent"
            required
            autocomplete="off"
          />
        </label>
        <label>
          note{" "}
          <input
            type="text"
            name="note"
            placeholder="optional — what it means"
            autocomplete="off"
          />
        </label>
        <button type="submit">add</button>
      </form>
    </div>

    <div class="adm-scroll">
      <table class="gt">
        <thead>
          <tr>
            <th>Term</th>
            <th>Note</th>
            <th>Hits</th>
            <th>Added</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {d.rows.map((r) => (
            <tr>
              <td class="gt-term">{r.term}</td>
              <td class="muted">{r.note ?? ""}</td>
              <td class="num">{r.hits.toLocaleString()}</td>
              <td class="muted">{r.createdAt.toISOString().slice(0, 10)}</td>
              <td class="gt-actions">
                <form
                  method="post"
                  action="/admin/gloss-terms/delete"
                  data-confirm={`Delete term ${r.term}?`}
                >
                  <input type="hidden" name="term" value={r.term} />
                  <button type="submit" class="danger">
                    delete
                  </button>
                </form>
              </td>
            </tr>
          ))}
          {d.rows.length === 0 ? (
            <tr>
              <td colspan={5} class="muted">
                No gloss terms yet.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  </Layout>
);

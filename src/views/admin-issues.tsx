// Admin Issues landing. List of recent issues with all links the
// tuning loop needs: public view, editor review, composer-replay
// outputs for each. This is the primary admin entry point — what you
// open after `bun run cli compose` finishes.

import type { FC } from "hono/jsx";
import { Layout } from "./layout.tsx";
import { AdminNav } from "./admin-nav.tsx";
import { formatIssueDate } from "./issue.tsx";

export interface AdminIssueRow {
  id: number;
  publishedAt: Date;
  isEventDriven: boolean;
  composerPromptVersion: string | null;
  composerModelId: string | null;
  storyCount: number;
  replays: Array<{ base: string; mtime: Date }>;
}

const STYLES = `
  table.iss { width: 100%; border-collapse: collapse; font-size: 14px; }
  table.iss th, table.iss td { text-align: left; padding: 10px 10px; border-bottom: 1px solid var(--rule); vertical-align: top; }
  table.iss th { font-family: var(--sans); font-weight: 600; font-size: 12px; color: var(--ink-soft); text-transform: uppercase; letter-spacing: 0.04em; }
  table.iss td.num { font-variant-numeric: tabular-nums; }
  table.iss td.id { font-family: var(--sans); font-weight: 600; }
  table.iss td.model { font-family: var(--sans); font-size: 12px; color: var(--ink-soft); }
  table.iss td.links a { margin-right: 10px; font-family: var(--sans); font-size: 13px; }
  .replay-list { margin: 0; padding: 0; list-style: none; font-family: var(--sans); font-size: 12px; }
  .replay-list li { margin: 2px 0; }
  .replay-list .stamp { color: var(--ink-soft); font-variant-numeric: tabular-nums; }
  .hint { background: #fff; border: 1px solid var(--rule); padding: 10px 14px; margin: 0 0 20px; font-family: var(--sans); font-size: 13px; color: var(--ink-soft); }
  .hint code { font-family: ui-monospace, Menlo, Consolas, monospace; background: var(--paper); padding: 1px 5px; border: 1px solid var(--rule); font-size: 12px; color: var(--ink); }
`;

export const AdminIssues: FC<{ issues: AdminIssueRow[] }> = ({ issues }) => (
  <Layout title="Issues — Blurpadurp admin">
    <style dangerouslySetInnerHTML={{ __html: STYLES }} />
    <AdminNav current="issues" />
    <h2>Issues</h2>
    <div class="hint">
      Tune loop: edit <code>docs/composer-prompt.md</code>, run{" "}
      <code>bun run cli composer-replay</code> (no args — uses the latest
      issue and current config), open the replay link below.
    </div>
    {issues.length === 0 ? (
      <p>
        <em>No issues yet. Run <code>bun run cli compose</code>.</em>
      </p>
    ) : (
      <div class="adm-scroll">
      <table class="iss">
        <thead>
          <tr>
            <th>#</th>
            <th>Published</th>
            <th>Composer</th>
            <th class="num">Stories</th>
            <th>Links</th>
            <th>Replays</th>
          </tr>
        </thead>
        <tbody>
          {issues.map((i) => (
            <tr>
              <td class="id">{i.id}</td>
              <td>{formatIssueDate(i.publishedAt)}{i.isEventDriven ? " · event" : ""}</td>
              <td class="model">
                {i.composerPromptVersion ?? "—"}
                <br />
                {i.composerModelId ?? "—"}
              </td>
              <td class="num">{i.storyCount}</td>
              <td class="links">
                <a href={`/issue/${i.id}`}>Public</a>
                <a href={`/admin/review/${i.id}`}>Review</a>
              </td>
              <td>
                {i.replays.length === 0 ? (
                  <span style="color: var(--ink-soft); font-family: var(--sans); font-size: 12px;">—</span>
                ) : (
                  <ul class="replay-list">
                    {i.replays.map((r) => (
                      <li>
                        <a href={`/admin/fixtures/${r.base}.diff.md`}>diff</a>
                        {" · "}
                        <a href={`/admin/fixtures/${r.base}.html`}>brief</a>
                        {" · "}
                        <span class="stamp">
                          {r.mtime.toISOString().replace("T", " ").slice(0, 16)}Z
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    )}
  </Layout>
);

// Admin reviewer management.
//
// A "reviewer" is an email_subscription with is_reviewer=true. Reviewers
// get the draft-preview link the moment compose persists a draft (so
// they can read + comment before it ships) and the published brief once
// it goes out — both via the dispatch sweep. This page is just the knob:
// promote an existing subscriber to reviewer, or add a fresh reviewer by
// email (inserted pre-confirmed so they receive sends immediately).
//
// Out of scope here: delivery-time / timezone / category-mute prefs —
// those live on the public /manage/<token> page. This is the operator's
// "who reviews drafts" list, nothing more.

import type { FC } from "hono/jsx";

import { AdminCrumbs, AdminNav } from "./admin-nav.tsx";
import { Layout } from "./layout.tsx";

export interface ReviewerRow {
  id: number;
  email: string;
  isReviewer: boolean;
  confirmedAt: Date | null;
  unsubscribedAt: Date | null;
  lastDraftSentAt: Date | null;
  lastPublishedSentAt: Date | null;
}

export interface ReviewersData {
  rows: ReviewerRow[];
  flash: { kind: "ok"; msg: string } | { kind: "err"; msg: string } | null;
}

const STYLES = `
  .rev-add { display: flex; flex-wrap: wrap; gap: 8px; align-items: end; background: #fff; border: 1px solid var(--rule); padding: 12px 14px; margin: 0 0 16px; }
  .rev-add label { display: block; font-family: var(--sans); font-size: 11px; color: var(--ink-soft); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 3px; }
  .rev-add input { padding: 6px 8px; border: 1px solid var(--rule); font: inherit; font-size: 13px; background: var(--paper); min-width: 260px; }
  .rev-add button { padding: 6px 14px; background: var(--ink); color: var(--paper); border: none; font-family: var(--sans); font-size: 13px; cursor: pointer; }

  table.rev-table { width: 100%; border-collapse: collapse; font-size: 13px; min-width: 720px; }
  table.rev-table th, table.rev-table td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--rule); vertical-align: top; }
  table.rev-table th { font-family: var(--sans); font-weight: 600; font-size: 11px; color: var(--ink-soft); text-transform: uppercase; letter-spacing: 0.04em; }
  table.rev-table td.email { font-family: ui-monospace, Menlo, Consolas, monospace; }
  table.rev-table form { display: inline; }
  table.rev-table button { padding: 4px 10px; font: inherit; font-family: var(--sans); font-size: 12px; background: #fff; color: var(--ink); border: 1px solid var(--rule); cursor: pointer; }
  table.rev-table button:hover { border-color: var(--ink); }
  table.rev-table button.promote { color: #2b4f2b; border-color: #9bc79b; }
  table.rev-table button.promote:hover { background: #e6f3e6; border-color: #2b4f2b; }
  table.rev-table button.demote { color: #8a2a2a; border-color: #d4a4a4; }
  table.rev-table button.demote:hover { background: #fbeeee; border-color: #8a2a2a; }
  table.rev-table .pill { display: inline-block; font-family: var(--sans); font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; padding: 1px 6px; border-radius: 2px; }
  table.rev-table .pill.reviewer { background: #e6f3e6; color: #2b4f2b; }
  table.rev-table .pill.unconfirmed { background: #fff5d1; color: #6a5200; }
  table.rev-table .pill.unsub { background: #fbe8e8; color: #8a2a2a; }
  table.rev-table tr.unsub td.email { color: var(--ink-soft); text-decoration: line-through; }
  table.rev-table .when { color: var(--ink-soft); font-variant-numeric: tabular-nums; white-space: nowrap; }

  .flash { padding: 10px 14px; margin: 0 0 16px; font-family: var(--sans); font-size: 14px; border: 1px solid var(--rule); }
  .flash.ok { background: #e6f3e6; border-color: #9bc79b; color: #2b4f2b; }
  .flash.err { background: #fbeeee; border-color: #d4a4a4; color: #8a2a2a; }
`;

function fmtWhen(d: Date | null): string {
  return d === null ? "—" : `${d.toISOString().replace("T", " ").slice(0, 16)}Z`;
}

export const AdminReviewers: FC<{ data: ReviewersData }> = ({ data }) => {
  const reviewers = data.rows.filter((r) => r.isReviewer);
  return (
    <Layout title="Reviewers — Blurpadurp admin">
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      <AdminNav current="reviewers" />
      <AdminCrumbs trail={[{ label: "Reviewers" }]} />
      <h2>Reviewers</h2>

      {data.flash !== null ? (
        <div class={`flash ${data.flash.kind}`}>{data.flash.msg}</div>
      ) : null}

      <p style="font-family: var(--sans); font-size: 13px; color: var(--ink-soft); margin: 0 0 14px; max-width: 70ch;">
        Reviewers get a private link to read each issue as a{" "}
        <strong>draft</strong> — the moment compose produces one — and can
        leave notes on it. They also receive the published brief like any
        other confirmed subscriber. Adding a reviewer here marks them
        confirmed, so sends start immediately. {reviewers.length} active.
      </p>

      <form method="post" action="/admin/reviewers/add" class="rev-add">
        <div>
          <label for="email">Add reviewer by email</label>
          <input
            id="email"
            name="email"
            type="email"
            placeholder="name@example.com"
            required
          />
        </div>
        <button type="submit">Add reviewer</button>
      </form>

      {data.rows.length === 0 ? (
        <p style="color: var(--ink-soft); font-style: italic;">
          No subscriptions yet. Add a reviewer above, or wait for someone to
          subscribe.
        </p>
      ) : (
        <div class="adm-scroll">
          <table class="rev-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Status</th>
                <th>Last draft sent</th>
                <th>Last published sent</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => {
                const unsub = r.unsubscribedAt !== null;
                return (
                  <tr class={unsub ? "unsub" : ""}>
                    <td class="email">
                      {r.email}
                      {r.isReviewer ? (
                        <span class="pill reviewer" style="margin-left:6px;">
                          reviewer
                        </span>
                      ) : null}
                    </td>
                    <td>
                      {unsub ? (
                        <span class="pill unsub">unsubscribed</span>
                      ) : r.confirmedAt === null ? (
                        <span class="pill unconfirmed">unconfirmed</span>
                      ) : (
                        <span class="when">confirmed</span>
                      )}
                    </td>
                    <td class="when">{fmtWhen(r.lastDraftSentAt)}</td>
                    <td class="when">{fmtWhen(r.lastPublishedSentAt)}</td>
                    <td>
                      <form method="post" action={`/admin/reviewers/${r.id}/toggle`}>
                        <input
                          type="hidden"
                          name="make"
                          value={r.isReviewer ? "0" : "1"}
                        />
                        <button
                          type="submit"
                          class={r.isReviewer ? "demote" : "promote"}
                        >
                          {r.isReviewer ? "remove reviewer" : "make reviewer"}
                        </button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Layout>
  );
};

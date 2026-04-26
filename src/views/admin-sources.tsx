// Admin source management. Two tables on one page:
//
//  1. Blocklist — hosts currently dropped at the ingest boundary, with
//     reason + age + an "unblock" button.
//  2. Hosts seen — distinct source_url hosts the pipeline has touched
//     in the last N days, with ingestion / pass / publish counts and
//     a "block" button per row. Skim it for "this host scored 200
//     items, 0 passed" and one click takes them out.

import type { FC } from "hono/jsx";

import { AdminCrumbs, AdminNav } from "./admin-nav.tsx";
import { Layout } from "./layout.tsx";

export type HostSortKey =
  | "host"
  | "ingested"
  | "passed"
  | "passRate"
  | "published";
export type HostSortDir = "asc" | "desc";

export interface SourcesData {
  windowDays: number;
  sort: HostSortKey;
  dir: HostSortDir;
  blocklist: Array<{
    host: string;
    reason: string | null;
    blockedAt: Date;
  }>;
  hosts: Array<{
    host: string;
    ingested: number;
    passed: number;
    published: number;
    isBlocked: boolean;
    blockedByParent: string | null;
  }>;
  flash: { kind: "ok"; msg: string } | { kind: "err"; msg: string } | null;
}

const STYLES = `
  .src-filter { display: flex; flex-wrap: wrap; gap: 10px; align-items: end; background: #fff; border: 1px solid var(--rule); padding: 12px 14px; margin: 0 0 16px; }
  .src-filter label { display: block; font-family: var(--sans); font-size: 11px; color: var(--ink-soft); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 3px; }
  .src-filter select, .src-filter input { padding: 6px 8px; border: 1px solid var(--rule); font: inherit; font-size: 13px; background: var(--paper); }
  .src-filter button { padding: 6px 14px; background: var(--ink); color: var(--paper); border: none; font-family: var(--sans); font-size: 13px; cursor: pointer; }

  .src-add { display: flex; flex-wrap: wrap; gap: 8px; align-items: end; background: #fff; border: 1px solid var(--rule); padding: 12px 14px; margin: 0 0 16px; }
  .src-add label { display: block; font-family: var(--sans); font-size: 11px; color: var(--ink-soft); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 3px; }
  .src-add input { padding: 6px 8px; border: 1px solid var(--rule); font: inherit; font-size: 13px; background: var(--paper); min-width: 180px; }
  .src-add input.reason { min-width: 240px; }
  .src-add button { padding: 6px 14px; background: #8a2a2a; color: #fff; border: 1px solid #8a2a2a; font-family: var(--sans); font-size: 13px; cursor: pointer; }
  .src-add button:hover { background: #6a1a1a; }

  table.src-table { width: 100%; border-collapse: collapse; font-size: 13px; min-width: 720px; }
  table.src-table th, table.src-table td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--rule); vertical-align: top; }
  table.src-table th { font-family: var(--sans); font-weight: 600; font-size: 11px; color: var(--ink-soft); text-transform: uppercase; letter-spacing: 0.04em; }
  table.src-table td.num { text-align: right; font-variant-numeric: tabular-nums; }
  table.src-table td.host { font-family: ui-monospace, Menlo, Consolas, monospace; }
  table.src-table tr.blocked td.host { color: var(--ink-soft); text-decoration: line-through; }
  table.src-table tr.blocked-by-parent td.host { color: var(--ink-soft); font-style: italic; }
  table.src-table form { display: inline; }
  table.src-table button {
    padding: 4px 10px; font: inherit; font-family: var(--sans); font-size: 12px;
    background: #fff; color: var(--ink); border: 1px solid var(--rule); cursor: pointer;
  }
  table.src-table button:hover { border-color: var(--ink); }
  table.src-table button.block { color: #8a2a2a; border-color: #d4a4a4; }
  table.src-table button.block:hover { background: #fbeeee; border-color: #8a2a2a; }
  table.src-table button.unblock { color: #2b4f2b; border-color: #9bc79b; }
  table.src-table button.unblock:hover { background: #e6f3e6; border-color: #2b4f2b; }
  table.src-table .pill { display: inline-block; font-family: var(--sans); font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; padding: 1px 6px; border-radius: 2px; }
  table.src-table .pill.blocked { background: #fbe8e8; color: #8a2a2a; }
  table.src-table .pill.parent { background: #fff5d1; color: #6a5200; }
  table.src-table th a { color: inherit; text-decoration: none; cursor: pointer; }
  table.src-table th a:hover { color: var(--ink); }
  table.src-table th a.sorted { color: var(--ink); }
  table.src-table input[type="checkbox"] { width: 16px; height: 16px; vertical-align: middle; cursor: pointer; }
  .bulk-bar {
    display: flex; flex-wrap: wrap; gap: 10px; align-items: center;
    background: #fff; border: 1px solid var(--rule); padding: 10px 14px;
    margin: 0 0 0; border-bottom: 0; font-family: var(--sans); font-size: 13px;
  }
  .bulk-bar .count { color: var(--ink-soft); font-variant-numeric: tabular-nums; }
  .bulk-bar input.reason { padding: 5px 8px; border: 1px solid var(--rule); font: inherit; font-size: 13px; background: var(--paper); flex: 1 1 220px; min-width: 180px; max-width: 320px; }
  .bulk-bar button {
    padding: 5px 12px; font: inherit; font-family: var(--sans); font-size: 13px;
    background: #8a2a2a; color: #fff; border: 1px solid #8a2a2a; cursor: pointer;
  }
  .bulk-bar button:disabled { opacity: 0.5; cursor: not-allowed; }
  .bulk-bar button:not(:disabled):hover { background: #6a1a1a; }
  .bulk-bar .spacer { flex: 1; }

  .flash { padding: 10px 14px; margin: 0 0 16px; font-family: var(--sans); font-size: 14px; border: 1px solid var(--rule); }
  .flash.ok { background: #e6f3e6; border-color: #9bc79b; color: #2b4f2b; }
  .flash.err { background: #fbeeee; border-color: #d4a4a4; color: #8a2a2a; }
`;

// Generate the link for clicking a column header. Click an unsorted
// column → sort it desc (numeric default) or asc (host alpha). Click
// the already-sorted column → flip direction.
function hostSortHref(
  data: SourcesData,
  col: HostSortKey,
): { href: string; sorted: boolean; arrow: string } {
  const sorted = data.sort === col;
  const defaultDir: HostSortDir = col === "host" ? "asc" : "desc";
  const nextDir: HostSortDir = sorted
    ? data.dir === "asc"
      ? "desc"
      : "asc"
    : defaultDir;
  const params = new URLSearchParams({
    window: String(data.windowDays),
    sort: col,
    dir: nextDir,
  });
  const arrow = !sorted ? "" : data.dir === "asc" ? " ↑" : " ↓";
  return {
    href: `/admin/sources?${params.toString()}#hosts-seen`,
    sorted,
    arrow,
  };
}

const HostHeaderLink: FC<{
  data: SourcesData;
  col: HostSortKey;
  label: string;
}> = ({ data, col, label }) => {
  const { href, sorted, arrow } = hostSortHref(data, col);
  return (
    <a href={href} class={sorted ? "sorted" : ""}>
      {label}
      {arrow}
    </a>
  );
};

export const AdminSources: FC<{ data: SourcesData }> = ({ data }) => (
  <Layout title="Sources — Blurpadurp admin">
    <style dangerouslySetInnerHTML={{ __html: STYLES }} />
    <AdminNav current="sources" />
    <AdminCrumbs trail={[{ label: "Sources" }]} />
    <h2>Sources</h2>

    {data.flash !== null ? (
      <div class={`flash ${data.flash.kind}`}>{data.flash.msg}</div>
    ) : null}

    <p style="font-family: var(--sans); font-size: 13px; color: var(--ink-soft); margin: 0 0 14px;">
      Blocked hosts are dropped at the ingest boundary — no embedding,
      no scoring spend. Subdomain rollup means blocking{" "}
      <code>foo.com</code> also blocks <code>blog.foo.com</code>.
    </p>

    <h3 style="font-family: var(--sans); font-size: 14px; margin: 24px 0 6px;">
      Blocklist ({data.blocklist.length})
    </h3>
    <form method="post" action="/admin/sources/block" class="src-add">
      <div>
        <label for="host">Host</label>
        <input
          id="host"
          name="host"
          type="text"
          placeholder="example.com"
          required
        />
      </div>
      <div>
        <label for="reason">Reason (optional)</label>
        <input
          id="reason"
          name="reason"
          class="reason"
          type="text"
          placeholder="tabloid / mistranslated / etc."
        />
      </div>
      <button type="submit">Add to blocklist</button>
    </form>

    {data.blocklist.length === 0 ? (
      <p style="color: var(--ink-soft); font-style: italic; margin: 0 0 24px;">
        No hosts blocked yet.
      </p>
    ) : (
      <div class="adm-scroll">
        <table class="src-table">
          <thead>
            <tr>
              <th>Host</th>
              <th>Reason</th>
              <th>Blocked</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.blocklist.map((b) => (
              <tr>
                <td class="host">{b.host}</td>
                <td>{b.reason ?? "—"}</td>
                <td>
                  {b.blockedAt.toISOString().replace("T", " ").slice(0, 16)}Z
                </td>
                <td>
                  <form
                    method="post"
                    action="/admin/sources/unblock"
                    data-confirm={`Unblock ${b.host}? It will start ingesting again.`}
                  >
                    <input type="hidden" name="host" value={b.host} />
                    <button type="submit" class="unblock">
                      unblock
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}

    <h3
      id="hosts-seen"
      style="font-family: var(--sans); font-size: 14px; margin: 32px 0 6px;"
    >
      Hosts seen — last {data.windowDays} days
    </h3>
    <form method="get" action="/admin/sources" class="src-filter">
      <div>
        <label for="window">Window</label>
        <select id="window" name="window">
          {[7, 14, 30, 60, 90].map((d) => (
            <option value={String(d)} selected={data.windowDays === d}>
              {d} days
            </option>
          ))}
        </select>
      </div>
      <input type="hidden" name="sort" value={data.sort} />
      <input type="hidden" name="dir" value={data.dir} />
      <button type="submit">Apply</button>
    </form>

    {data.hosts.length === 0 ? (
      <p style="color: var(--ink-soft); font-style: italic;">
        No hosts ingested in this window.
      </p>
    ) : (
      <>
        {/* Bulk-block form lives standalone; checkboxes inside the
            table tie back via form="bulk-block-form". HTML5 lets the
            inputs be physically nested in the per-row block/unblock
            forms while still belonging to this one for submission. */}
        <form
          method="post"
          action="/admin/sources/block"
          id="bulk-block-form"
          data-confirm="Block selected hosts? Future ingest skips them (and all subdomains)."
        >
          <div class="bulk-bar">
            <input
              type="checkbox"
              id="bulk-toggle"
              data-bulk-toggle
              aria-label="Select all on page"
            />
            <label for="bulk-toggle" style="font-size: 13px; color: var(--ink-soft);">
              select all
            </label>
            <span class="count" data-bulk-count>0 selected</span>
            <input
              type="text"
              class="reason"
              name="reason"
              placeholder="reason (optional, applies to all)"
            />
            <button type="submit" data-bulk-submit disabled>
              Block selected
            </button>
          </div>
        </form>
        <div class="adm-scroll" style="margin-top: 0;">
          <table class="src-table">
            <thead>
              <tr>
                <th style="width: 28px;" />
                <th>
                  <HostHeaderLink data={data} col="host" label="Host" />
                </th>
                <th class="num">
                  <HostHeaderLink data={data} col="ingested" label="Ingested" />
                </th>
                <th class="num">
                  <HostHeaderLink data={data} col="passed" label="Passed" />
                </th>
                <th class="num">
                  <HostHeaderLink data={data} col="passRate" label="Pass rate" />
                </th>
                <th class="num">
                  <HostHeaderLink
                    data={data}
                    col="published"
                    label="Published"
                  />
                </th>
                <th />
              </tr>
            </thead>
            <tbody>
            {data.hosts.map((h) => {
              const passRate =
                h.ingested > 0 ? (h.passed / h.ingested) * 100 : 0;
              const rowClass = h.isBlocked
                ? "blocked"
                : h.blockedByParent !== null
                  ? "blocked-by-parent"
                  : "";
              const selectable =
                !h.isBlocked && h.blockedByParent === null;
              return (
                <tr class={rowClass}>
                  <td>
                    {selectable ? (
                      <input
                        type="checkbox"
                        name="host"
                        value={h.host}
                        form="bulk-block-form"
                        data-bulk-row
                        aria-label={`select ${h.host}`}
                      />
                    ) : null}
                  </td>
                  <td class="host">
                    {h.host}
                    {h.isBlocked ? (
                      <span class="pill blocked" style="margin-left:6px;">
                        blocked
                      </span>
                    ) : h.blockedByParent !== null ? (
                      <span
                        class="pill parent"
                        style="margin-left:6px;"
                        title={`covered by ${h.blockedByParent}`}
                      >
                        via {h.blockedByParent}
                      </span>
                    ) : null}
                  </td>
                  <td class="num">{h.ingested}</td>
                  <td class="num">{h.passed}</td>
                  <td class="num">{passRate.toFixed(0)}%</td>
                  <td class="num">{h.published}</td>
                  <td>
                    {h.isBlocked ? (
                      <form
                        method="post"
                        action="/admin/sources/unblock"
                        data-confirm={`Unblock ${h.host}?`}
                      >
                        <input type="hidden" name="host" value={h.host} />
                        <button type="submit" class="unblock">
                          unblock
                        </button>
                      </form>
                    ) : h.blockedByParent !== null ? (
                      <span style="color: var(--ink-soft); font-size: 12px; font-family: var(--sans);">
                        —
                      </span>
                    ) : (
                      <form
                        method="post"
                        action="/admin/sources/block"
                        data-confirm={`Block ${h.host}? Future ingest skips it.`}
                      >
                        <input type="hidden" name="host" value={h.host} />
                        <button type="submit" class="block">
                          block
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      </>
    )}
    <script src="/assets/admin-review.js" defer />
    <script src="/assets/admin-sources.js" defer />
  </Layout>
);

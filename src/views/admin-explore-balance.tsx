// Category balance dashboard. Are we drowning in politics while
// economy and society starve? This page shows the distribution of
// ingested → scored → passed → published by category over a window,
// plus a per-week stacked passers view so trends are visible.
//
// HHI (Herfindahl–Hirschman index) summarizes concentration in a
// single number: 0 = perfectly diversified, 1 = one category owns
// everything. Useful as a single dial when tuning category prompts.

import type { FC } from "hono/jsx";

import { Layout } from "./layout.tsx";
import { AdminCrumbs, AdminNav } from "./admin-nav.tsx";
import { ExplorerNav } from "./admin-explore.tsx";

export interface BalanceFilter {
  windowWeeks: number;
}

export interface BalanceData {
  filter: BalanceFilter;
  byCategory: Array<{
    category: string;
    ingested: number;
    scored: number;
    passed: number;
    published: number;
  }>;
  weekly: Array<{
    week: string;
    counts: Record<string, number>;
  }>;
  categories: string[];
  hhi: number;
  totalPassed: number;
}

const STYLES = `
  .b-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; margin: 0 0 20px; }
  .b-cell { background: #fff; border: 1px solid var(--rule); padding: 12px 14px; }
  .b-cell .label { font-family: var(--sans); font-size: 11px; color: var(--ink-soft); text-transform: uppercase; letter-spacing: 0.04em; }
  .b-cell .value { font-family: var(--sans); font-size: 24px; font-weight: 600; font-variant-numeric: tabular-nums; margin-top: 4px; }
  .b-cell .sub { font-family: var(--sans); font-size: 11px; color: var(--ink-soft); margin-top: 2px; }
  .b-filter { display: flex; flex-wrap: wrap; gap: 10px; align-items: end; background: #fff; border: 1px solid var(--rule); padding: 12px 14px; margin: 0 0 16px; }
  .b-filter label { display: block; font-family: var(--sans); font-size: 11px; color: var(--ink-soft); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 3px; }
  .b-filter select { padding: 6px 8px; border: 1px solid var(--rule); font: inherit; font-size: 13px; background: var(--paper); }
  .b-filter button { padding: 6px 14px; background: var(--ink); color: var(--paper); border: none; font-family: var(--sans); font-size: 13px; cursor: pointer; }
  .b-table { width: 100%; border-collapse: collapse; font-size: 13px; min-width: 720px; }
  .b-table th, .b-table td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--rule); }
  .b-table th { font-family: var(--sans); font-size: 11px; color: var(--ink-soft); text-transform: uppercase; letter-spacing: 0.04em; }
  .b-table td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .b-bar { display: inline-block; height: 9px; background: #4a6b4a; vertical-align: middle; margin-left: 6px; opacity: 0.85; min-width: 1px; }
  .b-stacked-wrap { background: #fff; border: 1px solid var(--rule); padding: 14px 16px; margin: 0 0 24px; overflow-x: auto; }
  .b-stacked { display: flex; align-items: flex-end; gap: 4px; min-height: 200px; padding: 8px 0 0; }
  .b-week { display: flex; flex-direction: column-reverse; flex: 1 1 30px; min-width: 24px; gap: 1px; }
  .b-week-label { font-family: var(--sans); font-size: 10px; color: var(--ink-soft); margin-top: 4px; text-align: center; transform: rotate(-30deg); transform-origin: top center; height: 24px; }
  .b-seg { width: 100%; }
  .b-legend { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 14px; font-family: var(--sans); font-size: 12px; color: var(--ink-soft); }
  .b-legend .swatch { display: inline-block; width: 12px; height: 12px; vertical-align: middle; margin-right: 4px; }
`;

// 12-color palette, ordered for category contrast on stacks.
const PALETTE = [
  "#4a6b4a",
  "#7a4a8c",
  "#c08a3e",
  "#3a6b8c",
  "#a63a3a",
  "#5a8c3e",
  "#8c5a3e",
  "#3a8c8c",
  "#8c3a6b",
  "#6b6b3a",
  "#3a3a8c",
  "#8c8c3a",
];
const colorFor = (cat: string, all: string[]): string => {
  const idx = all.indexOf(cat);
  return PALETTE[((idx >= 0 ? idx : 0) % PALETTE.length)] ?? "#888";
};

export const AdminExploreBalance: FC<{ data: BalanceData }> = ({ data }) => {
  const total = data.byCategory.reduce(
    (a, c) => ({
      ingested: a.ingested + c.ingested,
      scored: a.scored + c.scored,
      passed: a.passed + c.passed,
      published: a.published + c.published,
    }),
    { ingested: 0, scored: 0, passed: 0, published: 0 },
  );
  const weekMax = Math.max(
    1,
    ...data.weekly.map((w) =>
      Object.values(w.counts).reduce((a, b) => a + b, 0),
    ),
  );
  const concentration =
    data.hhi < 0.18
      ? "diversified"
      : data.hhi < 0.25
        ? "moderate"
        : "concentrated";

  return (
    <Layout title="Balance — Explorer">
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      <AdminNav current="explore" />
      <AdminCrumbs
        trail={[
          { label: "Explorer", href: "/admin/explore" },
          { label: "Balance" },
        ]}
      />
      <h2>Category balance</h2>
      <ExplorerNav current="balance" />

      <form method="get" action="/admin/explore/balance" class="b-filter">
        <div>
          <label for="window">Window</label>
          <select id="window" name="window">
            {[4, 8, 12, 26, 52].map((w) => (
              <option value={String(w)} selected={data.filter.windowWeeks === w}>
                {w} weeks
              </option>
            ))}
          </select>
        </div>
        <button type="submit">Apply</button>
      </form>

      <div class="b-grid">
        <div class="b-cell">
          <div class="label">Categories represented</div>
          <div class="value">{data.byCategory.length}</div>
          <div class="sub">
            of {data.categories.length} ever seen this window
          </div>
        </div>
        <div class="b-cell">
          <div class="label">Total passers</div>
          <div class="value">{data.totalPassed.toLocaleString()}</div>
          <div class="sub">last {data.filter.windowWeeks} weeks</div>
        </div>
        <div class="b-cell">
          <div class="label">HHI (passers)</div>
          <div class="value">{(data.hhi * 100).toFixed(0)}</div>
          <div class="sub">{concentration} (lower = better balance)</div>
        </div>
      </div>

      <div class="adm-scroll" style="margin-bottom: 24px;">
        <table class="b-table">
          <thead>
            <tr>
              <th>Category</th>
              <th class="num">Ingested</th>
              <th class="num">Scored</th>
              <th class="num">Passed</th>
              <th class="num">% of passers</th>
              <th class="num">Published</th>
              <th>Share</th>
            </tr>
          </thead>
          <tbody>
            {data.byCategory.map((c) => {
              const pct = data.totalPassed > 0
                ? (c.passed / data.totalPassed) * 100
                : 0;
              const barWidth = Math.min(220, pct * 4);
              return (
                <tr>
                  <td>
                    <span
                      style={`display:inline-block;width:10px;height:10px;background:${colorFor(c.category, data.categories)};margin-right:6px;vertical-align:middle;`}
                    />
                    {c.category}
                  </td>
                  <td class="num">{c.ingested}</td>
                  <td class="num">{c.scored}</td>
                  <td class="num">{c.passed}</td>
                  <td class="num">{pct.toFixed(1)}%</td>
                  <td class="num">{c.published}</td>
                  <td>
                    <span
                      class="b-bar"
                      style={`width:${barWidth.toFixed(0)}px;background:${colorFor(c.category, data.categories)};`}
                    />
                  </td>
                </tr>
              );
            })}
            <tr style="border-top: 2px solid var(--rule); font-weight: 600;">
              <td>Total</td>
              <td class="num">{total.ingested}</td>
              <td class="num">{total.scored}</td>
              <td class="num">{total.passed}</td>
              <td class="num">100%</td>
              <td class="num">{total.published}</td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>

      <h3
        style="font-family: var(--sans); font-size: 15px; margin: 0 0 8px; font-weight: 600;"
      >
        Passers per week × category
      </h3>
      <div class="b-stacked-wrap">
        <div class="b-stacked">
          {data.weekly.map((w) => {
            const total = Object.values(w.counts).reduce((a, b) => a + b, 0);
            const heightTotal = (total / weekMax) * 180;
            return (
              <div class="b-week" title={`${w.week}: ${total} passers`}>
                <div class="b-week-label">{w.week.slice(5)}</div>
                {data.categories.map((cat) => {
                  const n = w.counts[cat] ?? 0;
                  if (n === 0) return null;
                  const h = (n / weekMax) * 180;
                  return (
                    <div
                      class="b-seg"
                      style={`height:${h.toFixed(1)}px;background:${colorFor(cat, data.categories)};`}
                      title={`${cat}: ${n}`}
                    />
                  );
                })}
                {total === 0 ? (
                  <div style="height: 1px; background: var(--rule);" />
                ) : null}
              </div>
            );
          })}
        </div>
        <div class="b-legend">
          {data.categories.map((cat) => (
            <span>
              <span
                class="swatch"
                style={`background:${colorFor(cat, data.categories)};`}
              />
              {cat}
            </span>
          ))}
        </div>
      </div>
    </Layout>
  );
};

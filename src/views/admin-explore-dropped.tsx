// Drop-reasons explorer. "Dropped" = scored AND NOT passed AND NOT
// early-rejected — the borderline misses. The page surfaces:
//   - distribution of dropped composites (how close to the gate?)
//   - which penalty factors most often appear on dropped stories
//   - per-category drop rate
//   - a list of the highest-composite drops (stories that almost made it)
//
// Goal: surface tuning levers. If a single penalty factor dominates,
// the operator may want to soften its weight; if a category has a
// 95% drop rate, the prompt may be miscalibrated for that beat.

import type { FC } from "hono/jsx";
import { Layout } from "./layout.tsx";
import { AdminCrumbs, AdminNav } from "./admin-nav.tsx";
import { ExplorerNav } from "./admin-explore.tsx";
import { HBar, Histogram, mean, quantiles } from "./charts.tsx";

export interface DroppedFilter {
  windowDays: number;
  category?: string;
}

export interface DroppedData {
  filter: DroppedFilter;
  categories: string[];
  totals: {
    scored: number;
    passed: number;
    dropped: number;
    early_rejected: number;
  };
  composites: {
    dropped: number[];
    passed: number[];
  };
  components: {
    dropped: { zeitgeist: number; halfLife: number; reach: number; nonObviousness: number; structural: number };
    passed: { zeitgeist: number; halfLife: number; reach: number; nonObviousness: number; structural: number };
  };
  penaltiesOnDropped: Array<{ label: string; value: number; sublabel?: string }>;
  byCategory: Array<{
    category: string;
    scored: number;
    passed: number;
    dropped: number;
    dropRate: number;
  }>;
  topDrops: Array<{
    id: number;
    title: string;
    category: string | null;
    composite: number;
    confidence: string | null;
    factors: string[];
  }>;
}

const STYLES = `
  .d-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin: 0 0 20px; }
  .d-cell { background: #fff; border: 1px solid var(--rule); padding: 12px 14px; }
  .d-cell .label { font-family: var(--sans); font-size: 11px; color: var(--ink-soft); text-transform: uppercase; letter-spacing: 0.04em; }
  .d-cell .value { font-family: var(--sans); font-size: 24px; font-weight: 600; font-variant-numeric: tabular-nums; margin-top: 4px; }
  .d-cell .sub { font-family: var(--sans); font-size: 11px; color: var(--ink-soft); margin-top: 2px; }
  .d-panels { display: grid; grid-template-columns: repeat(auto-fit, minmax(330px, 1fr)); gap: 14px; margin: 0 0 24px; }
  .d-panel { background: #fff; border: 1px solid var(--rule); padding: 14px 16px; }
  .d-panel h3 { font-family: var(--sans); font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--ink-soft); margin: 0 0 10px; font-weight: 600; }
  .d-panel .stat-line { font-family: var(--sans); font-size: 12px; color: var(--ink-soft); margin-top: 6px; font-variant-numeric: tabular-nums; }
  .d-filter { display: flex; flex-wrap: wrap; gap: 10px; align-items: end; background: #fff; border: 1px solid var(--rule); padding: 12px 14px; margin: 0 0 16px; }
  .d-filter label { display: block; font-family: var(--sans); font-size: 11px; color: var(--ink-soft); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 3px; }
  .d-filter select, .d-filter input { padding: 6px 8px; border: 1px solid var(--rule); font: inherit; font-size: 13px; background: var(--paper); }
  .d-filter button { padding: 6px 14px; background: var(--ink); color: var(--paper); border: none; font-family: var(--sans); font-size: 13px; cursor: pointer; }
  .d-cmp { width: 100%; border-collapse: collapse; font-size: 13px; }
  .d-cmp th, .d-cmp td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--rule); }
  .d-cmp th { font-family: var(--sans); font-size: 11px; color: var(--ink-soft); text-transform: uppercase; letter-spacing: 0.04em; }
  .d-cmp td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .d-cmp .delta-up { color: #4a6b4a; }
  .d-cmp .delta-down { color: #a63a3a; }
  .d-rate { width: 100%; border-collapse: collapse; font-size: 13px; }
  .d-rate th, .d-rate td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--rule); }
  .d-rate th { font-family: var(--sans); font-size: 11px; color: var(--ink-soft); text-transform: uppercase; letter-spacing: 0.04em; }
  .d-rate td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .d-rate .bar { height: 6px; background: rgba(166,58,58,0.15); border-left: 3px solid #a63a3a; }
  .top-drops { width: 100%; border-collapse: collapse; font-size: 13px; min-width: 720px; }
  .top-drops th, .top-drops td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--rule); vertical-align: top; }
  .top-drops th { font-family: var(--sans); font-size: 11px; color: var(--ink-soft); text-transform: uppercase; letter-spacing: 0.04em; }
  .top-drops td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .top-drops .chip { display: inline-block; padding: 1px 6px; border-radius: 2px; font-family: var(--sans); font-size: 10px; margin-right: 3px; background: rgba(166,58,58,0.12); color: #7a2a2a; }
`;

const ComponentTable: FC<{
  dropped: DroppedData["components"]["dropped"];
  passed: DroppedData["components"]["passed"];
}> = ({ dropped, passed }) => {
  const rows: Array<{ key: keyof DroppedData["components"]["dropped"]; label: string }> = [
    { key: "zeitgeist", label: "Zeitgeist" },
    { key: "halfLife", label: "Half-life" },
    { key: "reach", label: "Reach" },
    { key: "nonObviousness", label: "Non-obvious" },
    { key: "structural", label: "Structural" },
  ];
  return (
    <table class="d-cmp">
      <thead>
        <tr>
          <th>Component</th>
          <th class="num">Dropped (mean)</th>
          <th class="num">Passed (mean)</th>
          <th class="num">Δ</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const d = dropped[r.key];
          const p = passed[r.key];
          const delta = p - d;
          return (
            <tr>
              <td>{r.label}</td>
              <td class="num">{d.toFixed(2)}</td>
              <td class="num">{p.toFixed(2)}</td>
              <td class={`num ${delta > 0.5 ? "delta-up" : delta < -0.5 ? "delta-down" : ""}`}>
                {delta >= 0 ? "+" : ""}
                {delta.toFixed(2)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
};

export const AdminExploreDropped: FC<{ data: DroppedData }> = ({ data }) => {
  const passRate = data.totals.scored > 0
    ? (data.totals.passed / data.totals.scored) * 100
    : 0;
  const compP10P50P90Drop = quantiles(data.composites.dropped);
  const compP10P50P90Pass = quantiles(data.composites.passed);

  return (
    <Layout title="Drop reasons — Explorer">
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      <AdminNav current="explore" />
      <AdminCrumbs
        trail={[
          { label: "Explorer", href: "/admin/explore" },
          { label: "Drop reasons" },
        ]}
      />
      <h2>Drop reasons</h2>
      <ExplorerNav current="dropped" />

      <form method="get" action="/admin/explore/dropped" class="d-filter">
        <div>
          <label for="window">Window</label>
          <select id="window" name="window">
            {[7, 14, 30, 60, 90].map((d) => (
              <option value={String(d)} selected={data.filter.windowDays === d}>
                {d} days
              </option>
            ))}
          </select>
        </div>
        <div>
          <label for="category">Category</label>
          <select id="category" name="category">
            <option value="">all</option>
            {data.categories.map((c) => (
              <option value={c} selected={data.filter.category === c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <button type="submit">Filter</button>
      </form>

      <div class="d-grid">
        <div class="d-cell">
          <div class="label">Scored</div>
          <div class="value">{data.totals.scored.toLocaleString()}</div>
          <div class="sub">{data.filter.windowDays}-day window</div>
        </div>
        <div class="d-cell">
          <div class="label">Passed</div>
          <div class="value">{data.totals.passed.toLocaleString()}</div>
          <div class="sub">{passRate.toFixed(1)}% of scored</div>
        </div>
        <div class="d-cell">
          <div class="label">Dropped</div>
          <div class="value">{data.totals.dropped.toLocaleString()}</div>
          <div class="sub">scored, gate failed</div>
        </div>
        <div class="d-cell">
          <div class="label">Early rejected</div>
          <div class="value">{data.totals.early_rejected.toLocaleString()}</div>
          <div class="sub">never scored</div>
        </div>
      </div>

      <div class="d-panels">
        <div class="d-panel">
          <h3>Composite — dropped</h3>
          <Histogram data={data.composites.dropped} min={0} max={25} />
          <div class="stat-line">
            n={data.composites.dropped.length} · mean{" "}
            {mean(data.composites.dropped).toFixed(2)} · p10/p50/p90{" "}
            {compP10P50P90Drop[0]!.toFixed(0)}/{compP10P50P90Drop[1]!.toFixed(0)}/
            {compP10P50P90Drop[2]!.toFixed(0)}
          </div>
        </div>
        <div class="d-panel">
          <h3>Composite — passed</h3>
          <Histogram data={data.composites.passed} min={0} max={25} />
          <div class="stat-line">
            n={data.composites.passed.length} · mean{" "}
            {mean(data.composites.passed).toFixed(2)} · p10/p50/p90{" "}
            {compP10P50P90Pass[0]!.toFixed(0)}/{compP10P50P90Pass[1]!.toFixed(0)}/
            {compP10P50P90Pass[2]!.toFixed(0)}
          </div>
        </div>
        <div class="d-panel">
          <h3>Component score gap</h3>
          <ComponentTable
            dropped={data.components.dropped}
            passed={data.components.passed}
          />
          <div class="stat-line">
            Where dropped stories under-perform passed ones. Big positive
            Δ = the gate's load-bearing axis.
          </div>
        </div>
        <div class="d-panel">
          <h3>Penalty factors on dropped</h3>
          {data.penaltiesOnDropped.length === 0 ? (
            <p>
              <em>No penalty factors recorded.</em>
            </p>
          ) : (
            <HBar items={data.penaltiesOnDropped} />
          )}
        </div>
      </div>

      <h3
        style="font-family: var(--sans); font-size: 15px; margin: 24px 0 4px; font-weight: 600;"
      >
        Per-category drop rate
      </h3>
      <p style="font-family: var(--sans); font-size: 13px; color: var(--ink-soft); margin: 0 0 8px;">
        High drop rates may indicate mis-calibrated rubric for that
        category, or an oversampled source feed.
      </p>
      <div class="adm-scroll">
        <table class="d-rate">
          <thead>
            <tr>
              <th>Category</th>
              <th class="num">Scored</th>
              <th class="num">Passed</th>
              <th class="num">Dropped</th>
              <th class="num">Drop rate</th>
            </tr>
          </thead>
          <tbody>
            {data.byCategory.map((c) => (
              <tr>
                <td>{c.category}</td>
                <td class="num">{c.scored}</td>
                <td class="num">{c.passed}</td>
                <td class="num">{c.dropped}</td>
                <td class="num">{(c.dropRate * 100).toFixed(0)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3
        style="font-family: var(--sans); font-size: 15px; margin: 28px 0 4px; font-weight: 600;"
      >
        Top drops — closest to the gate
      </h3>
      <p style="font-family: var(--sans); font-size: 13px; color: var(--ink-soft); margin: 0 0 8px;">
        Highest-composite stories that didn't pass. If you'd have
        included them, the gate is too strict.
      </p>
      <div class="adm-scroll">
        <table class="top-drops">
          <thead>
            <tr>
              <th>Title</th>
              <th>Cat</th>
              <th class="num">Comp</th>
              <th>Conf</th>
              <th>Penalty factors</th>
            </tr>
          </thead>
          <tbody>
            {data.topDrops.map((s) => (
              <tr>
                <td>
                  <a href={`/admin/explore/story/${s.id}`}>{s.title}</a>
                </td>
                <td>{s.category ?? "—"}</td>
                <td class="num">{s.composite.toFixed(0)}</td>
                <td>{s.confidence ?? "—"}</td>
                <td>
                  {s.factors.length === 0
                    ? "—"
                    : s.factors.map((f) => <span class="chip">{f}</span>)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Layout>
  );
};

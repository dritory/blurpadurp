// Admin data explorer landing. One-screen overview of what the scorer
// and pipeline have produced: corpus counts, score distributions,
// factor-tag frequencies, per-day activity, per-source and per-category
// breakdowns. Designed to answer "what is the algorithm actually doing?"
// without opening a SQL client.

import type { FC } from "hono/jsx";
import { Layout } from "./layout.tsx";
import { AdminNav } from "./admin-nav.tsx";
import { HBar, Histogram, Timeline, mean, quantiles } from "./charts.tsx";

export interface ExplorerData {
  corpus: {
    total: number;
    ingested_last_30d: number;
    scored: number;
    scored_last_30d: number;
    passed: number;
    passed_last_30d: number;
    early_rejected: number;
    published: number;
    themes: number;
    issues: number;
  };
  composites: number[];
  zeitgeist: number[];
  halfLife: number[];
  reach: number[];
  nonObviousness: number[];
  structural: number[];
  perDay: Array<{ day: string; count: number; passed: number }>;
  triggers: Array<{ label: string; value: number; sublabel?: string }>;
  penalties: Array<{ label: string; value: number; sublabel?: string }>;
  uncertainties: Array<{ label: string; value: number; sublabel?: string }>;
  byCategory: Array<{ label: string; value: number; sublabel?: string }>;
  byConfidence: Array<{ label: string; value: number; sublabel?: string }>;
  bySource: Array<{ label: string; value: number; sublabel?: string }>;
}

const STYLES = `
  .x-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin: 16px 0 28px; }
  .x-cell { background: #fff; border: 1px solid var(--rule); padding: 12px 14px; }
  .x-cell .label { font-family: var(--sans); font-size: 11px; color: var(--ink-soft); text-transform: uppercase; letter-spacing: 0.04em; }
  .x-cell .value { font-family: var(--sans); font-size: 24px; font-weight: 600; font-variant-numeric: tabular-nums; margin-top: 4px; }
  .x-cell .sub { font-family: var(--sans); font-size: 11px; color: var(--ink-soft); margin-top: 2px; }

  .x-panels { display: grid; grid-template-columns: repeat(auto-fit, minmax(330px, 1fr)); gap: 16px; margin: 16px 0 28px; }
  .x-panel { background: #fff; border: 1px solid var(--rule); padding: 14px 16px; }
  .x-panel h3 { font-family: var(--sans); font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--ink-soft); margin: 0 0 8px; font-weight: 600; }
  .x-panel .stat-line { font-family: var(--sans); font-size: 12px; color: var(--ink-soft); margin-top: 6px; font-variant-numeric: tabular-nums; }

  .x-sub-nav { display: flex; gap: 10px; font-family: var(--sans); font-size: 13px; margin: 0 0 20px; border-bottom: 1px solid var(--rule); padding-bottom: 10px; flex-wrap: wrap; }
  .x-sub-nav a { text-decoration: none; padding: 8px 14px; min-height: 32px; display: inline-flex; align-items: center; border: 1px solid var(--rule); background: #fff; color: var(--ink); }
  .x-sub-nav a.current { background: var(--ink); color: var(--paper); border-color: var(--ink); }

  @media (max-width: 640px) {
    .x-sub-nav { gap: 6px; }
    .x-sub-nav a { padding: 10px 14px; min-height: 40px; flex: 1 1 auto; justify-content: center; }
    .x-panels { grid-template-columns: 1fr; gap: 12px; }
  }
`;

export const ExplorerNav: FC<{ current: "home" | "stories" | "gate" }> = ({
  current,
}) => (
  <nav class="x-sub-nav" aria-label="Explorer">
    <a href="/admin/explore" class={current === "home" ? "current" : ""}>
      Overview
    </a>
    <a
      href="/admin/explore/stories"
      class={current === "stories" ? "current" : ""}
    >
      Stories
    </a>
    <a
      href="/admin/explore/gate"
      class={current === "gate" ? "current" : ""}
    >
      Gate sandbox
    </a>
  </nav>
);

const Cell: FC<{ label: string; value: string | number; sub?: string }> = ({
  label,
  value,
  sub,
}) => (
  <div class="x-cell">
    <div class="label">{label}</div>
    <div class="value">{value}</div>
    {sub !== undefined ? <div class="sub">{sub}</div> : null}
  </div>
);

const ScorePanel: FC<{ title: string; values: number[]; max: number }> = ({
  title,
  values,
  max,
}) => {
  const [p10, p50, p90] = quantiles(values);
  const mn = mean(values);
  return (
    <div class="x-panel">
      <h3>{title}</h3>
      <Histogram data={values} min={0} max={max} />
      <div class="stat-line">
        n={values.length} · mean {mn.toFixed(2)} · p10/p50/p90 {p10!.toFixed(0)}/
        {p50!.toFixed(0)}/{p90!.toFixed(0)}
      </div>
    </div>
  );
};

export const AdminExplore: FC<{ data: ExplorerData }> = ({ data }) => (
  <Layout title="Explorer — Blurpadurp admin">
    <style dangerouslySetInnerHTML={{ __html: STYLES }} />
    <AdminNav current="explore" />
    <h2>Explorer</h2>
    <ExplorerNav current="home" />

    <div class="x-grid">
      <Cell
        label="Stories (total)"
        value={data.corpus.total}
        sub={`${data.corpus.ingested_last_30d} in last 30d`}
      />
      <Cell
        label="Scored"
        value={data.corpus.scored}
        sub={`${data.corpus.scored_last_30d} in last 30d`}
      />
      <Cell
        label="Passed gate"
        value={data.corpus.passed}
        sub={`${data.corpus.passed_last_30d} in last 30d`}
      />
      <Cell
        label="Early rejected"
        value={data.corpus.early_rejected}
      />
      <Cell label="Published" value={data.corpus.published} />
      <Cell label="Themes" value={data.corpus.themes} />
      <Cell label="Issues" value={data.corpus.issues} />
    </div>

    <div class="x-panel" style="margin: 0 0 20px;">
      <h3>Scored / passed per day (last 30)</h3>
      <Timeline days={data.perDay} />
      <div class="stat-line">
        dark = scored · green = passed the gate
      </div>
    </div>

    <h3
      style="font-family: var(--sans); font-size: 15px; margin: 24px 0 4px; font-weight: 600;"
    >
      Score distributions (last 30d, scored only)
    </h3>
    <div class="x-panels">
      <ScorePanel title="Composite" values={data.composites} max={25} />
      <ScorePanel title="Zeitgeist" values={data.zeitgeist} max={5} />
      <ScorePanel title="Half-life" values={data.halfLife} max={5} />
      <ScorePanel title="Reach" values={data.reach} max={5} />
      <ScorePanel title="Non-obviousness" values={data.nonObviousness} max={5} />
      <ScorePanel title="Structural" values={data.structural} max={5} />
    </div>

    <h3
      style="font-family: var(--sans); font-size: 15px; margin: 24px 0 4px; font-weight: 600;"
    >
      Factors and classifications
    </h3>
    <div class="x-panels">
      <div class="x-panel">
        <h3>Top trigger factors</h3>
        {data.triggers.length === 0 ? (
          <p>
            <em>No trigger factors yet.</em>
          </p>
        ) : (
          <HBar items={data.triggers} />
        )}
      </div>
      <div class="x-panel">
        <h3>Top penalty factors</h3>
        {data.penalties.length === 0 ? (
          <p>
            <em>No penalty factors yet.</em>
          </p>
        ) : (
          <HBar items={data.penalties} />
        )}
      </div>
      <div class="x-panel">
        <h3>Top uncertainty factors</h3>
        {data.uncertainties.length === 0 ? (
          <p>
            <em>No uncertainty factors yet.</em>
          </p>
        ) : (
          <HBar items={data.uncertainties} />
        )}
      </div>
      <div class="x-panel">
        <h3>By category (total / passed)</h3>
        {data.byCategory.length === 0 ? (
          <p>
            <em>No scored categories yet.</em>
          </p>
        ) : (
          <HBar items={data.byCategory} />
        )}
      </div>
      <div class="x-panel">
        <h3>By confidence</h3>
        {data.byConfidence.length === 0 ? (
          <p>
            <em>No confidence data yet.</em>
          </p>
        ) : (
          <HBar items={data.byConfidence} />
        )}
      </div>
      <div class="x-panel">
        <h3>By source (last 30d)</h3>
        {data.bySource.length === 0 ? (
          <p>
            <em>No ingested sources yet.</em>
          </p>
        ) : (
          <HBar items={data.bySource} />
        )}
      </div>
    </div>
  </Layout>
);

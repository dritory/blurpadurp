import type { FC } from "hono/jsx";
import { Layout } from "./layout.tsx";
import { AdminNav } from "./admin-nav.tsx";

export interface DayStageRow {
  day: string; // YYYY-MM-DD (UTC)
  stage: string;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export interface StageTotal {
  stage: string;
  calls: number;
  costUsd: number;
}

export interface CostDashboardData {
  // Last 14 days of spend, newest first.
  daily: Array<{
    day: string;
    calls: number;
    costUsd: number;
    byStage: Record<string, number>; // stage → cost
  }>;
  stageTotals: StageTotal[];
  todaySpend: number;
  dailyCap: number | null;
  knownStages: string[];
}

const ADMIN_STYLES = `
  table.fx { width: 100%; border-collapse: collapse; font-size: 14px; }
  table.fx th, table.fx td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--rule); }
  table.fx th { font-family: var(--sans); font-weight: 600; font-size: 12px; color: var(--ink-soft); text-transform: uppercase; letter-spacing: 0.04em; }
  table.fx td.num, table.fx th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .headline-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin: 12px 0 24px; }
  .headline-cell { background: #fff; border: 1px solid var(--rule); padding: 12px 16px; }
  .headline-cell .label { font-family: var(--sans); font-size: 12px; color: var(--ink-soft); text-transform: uppercase; letter-spacing: 0.04em; }
  .headline-cell .value { font-family: var(--sans); font-size: 24px; font-weight: 600; font-variant-numeric: tabular-nums; margin-top: 4px; }
  .headline-cell.warn .value { color: var(--flash-err); }
  .bar { display: inline-block; height: 8px; background: var(--accent); opacity: 0.7; }
`;

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

export const AdminCosts: FC<{ data: CostDashboardData }> = ({ data }) => {
  const capPct = data.dailyCap !== null && data.dailyCap > 0
    ? Math.min(100, Math.round((data.todaySpend / data.dailyCap) * 100))
    : null;
  const overBudget =
    data.dailyCap !== null && data.todaySpend >= data.dailyCap;
  // Compute a bar scale: the largest daily spend in the window sets the
  // bar width for all days.
  const maxDaily = data.daily.reduce((m, d) => Math.max(m, d.costUsd), 0);

  return (
    <Layout title="Costs — Blurpadurp admin">
      <style dangerouslySetInnerHTML={{ __html: ADMIN_STYLES }} />
      <AdminNav current="costs" />
      <h2>Costs</h2>

      <div class="headline-row">
        <div class={`headline-cell ${overBudget ? "warn" : ""}`}>
          <div class="label">Today (UTC)</div>
          <div class="value">{fmtUsd(data.todaySpend)}</div>
        </div>
        <div class="headline-cell">
          <div class="label">Daily cap</div>
          <div class="value">
            {data.dailyCap === null ? "—" : fmtUsd(data.dailyCap)}
          </div>
        </div>
        <div class="headline-cell">
          <div class="label">Budget used</div>
          <div class="value">{capPct === null ? "—" : `${capPct}%`}</div>
        </div>
      </div>

      <h3>Last 14 days</h3>
      <table class="fx">
        <thead>
          <tr>
            <th>Date</th>
            <th class="num">Calls</th>
            <th class="num">Cost</th>
            <th>Spend</th>
            <th>By stage</th>
          </tr>
        </thead>
        <tbody>
          {data.daily.map((d) => {
            const widthPct =
              maxDaily > 0 ? Math.max(1, Math.round((d.costUsd / maxDaily) * 100)) : 0;
            const stagePieces = Object.entries(d.byStage)
              .sort((a, b) => b[1] - a[1])
              .map(([s, v]) => `${s} ${fmtUsd(v)}`)
              .join(" · ");
            return (
              <tr>
                <td>{d.day}</td>
                <td class="num">{d.calls}</td>
                <td class="num">{fmtUsd(d.costUsd)}</td>
                <td>
                  <span class="bar" style={`width: ${widthPct}%;`}></span>
                </td>
                <td style="color: var(--ink-soft); font-size: 13px;">
                  {stagePieces || "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h3>By stage (14d total)</h3>
      <table class="fx">
        <thead>
          <tr>
            <th>Stage</th>
            <th class="num">Calls</th>
            <th class="num">Cost</th>
          </tr>
        </thead>
        <tbody>
          {data.stageTotals.map((s) => (
            <tr>
              <td>{s.stage}</td>
              <td class="num">{s.calls}</td>
              <td class="num">{fmtUsd(s.costUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Layout>
  );
};

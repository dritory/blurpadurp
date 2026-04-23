import type { FC } from "hono/jsx";
import type { PipelineStatus } from "../api/status.ts";
import { Layout } from "./layout.tsx";
import { AdminNav } from "./admin-nav.tsx";

const ADMIN_STYLES = `
  table.fx { width: 100%; border-collapse: collapse; font-size: 14px; }
  table.fx th, table.fx td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--rule); }
  table.fx th { font-family: var(--sans); font-weight: 600; font-size: 12px; color: var(--ink-soft); text-transform: uppercase; letter-spacing: 0.04em; }
  table.fx td.num { font-variant-numeric: tabular-nums; }
  .ok   { color: #4a6b4a; font-weight: 600; }
  .warn { color: var(--flash-err); font-weight: 600; }
`;

function age(sec: number | null): string {
  if (sec === null) return "never";
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function freshnessClass(sec: number | null, warnAtSec: number): string {
  if (sec === null) return "warn";
  return sec > warnAtSec ? "warn" : "ok";
}

export const AdminStatus: FC<{ s: PipelineStatus }> = ({ s }) => (
  <Layout title="Status — Blurpadurp admin">
    <style dangerouslySetInnerHTML={{ __html: ADMIN_STYLES }} />
    <AdminNav current="status" />
    <h2>Pipeline status</h2>
    <div class="adm-scroll">
    <table class="fx">
      <tbody>
        <tr>
          <td>DB</td>
          <td class={s.db_ok ? "ok" : "warn"}>{s.db_ok ? "reachable" : "unreachable"}</td>
          <td></td>
        </tr>
        <tr>
          <td>Last ingest</td>
          <td class={freshnessClass(s.last_ingest_age_sec, 2 * 24 * 3600)}>
            {age(s.last_ingest_age_sec)}
          </td>
          <td>{s.last_ingest_at?.toISOString().slice(0, 19) ?? "—"}Z</td>
        </tr>
        <tr>
          <td>Last score</td>
          <td class={freshnessClass(s.last_score_age_sec, 2 * 24 * 3600)}>
            {age(s.last_score_age_sec)}
          </td>
          <td>{s.last_score_at?.toISOString().slice(0, 19) ?? "—"}Z</td>
        </tr>
        <tr>
          <td>Last issue</td>
          <td class={freshnessClass(s.last_issue_age_sec, 10 * 24 * 3600)}>
            {age(s.last_issue_age_sec)}
          </td>
          <td>{s.last_issue_at?.toISOString().slice(0, 19) ?? "—"}Z</td>
        </tr>
        <tr>
          <td>Unscored backlog</td>
          <td class={`num ${s.unscored_backlog > 500 ? "warn" : "ok"}`}>
            {s.unscored_backlog}
          </td>
          <td>stories awaiting score</td>
        </tr>
        <tr>
          <td>Today's spend</td>
          <td class="num">${s.today_spend_usd.toFixed(2)}</td>
          <td>
            cap {s.daily_cap_usd === null ? "—" : `$${s.daily_cap_usd.toFixed(2)}`},{" "}
            remaining{" "}
            {s.budget_remaining_usd === null
              ? "—"
              : `$${s.budget_remaining_usd.toFixed(2)}`}
          </td>
        </tr>
      </tbody>
    </table>
    </div>
    <p style="margin-top: 20px; font-family: var(--sans); font-size: 13px; color: var(--ink-soft);">
      JSON version at <a href="/health">/health</a> — cron-friendly.
    </p>
  </Layout>
);

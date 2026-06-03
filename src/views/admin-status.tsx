import type { FC } from "hono/jsx";
import type { PipelineStatus } from "../api/status.ts";
import type { StorageStatus } from "../api/storage-status.ts";
import { Layout } from "./layout.tsx";
import { AdminNav } from "./admin-nav.tsx";

const ADMIN_STYLES = `
  table.fx { width: 100%; border-collapse: collapse; font-size: 14px; }
  table.fx th, table.fx td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--rule); }
  table.fx th { font-family: var(--sans); font-weight: 600; font-size: 12px; color: var(--ink-soft); text-transform: uppercase; letter-spacing: 0.04em; }
  table.fx td.num, table.fx th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .ok   { color: #4a6b4a; font-weight: 600; }
  .warn { color: var(--flash-err); font-weight: 600; }
  .bar { height: 10px; background: #e6e6e6; border: 1px solid var(--rule); position: relative; }
  .bar > span { position: absolute; left: 0; top: 0; bottom: 0; background: #4a6b4a; }
  .bar.warn > span { background: var(--flash-err); }
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

function mb(bytes: number): string {
  const m = bytes / (1024 * 1024);
  if (m >= 100) return `${m.toFixed(0)} MB`;
  if (m >= 1) return `${m.toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} kB`;
}

const StoragePanel: FC<{ st: StorageStatus }> = ({ st }) => {
  const pct = (st.totalBytes / st.capBytes) * 100;
  const usageWarn = pct >= 80;
  const months = st.growth.monthsToCap;
  const monthsWarn = months !== null && months < 6;
  return (
    <>
      <h2 style="margin-top: 28px;">Storage budget</h2>
      <table class="fx" style="max-width: 560px;">
        <tbody>
          <tr>
            <td>Database size</td>
            <td class={`num ${usageWarn ? "warn" : "ok"}`}>
              {mb(st.totalBytes)} / {mb(st.capBytes)}
            </td>
            <td style="width: 40%;">
              <div class={`bar ${usageWarn ? "warn" : ""}`}>
                <span style={`width: ${Math.min(100, pct).toFixed(1)}%`} />
              </div>
            </td>
          </tr>
          <tr>
            <td>Est. growth</td>
            <td class="num">{mb(st.growth.estMonthlyBytes)}/mo</td>
            <td>
              {st.growth.stories30d} stories · {st.growth.aiCalls30d} AI calls
              (30d)
            </td>
          </tr>
          <tr>
            <td>Projected months to cap</td>
            <td class={`num ${monthsWarn ? "warn" : "ok"}`}>
              {months === null ? "—" : months > 600 ? "600+" : months.toFixed(0)}
            </td>
            <td>at current intake + per-row size</td>
          </tr>
          <tr>
            <td>Cold tier</td>
            <td class={st.coldTier.enabled ? "ok" : "warn"}>
              {st.coldTier.enabled ? "on" : "off"}
            </td>
            <td>
              offload &gt; {st.coldTier.ageDays}d · story{" "}
              {st.story.coldStored} cold / {st.story.inlinePayload} inline ·
              ai-log {st.aiCallLog.cold} cold / {st.aiCallLog.inline} inline
            </td>
          </tr>
          <tr>
            <td>Story rows</td>
            <td class="num">{st.story.total}</td>
            <td>
              {st.story.scored} scored · {st.story.unscored} unscored ·{" "}
              {st.story.hasEmbedding} embedded
            </td>
          </tr>
        </tbody>
      </table>

      <h3>Per-table footprint</h3>
      <div class="adm-scroll">
        <table class="fx">
          <thead>
            <tr>
              <th>Table</th>
              <th class="num">Total</th>
              <th class="num">Heap</th>
              <th class="num">Indexes</th>
              <th class="num">TOAST</th>
              <th class="num">Rows</th>
            </tr>
          </thead>
          <tbody>
            {st.tables.map((t) => (
              <tr>
                <td>{t.name}</td>
                <td class="num">{mb(t.totalBytes)}</td>
                <td class="num">{mb(t.heapBytes)}</td>
                <td class="num">{mb(t.indexBytes)}</td>
                <td class="num">{mb(t.toastBytes)}</td>
                <td class="num">{t.rows.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style="font-family: var(--sans); font-size: 12px; color: var(--ink-soft);">
        Row counts are catalog estimates (reltuples). Growth projection
        assumes current intake and per-row size; the cold tier lowers
        per-row bytes over time, so it errs high. See{" "}
        <code>docs/storage.md</code>.
      </p>
    </>
  );
};

export const AdminStatus: FC<{ s: PipelineStatus; storage?: StorageStatus }> = ({
  s,
  storage,
}) => (
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
    {storage ? <StoragePanel st={storage} /> : null}
    <p style="margin-top: 20px; font-family: var(--sans); font-size: 13px; color: var(--ink-soft);">
      JSON version at <a href="/health">/health</a> — cron-friendly.
    </p>
  </Layout>
);

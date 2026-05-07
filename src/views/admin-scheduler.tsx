// Admin scheduler page. Shows the DB-driven schedule + per-stage
// last-fired/last-error/lock state, with inline forms to edit
// interval+enabled, "Run now" (manual trigger), and "Clear lock"
// (force-release a stuck pipeline_lock row).
//
// The actual cron mechanism is one Fly machine, scheduled hourly,
// running `bun run cli scheduler-tick`. Cadence/enabled live in the
// pipeline_schedule table — operator can change them here without
// redeploying.

import type { FC } from "hono/jsx";
import { Layout } from "./layout.tsx";
import { AdminNav } from "./admin-nav.tsx";

export interface SchedulerStageRow {
  stage: string;
  intervalSec: number;
  enabled: boolean;
  lastSuccessAt: Date | null;
  lastSuccessAgeSec: number | null;
  lastAttemptAt: Date | null;
  lastAttemptStatus: string | null;
  lastError: string | null;
  nextDueAt: Date | null;
  lockHeldUntil: Date | null;
}

export interface SchedulerData {
  rows: SchedulerStageRow[];
  flash: { triggered?: string; cleared?: string; saved?: string } | null;
}

const STYLES = `
  table.sched { width: 100%; border-collapse: collapse; font-size: 13px; }
  table.sched th, table.sched td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--rule); vertical-align: middle; }
  table.sched th { font-family: var(--sans); font-weight: 600; font-size: 11px; color: var(--ink-soft); text-transform: uppercase; letter-spacing: 0.04em; }
  table.sched td.num { font-variant-numeric: tabular-nums; }
  .sched-stage { font-family: var(--sans); font-weight: 600; }
  .sched-actions form { display: inline; margin: 0 4px 0 0; }
  .sched-actions button { padding: 3px 9px; font-family: var(--sans); font-size: 12px; background: #fff; border: 1px solid var(--rule); cursor: pointer; }
  .sched-actions button:hover { border-color: var(--ink); }
  .sched-actions button.danger { color: #8a2a2a; border-color: #d4a4a4; }
  .sched-edit input[type=number] { width: 90px; font: inherit; padding: 3px 6px; border: 1px solid var(--rule); }
  .sched-edit { display: flex; gap: 6px; align-items: center; }
  .sched-error { color: var(--flash-err); font-family: ui-monospace, Menlo, monospace; font-size: 11px; max-width: 380px; white-space: pre-wrap; word-break: break-word; }
  .sched-flash { padding: 8px 12px; margin: 0 0 12px; font-family: var(--sans); font-size: 13px; background: rgba(74, 107, 74, 0.08); border-left: 3px solid #4a6b4a; }
  .ok { color: #4a6b4a; font-weight: 600; }
  .warn { color: var(--flash-err); font-weight: 600; }
  .muted { color: var(--ink-soft); }
`;

function fmtDuration(sec: number | null): string {
  if (sec === null) return "—";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)}h`;
  return `${(sec / 86400).toFixed(1)}d`;
}

function fmtAge(sec: number | null): string {
  if (sec === null) return "never";
  return `${fmtDuration(sec)} ago`;
}

function fmtUntil(d: Date | null): string {
  if (d === null) return "—";
  const ms = d.getTime() - Date.now();
  if (ms <= 0) return "due";
  return `in ${fmtDuration(Math.floor(ms / 1000))}`;
}

export const AdminScheduler: FC<{ d: SchedulerData }> = ({ d }) => (
  <Layout title="Scheduler — Blurpadurp admin">
    <style dangerouslySetInnerHTML={{ __html: STYLES }} />
    <AdminNav current="scheduler" />
    <h2>Scheduler</h2>
    <p style="color: var(--ink-soft); font-family: var(--sans); font-size: 13px; max-width: 640px;">
      One Fly machine ticks hourly. On each tick, every enabled stage
      whose <code>last_success + interval_sec</code> has elapsed
      fires. Edit cadence below — changes take effect on the next
      tick.
    </p>

    {d.flash?.triggered ? (
      <div class="sched-flash">
        Fired <strong>{d.flash.triggered}</strong>. It runs in the background;
        refresh in a few seconds to see status.
      </div>
    ) : null}
    {d.flash?.cleared ? (
      <div class="sched-flash">
        Cleared lock for <strong>{d.flash.cleared}</strong>.
      </div>
    ) : null}
    {d.flash?.saved ? (
      <div class="sched-flash">
        Saved schedule for <strong>{d.flash.saved}</strong>.
      </div>
    ) : null}

    <div class="adm-scroll">
      <table class="sched">
        <thead>
          <tr>
            <th>Stage</th>
            <th>Interval</th>
            <th>Enabled</th>
            <th>Last success</th>
            <th>Last attempt</th>
            <th>Next due</th>
            <th>Lock</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {d.rows.map((r) => (
            <tr>
              <td class="sched-stage">{r.stage}</td>
              <td>
                <form
                  method="post"
                  action="/admin/scheduler/edit"
                  class="sched-edit"
                >
                  <input type="hidden" name="stage" value={r.stage} />
                  <input
                    type="hidden"
                    name="enabled"
                    value={r.enabled ? "1" : "0"}
                  />
                  <input
                    type="number"
                    name="interval_sec"
                    value={String(r.intervalSec)}
                    min="60"
                    step="60"
                  />
                  <button type="submit">save</button>
                  <span class="muted">{fmtDuration(r.intervalSec)}</span>
                </form>
              </td>
              <td>
                <form method="post" action="/admin/scheduler/edit">
                  <input type="hidden" name="stage" value={r.stage} />
                  <input
                    type="hidden"
                    name="interval_sec"
                    value={String(r.intervalSec)}
                  />
                  <input
                    type="hidden"
                    name="enabled"
                    value={r.enabled ? "0" : "1"}
                  />
                  <button type="submit" class={r.enabled ? "" : "danger"}>
                    {r.enabled ? "on" : "off"}
                  </button>
                </form>
              </td>
              <td class="num">
                <span class={r.lastSuccessAgeSec === null ? "warn" : "ok"}>
                  {fmtAge(r.lastSuccessAgeSec)}
                </span>
              </td>
              <td>
                {r.lastAttemptStatus === null ? (
                  <span class="muted">—</span>
                ) : (
                  <span
                    class={
                      r.lastAttemptStatus === "success"
                        ? "ok"
                        : r.lastAttemptStatus === "error"
                          ? "warn"
                          : "muted"
                    }
                  >
                    {r.lastAttemptStatus}
                  </span>
                )}
                {r.lastError !== null ? (
                  <div class="sched-error">{r.lastError}</div>
                ) : null}
              </td>
              <td class="num">{r.enabled ? fmtUntil(r.nextDueAt) : "—"}</td>
              <td class="num">
                {r.lockHeldUntil !== null ? (
                  <span class="warn">held</span>
                ) : (
                  <span class="muted">free</span>
                )}
              </td>
              <td class="sched-actions">
                <form method="post" action={`/admin/run/${r.stage}`}>
                  <button type="submit">run now</button>
                </form>
                {r.lockHeldUntil !== null ? (
                  <form method="post" action={`/admin/lock/${r.stage}/clear`}>
                    <button type="submit" class="danger">
                      clear lock
                    </button>
                  </form>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </Layout>
);

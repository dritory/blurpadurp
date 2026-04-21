// Hypothetical-gate sandbox. Adjust the threshold + confidence floor,
// see how the historical scored-story pool would partition. Compares
// to the currently-configured gate so the delta is legible.

import type { FC } from "hono/jsx";
import { Layout } from "./layout.tsx";
import { AdminNav } from "./admin-nav.tsx";
import { ExplorerNav } from "./admin-explore.tsx";
import { HBar } from "./charts.tsx";

export interface GateSandboxData {
  lookbackDays: number;
  current: {
    xThreshold: number;
    confidenceFloor: "low" | "medium" | "high";
    passers: number;
  };
  proposed: {
    xThreshold: number;
    confidenceFloor: "low" | "medium" | "high";
  };
  total: number;
  hypotheticalPassers: number;
  wouldNewlyPass: Array<{ id: number; title: string; composite: number }>;
  wouldNewlyFail: Array<{ id: number; title: string; composite: number }>;
  passersByCategory: Array<{ label: string; value: number; sublabel?: string }>;
  evalSummary: {
    labeled: number;
    truePositives: number;
    falsePositives: number;
    falseNegatives: number;
    precision: number;
    recall: number;
  } | null;
}

const STYLES = `
  .gs-form { background: #fff; border: 1px solid var(--rule); padding: 16px 18px; margin: 0 0 18px; }
  .gs-form form { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px; align-items: end; }
  .gs-form label { display: block; font-family: var(--sans); font-size: 11px; color: var(--ink-soft); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 4px; }
  .gs-form input[type=range] { width: 100%; }
  .gs-form select { width: 100%; padding: 6px 8px; border: 1px solid var(--rule); font-family: inherit; font-size: 13px; background: var(--paper); }
  .gs-form .readout { font-family: var(--sans); font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; margin-top: 4px; }
  .gs-form button { padding: 8px 16px; font-family: var(--sans); font-size: 13px; background: var(--ink); color: var(--paper); border: none; cursor: pointer; }

  .gs-compare { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin: 0 0 22px; }
  .gs-cell { background: #fff; border: 1px solid var(--rule); padding: 14px; }
  .gs-cell .label { font-family: var(--sans); font-size: 11px; color: var(--ink-soft); text-transform: uppercase; letter-spacing: 0.04em; }
  .gs-cell .value { font-family: var(--sans); font-size: 24px; font-weight: 600; font-variant-numeric: tabular-nums; margin-top: 4px; }
  .gs-cell .delta { font-family: var(--sans); font-size: 12px; color: var(--ink-soft); margin-top: 4px; }
  .gs-cell .delta.pos { color: #4a6b4a; }
  .gs-cell .delta.neg { color: var(--flash-err); }

  .gs-lists { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 0 0 20px; }
  .gs-panel { background: #fff; border: 1px solid var(--rule); padding: 14px 16px; }
  .gs-panel h3 { font-family: var(--sans); font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--ink-soft); margin: 0 0 8px; font-weight: 600; }
  .gs-panel ul { list-style: none; padding: 0; margin: 0; font-size: 13px; }
  .gs-panel li { padding: 6px 0; border-bottom: 1px solid var(--rule); display: grid; grid-template-columns: 32px 1fr; gap: 8px; }
  .gs-panel li .c { font-variant-numeric: tabular-nums; color: var(--ink-soft); font-family: var(--sans); font-size: 12px; }
  .gs-panel li a { color: var(--ink); text-decoration: none; }
  .gs-panel li a:hover { text-decoration: underline; }

  .eval-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; font-family: var(--sans); font-size: 13px; }
  .eval-row .stat { background: rgba(0,0,0,0.03); padding: 8px 10px; }
  .eval-row .stat .lbl { font-size: 10px; color: var(--ink-soft); text-transform: uppercase; letter-spacing: 0.04em; }
  .eval-row .stat .val { font-size: 18px; font-variant-numeric: tabular-nums; margin-top: 2px; font-weight: 600; }
`;

const Cell: FC<{
  label: string;
  value: string | number;
  delta?: string;
  deltaClass?: "pos" | "neg";
}> = ({ label, value, delta, deltaClass }) => (
  <div class="gs-cell">
    <div class="label">{label}</div>
    <div class="value">{value}</div>
    {delta !== undefined ? (
      <div class={`delta ${deltaClass ?? ""}`}>{delta}</div>
    ) : null}
  </div>
);

export const AdminExploreGate: FC<{ d: GateSandboxData }> = ({ d }) => {
  const diff = d.hypotheticalPassers - d.current.passers;
  const deltaLabel = diff === 0
    ? "no change"
    : diff > 0
      ? `+${diff} vs current`
      : `${diff} vs current`;
  const deltaClass = diff > 0 ? "pos" : diff < 0 ? "neg" : undefined;

  return (
    <Layout title="Gate sandbox — Explorer">
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      <AdminNav current="explore" />
      <h2>Explorer</h2>
      <ExplorerNav current="gate" />

      <div class="gs-form">
        <form method="get" action="/admin/explore/gate">
          <div>
            <label for="x">
              X threshold (composite ≥){" "}
              <span class="readout">{d.proposed.xThreshold}</span>
            </label>
            <input
              id="x"
              name="x"
              type="range"
              min="0"
              max="25"
              step="1"
              value={d.proposed.xThreshold}
              oninput="this.form.previousElementSibling && (this.previousElementSibling.querySelector('.readout').textContent = this.value)"
            />
          </div>
          <div>
            <label for="cf">Confidence floor</label>
            <select id="cf" name="cf">
              <option value="low" selected={d.proposed.confidenceFloor === "low"}>
                low (accept all)
              </option>
              <option
                value="medium"
                selected={d.proposed.confidenceFloor === "medium"}
              >
                medium
              </option>
              <option
                value="high"
                selected={d.proposed.confidenceFloor === "high"}
              >
                high
              </option>
            </select>
          </div>
          <div>
            <label for="days">Lookback (days)</label>
            <select id="days" name="days">
              {[7, 14, 30, 60, 90].map((n) => (
                <option value={n} selected={d.lookbackDays === n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <div>
            <button type="submit">Apply</button>
          </div>
        </form>
      </div>

      <div class="gs-compare">
        <Cell
          label="Total scored in window"
          value={d.total}
          delta={`${d.lookbackDays}d lookback`}
        />
        <Cell
          label="Current gate passers"
          value={d.current.passers}
          delta={`X=${d.current.xThreshold}, conf ≥ ${d.current.confidenceFloor}`}
        />
        <Cell
          label="Hypothetical passers"
          value={d.hypotheticalPassers}
          delta={deltaLabel}
          deltaClass={deltaClass}
        />
        <Cell
          label="Pass rate"
          value={`${d.total > 0 ? Math.round((d.hypotheticalPassers / d.total) * 100) : 0}%`}
        />
      </div>

      {d.evalSummary !== null ? (
        <div class="gs-panel" style="margin-bottom: 18px;">
          <h3>Against your hand-labeled eval set</h3>
          <div class="eval-row">
            <div class="stat">
              <div class="lbl">Labeled</div>
              <div class="val">{d.evalSummary.labeled}</div>
            </div>
            <div class="stat">
              <div class="lbl">TP</div>
              <div class="val">{d.evalSummary.truePositives}</div>
            </div>
            <div class="stat">
              <div class="lbl">FP</div>
              <div class="val">{d.evalSummary.falsePositives}</div>
            </div>
            <div class="stat">
              <div class="lbl">FN</div>
              <div class="val">{d.evalSummary.falseNegatives}</div>
            </div>
            <div class="stat">
              <div class="lbl">Precision</div>
              <div class="val">
                {(d.evalSummary.precision * 100).toFixed(0)}%
              </div>
            </div>
            <div class="stat">
              <div class="lbl">Recall</div>
              <div class="val">{(d.evalSummary.recall * 100).toFixed(0)}%</div>
            </div>
          </div>
        </div>
      ) : null}

      <div class="gs-panel" style="margin-bottom: 20px;">
        <h3>Hypothetical passers by category</h3>
        {d.passersByCategory.length === 0 ? (
          <p>
            <em>No passers under this gate.</em>
          </p>
        ) : (
          <HBar items={d.passersByCategory} />
        )}
      </div>

      <div class="gs-lists">
        <div class="gs-panel">
          <h3>Would newly pass ({d.wouldNewlyPass.length})</h3>
          {d.wouldNewlyPass.length === 0 ? (
            <p>
              <em>None — a stricter or unchanged gate.</em>
            </p>
          ) : (
            <ul>
              {d.wouldNewlyPass.map((s) => (
                <li>
                  <span class="c">{s.composite.toFixed(0)}</span>
                  <a href={`/admin/explore/story/${s.id}`}>
                    {s.title.slice(0, 90)}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div class="gs-panel">
          <h3>Would newly fail ({d.wouldNewlyFail.length})</h3>
          {d.wouldNewlyFail.length === 0 ? (
            <p>
              <em>None — a looser or unchanged gate.</em>
            </p>
          ) : (
            <ul>
              {d.wouldNewlyFail.map((s) => (
                <li>
                  <span class="c">{s.composite.toFixed(0)}</span>
                  <a href={`/admin/explore/story/${s.id}`}>
                    {s.title.slice(0, 90)}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <p style="font-family: var(--sans); font-size: 12px; color: var(--ink-soft);">
        This sandbox only evaluates the absolute gate
        (composite × confidence). The theme-relative Δ gate and
        event-driven override aren't applied here; they need theme context
        that isn't available in a hypothetical view.
      </p>
    </Layout>
  );
};

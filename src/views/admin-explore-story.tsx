// Admin drill-down for a single story. Every scorer output + raw I/O,
// plus metadata. No redaction — the operator sees everything.

import type { FC } from "hono/jsx";
import { Layout } from "./layout.tsx";
import { AdminCrumbs, AdminNav } from "./admin-nav.tsx";
import { ExplorerNav } from "./admin-explore.tsx";

export interface StoryDrilldown {
  id: number;
  title: string;
  summary: string | null;
  sourceName: string;
  sourceUrl: string | null;
  sourceHost: string | null;
  additionalSourceUrls: string[];
  publishedAt: Date | null;
  ingestedAt: Date;
  scoredAt: Date | null;
  category: string | null;
  themeId: number | null;
  themeName: string | null;
  themeRelationship: string | null;

  composite: number | null;
  zeitgeist: number | null;
  halfLife: number | null;
  reach: number | null;
  nonObviousness: number | null;
  structural: number | null;

  confidence: string | null;
  baseRatePerYear: number | null;
  firstPassComposite: number | null;
  firstPassModel: string | null;

  passedGate: boolean;
  earlyReject: boolean;
  publishedToReader: boolean;
  publishedToReaderAt: Date | null;
  scorerModel: string | null;
  scorerPromptVersion: string | null;

  factors: {
    trigger: string[];
    penalty: string[];
    uncertainty: string[];
  };

  rawInput: unknown;
  rawOutput: unknown;
}

const STYLES = `
  .kv-grid { display: grid; grid-template-columns: 160px 1fr; gap: 6px 16px; font-family: var(--sans); font-size: 13px; margin: 0 0 20px; }
  .kv-grid dt { color: var(--ink-soft); text-transform: uppercase; font-size: 11px; letter-spacing: 0.04em; padding-top: 2px; }
  .kv-grid dd { margin: 0; font-variant-numeric: tabular-nums; }

  .score-row { display: grid; grid-template-columns: repeat(6, 1fr); gap: 8px; margin: 0 0 20px; }
  .score-cell { background: #fff; border: 1px solid var(--rule); padding: 10px; text-align: center; }
  .score-cell .label { font-family: var(--sans); font-size: 10px; color: var(--ink-soft); text-transform: uppercase; letter-spacing: 0.04em; }
  .score-cell .value { font-family: var(--sans); font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; margin-top: 4px; }

  .chips { font-family: var(--sans); font-size: 12px; }
  .chips .chip { display: inline-block; padding: 2px 8px; border-radius: 2px; margin: 2px 3px 2px 0; background: rgba(0,0,0,0.06); }
  .chips .chip.trigger { background: rgba(74, 107, 74, 0.2); color: #2b4f2b; }
  .chips .chip.penalty { background: rgba(166, 58, 58, 0.15); color: #7a2929; }
  .chips .chip.uncertainty { background: rgba(197, 162, 74, 0.2); color: #6b551c; }

  details.jsonblock { background: #fff; border: 1px solid var(--rule); margin: 0 0 12px; }
  details.jsonblock summary { padding: 10px 14px; cursor: pointer; font-family: var(--sans); font-size: 13px; font-weight: 600; color: var(--ink); }
  details.jsonblock summary:hover { background: rgba(0,0,0,0.02); }
  details.jsonblock pre { margin: 0; padding: 12px 14px; background: #fdfcf7; border-top: 1px solid var(--rule); font-family: ui-monospace, Menlo, monospace; font-size: 12px; max-height: 500px; overflow: auto; line-height: 1.45; }

  .gate-banner { padding: 10px 14px; margin: 0 0 16px; border-left: 4px solid; font-family: var(--sans); font-size: 14px; }
  .gate-banner.pass { border-color: #4a6b4a; background: rgba(74, 107, 74, 0.06); }
  .gate-banner.fail { border-color: var(--flash-err); background: rgba(166, 58, 58, 0.04); }
  .gate-banner.reject { border-color: var(--ink-soft); background: rgba(0,0,0,0.03); }

  @media (max-width: 640px) {
    .kv-grid { grid-template-columns: 1fr; gap: 2px 0; }
    .kv-grid dt { padding-top: 10px; }
    .score-row { grid-template-columns: repeat(3, 1fr); gap: 6px; }
    .score-cell { padding: 8px; }
    .score-cell .value { font-size: 18px; }
  }
`;

const Score: FC<{ label: string; value: number | null }> = ({
  label,
  value,
}) => (
  <div class="score-cell">
    <div class="label">{label}</div>
    <div class="value">{value === null ? "—" : value.toFixed(0)}</div>
  </div>
);

export const AdminExploreStory: FC<{ d: StoryDrilldown }> = ({ d }) => {
  const gateState = d.earlyReject
    ? "reject"
    : d.passedGate
      ? "pass"
      : "fail";
  const gateMsg =
    gateState === "pass"
      ? "Passed the gate."
      : gateState === "reject"
        ? "Early-rejected (never scored)."
        : "Did not pass the gate.";
  return (
    <Layout title={`Story #${d.id} — Explorer`}>
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      <AdminNav current="explore" />
      <AdminCrumbs
        trail={[
          { label: "Explorer", href: "/admin/explore" },
          { label: "Stories", href: "/admin/explore/stories" },
          { label: `#${d.id}` },
        ]}
      />
      <h2>Story #{d.id}</h2>
      <ExplorerNav current="stories" />

      <div class={`gate-banner ${gateState}`}>
        {gateMsg}
        {d.publishedToReader && d.publishedToReaderAt ? (
          <>
            {" "}Published {d.publishedToReaderAt.toISOString().slice(0, 10)}.
          </>
        ) : null}
      </div>

      <h3 style="font-family: var(--sans); font-weight: 600; font-size: 20px; margin: 0 0 6px;">
        {d.title}
      </h3>
      {d.summary !== null && d.summary.trim().length > 0 ? (
        <p style="color: var(--ink-soft); margin-bottom: 20px;">{d.summary}</p>
      ) : null}

      <dl class="kv-grid">
        <dt>Source</dt>
        <dd>{d.sourceName}</dd>
        <dt>Source URL</dt>
        <dd>
          {d.sourceUrl !== null ? (
            <>
              <a href={d.sourceUrl} rel="noopener noreferrer" target="_blank">
                {d.sourceUrl} ↗
              </a>
              {d.sourceHost !== null ? (
                <form
                  method="post"
                  action="/admin/sources/block"
                  data-confirm={`Block ${d.sourceHost}? Future ingest skips it (and all subdomains).`}
                  style="display:inline; margin-left:10px;"
                >
                  <input type="hidden" name="host" value={d.sourceHost} />
                  <input
                    type="hidden"
                    name="reason"
                    value={`blocked from story #${d.id}`}
                  />
                  <button
                    type="submit"
                    style="padding:3px 10px; font-family:var(--sans); font-size:12px; background:#fff; color:#8a2a2a; border:1px solid #d4a4a4; cursor:pointer;"
                  >
                    block {d.sourceHost}
                  </button>
                </form>
              ) : null}
            </>
          ) : (
            "—"
          )}
        </dd>
        {d.additionalSourceUrls.length > 0 ? (
          <>
            <dt>Also cited</dt>
            <dd style="color: var(--ink-soft); font-size: 12px;">
              {d.additionalSourceUrls.length} more source
              {d.additionalSourceUrls.length > 1 ? "s" : ""}
            </dd>
          </>
        ) : null}
        <dt>Published</dt>
        <dd>{d.publishedAt?.toISOString().slice(0, 19) ?? "—"}Z</dd>
        <dt>Ingested</dt>
        <dd>{d.ingestedAt.toISOString().slice(0, 19)}Z</dd>
        <dt>Scored</dt>
        <dd>{d.scoredAt?.toISOString().slice(0, 19) ?? "—"}</dd>
        <dt>Category</dt>
        <dd>{d.category ?? "—"}</dd>
        <dt>Theme</dt>
        <dd>
          {d.themeId !== null ? (
            <a href={`/theme/${d.themeId}`}>
              {d.themeName ?? `#${d.themeId}`}
            </a>
          ) : (
            "—"
          )}
          {d.themeRelationship !== null ? (
            <span style="color: var(--ink-soft); margin-left: 6px;">
              ({d.themeRelationship})
            </span>
          ) : null}
        </dd>
        <dt>Confidence</dt>
        <dd>{d.confidence ?? "—"}</dd>
        <dt>Base rate/yr</dt>
        <dd>{d.baseRatePerYear !== null ? d.baseRatePerYear.toFixed(3) : "—"}</dd>
        <dt>Scorer</dt>
        <dd>
          {d.scorerModel ?? "—"}
          {d.scorerPromptVersion !== null ? (
            <span style="color: var(--ink-soft);"> · {d.scorerPromptVersion}</span>
          ) : null}
        </dd>
        {d.firstPassComposite !== null ? (
          <>
            <dt>Prefilter</dt>
            <dd>
              composite {d.firstPassComposite.toFixed(0)}
              {d.firstPassModel !== null ? (
                <span style="color: var(--ink-soft);"> · {d.firstPassModel}</span>
              ) : null}
            </dd>
          </>
        ) : null}
      </dl>

      <div class="score-row">
        <Score label="Composite" value={d.composite} />
        <Score label="Zeitgeist" value={d.zeitgeist} />
        <Score label="Half-life" value={d.halfLife} />
        <Score label="Reach" value={d.reach} />
        <Score label="Non-obvious" value={d.nonObviousness} />
        <Score label="Structural" value={d.structural} />
      </div>

      <div class="chips" style="margin-bottom: 20px;">
        {d.factors.trigger.map((f) => (
          <span class="chip trigger">{f}</span>
        ))}
        {d.factors.penalty.map((f) => (
          <span class="chip penalty">{f}</span>
        ))}
        {d.factors.uncertainty.map((f) => (
          <span class="chip uncertainty">{f}</span>
        ))}
        {d.factors.trigger.length === 0 &&
        d.factors.penalty.length === 0 &&
        d.factors.uncertainty.length === 0 ? (
          <span style="color: var(--ink-soft); font-size: 12px;">
            No factor tags.
          </span>
        ) : null}
      </div>

      <details class="jsonblock">
        <summary>Raw scorer output</summary>
        <pre>{JSON.stringify(d.rawOutput, null, 2)}</pre>
      </details>
      <details class="jsonblock">
        <summary>Raw scorer input</summary>
        <pre>{JSON.stringify(d.rawInput, null, 2)}</pre>
      </details>
      {d.additionalSourceUrls.length > 0 ? (
        <details class="jsonblock">
          <summary>All source URLs ({d.additionalSourceUrls.length + 1})</summary>
          <pre>
{[d.sourceUrl, ...d.additionalSourceUrls].filter(Boolean).join("\n")}
          </pre>
        </details>
      ) : null}
    </Layout>
  );
};

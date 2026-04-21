// Admin labeling page for the hand-labeled eval set. Shows one scored
// story at a time with its scorer one-liner + composite + URL, four
// buttons (yes / maybe / no / skip), and a notes box. Submitting any
// button POSTs to /admin/eval and returns the next unlabeled story.

import type { FC } from "hono/jsx";
import { Layout } from "./layout.tsx";
import { AdminNav } from "./admin-nav.tsx";

export interface EvalCandidate {
  story_id: number;
  title: string;
  source_url: string | null;
  category: string | null;
  composite: number | null;
  confidence: string | null;
  scorerOneLiner: string;
  retrodiction: string;
  ingestedAt: Date;
}

export interface EvalStats {
  total: number;
  labeled: number;
  yes: number;
  maybe: number;
  no: number;
  skip: number;
}

const ADMIN_STYLES = `
  .eval-card { background: #fff; border: 1px solid var(--rule); padding: 20px 24px; margin: 0 0 24px; }
  .eval-meta { font-family: var(--sans); font-size: 12px; color: var(--ink-soft); margin-bottom: 6px; }
  .eval-title { font-family: var(--sans); font-size: 20px; font-weight: 600; margin: 0 0 10px; letter-spacing: -0.01em; }
  .eval-liner { font-family: var(--serif); font-size: 16px; line-height: 1.5; color: var(--ink); margin: 0 0 10px; }
  .eval-retro { font-family: var(--serif); font-size: 14px; color: var(--ink-soft); font-style: italic; margin: 0 0 14px; }
  .eval-link a { font-family: var(--sans); font-size: 13px; }
  .eval-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 18px 0 0; }
  .eval-actions button { padding: 10px 18px; font-size: 14px; font-family: var(--sans); border: 1px solid var(--rule); background: #fff; color: var(--ink); cursor: pointer; }
  .eval-actions button.yes   { background: #4a6b4a; color: #fff; border-color: #4a6b4a; }
  .eval-actions button.maybe { background: #c5a24a; color: #fff; border-color: #c5a24a; }
  .eval-actions button.no    { background: #a63a3a; color: #fff; border-color: #a63a3a; }
  .eval-notes { width: 100%; padding: 8px 10px; border: 1px solid var(--rule); font-family: inherit; font-size: 14px; margin: 12px 0 0; min-height: 48px; }
  .stats { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; margin: 0 0 24px; }
  .stat { text-align: center; background: #fff; border: 1px solid var(--rule); padding: 8px; }
  .stat .label { font-family: var(--sans); font-size: 11px; color: var(--ink-soft); text-transform: uppercase; letter-spacing: 0.04em; }
  .stat .value { font-family: var(--sans); font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums; margin-top: 2px; }
`;

export const AdminEval: FC<{
  stats: EvalStats;
  candidate: EvalCandidate | null;
  flash: string | null;
}> = ({ stats, candidate, flash }) => (
  <Layout title="Eval — Blurpadurp admin">
    <style dangerouslySetInnerHTML={{ __html: ADMIN_STYLES }} />
    <AdminNav current="eval" />
    <h2>Eval labeling</h2>
    <p style="color: var(--ink-soft); font-size: 14px; font-family: var(--sans);">
      Label whether this story belongs in a brief. <strong>Yes</strong> = if
      this hit the gate, I'd want to read it. <strong>No</strong> = no, even
      if the scorer loved it. <strong>Maybe</strong> = borderline.{" "}
      <strong>Skip</strong> = can't judge from this metadata alone.
    </p>

    <div class="stats">
      <div class="stat">
        <div class="label">Labeled</div>
        <div class="value">{stats.labeled}</div>
      </div>
      <div class="stat">
        <div class="label">Yes</div>
        <div class="value">{stats.yes}</div>
      </div>
      <div class="stat">
        <div class="label">Maybe</div>
        <div class="value">{stats.maybe}</div>
      </div>
      <div class="stat">
        <div class="label">No</div>
        <div class="value">{stats.no}</div>
      </div>
      <div class="stat">
        <div class="label">Skip</div>
        <div class="value">{stats.skip}</div>
      </div>
    </div>

    {flash !== null ? <div class="flash">{flash}</div> : null}

    {candidate === null ? (
      <p>
        <em>
          Nothing more to label. Come back after another ingest + score run.
        </em>
      </p>
    ) : (
      <form class="eval-card" method="post" action="/admin/eval">
        <input type="hidden" name="story_id" value={candidate.story_id} />
        <div class="eval-meta">
          story #{candidate.story_id} · {candidate.category ?? "—"} ·{" "}
          composite {candidate.composite ?? "—"} · confidence{" "}
          {candidate.confidence ?? "—"} ·{" "}
          {candidate.ingestedAt.toISOString().slice(0, 10)}
        </div>
        <h3 class="eval-title">{candidate.title}</h3>
        {candidate.scorerOneLiner ? (
          <p class="eval-liner">{candidate.scorerOneLiner}</p>
        ) : null}
        {candidate.retrodiction ? (
          <p class="eval-retro">
            12mo retrodiction: {candidate.retrodiction}
          </p>
        ) : null}
        {candidate.source_url !== null ? (
          <p class="eval-link">
            <a href={candidate.source_url} rel="noopener noreferrer" target="_blank">
              {candidate.source_url} ↗
            </a>
          </p>
        ) : null}
        <textarea
          class="eval-notes"
          name="notes"
          placeholder="Optional note"
        />
        <div class="eval-actions">
          <button type="submit" name="label" value="yes" class="yes">
            Yes
          </button>
          <button type="submit" name="label" value="maybe" class="maybe">
            Maybe
          </button>
          <button type="submit" name="label" value="no" class="no">
            No
          </button>
          <button type="submit" name="label" value="skip">
            Skip
          </button>
        </div>
      </form>
    )}

    <p style="font-family: var(--sans); font-size: 13px; color: var(--ink-soft);">
      Summary report: <code>bun run cli eval</code>
    </p>
  </Layout>
);

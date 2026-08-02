// Admin release console. Answers one question the rest of /admin
// couldn't: "why isn't a brief going out?"
//
// The three-week stall happened because a blocked pipeline and a quiet
// week look identical from the outside — runCompose logs "open draft
// exists, skipping" and returns success, so /admin/scheduler showed a
// healthy green row while nothing shipped. This page makes the blockers
// explicit and shows how much unpublished material is aging out behind
// them.
//
// It also hosts the catch-up picker: unpublished stories past the 7-day
// compose window, ranked by durable significance rather than by the
// gate. Choosing which quiet items still deserve air is editorial
// judgment, so it's a checklist rather than a threshold.

import type { FC } from "hono/jsx";
import { Layout } from "./layout.tsx";
import { AdminNav } from "./admin-nav.tsx";

export interface ReleaseBlocker {
  // "ok" = informational, "warn" = release is currently blocked.
  kind: "ok" | "warn";
  label: string;
  detail: string;
  // Optional remedy link, e.g. straight to the offending draft.
  href?: string;
  hrefLabel?: string;
}

export interface BacklogBucket {
  label: string;
  // Unpublished, gate-passing stories in this age band.
  passing: number;
  // Unpublished stories that failed the gate but score high on the
  // durable axis — catch-up candidates the gate would never surface.
  durable: number;
  // True once the band is past the compose freshness window, i.e. these
  // will never ship through a normal run.
  stranded: boolean;
}

export interface RetroCandidate {
  storyId: number;
  title: string;
  sourceUrl: string | null;
  category: string | null;
  themeName: string | null;
  ageDays: number;
  structural: number;
  halfLife: number;
  zeitgeist: number;
  passedGate: boolean;
  oneLiner: string;
}

export interface ReleaseData {
  blockers: ReleaseBlocker[];
  buckets: BacklogBucket[];
  candidates: RetroCandidate[];
  retroWindowDays: number;
  retroMaxItems: number;
  composeQueued: boolean;
  queuedArgs: string | null;
  flash: { kind: "ok" | "err"; msg: string } | null;
}

const styles = `
  .rel-sect { margin: 0 0 28px; }
  .rel-sect h2 { font-size: 15px; margin: 0 0 4px; font-family: var(--sans); }
  .rel-sect .hint { font-size: 12px; color: #666; margin: 0 0 10px; font-family: var(--sans); }
  .blockers { list-style: none; padding: 0; margin: 0; font-family: var(--sans); font-size: 13px; }
  .blockers li { display: flex; gap: 10px; align-items: baseline; padding: 8px 11px;
                 border: 1px solid; border-radius: 3px; margin-bottom: 6px; }
  .blockers li.ok   { background: #f4f6f4; border-color: #d3ddd3; }
  .blockers li.warn { background: #fdf6e8; border-color: #e0c98a; }
  .blockers .lab { font-weight: 600; min-width: 150px; }
  .blockers .det { color: #444; flex: 1; }
  table.rel { border-collapse: collapse; width: 100%; font-family: var(--sans); font-size: 13px; }
  table.rel th, table.rel td { text-align: left; padding: 6px 9px; border-bottom: 1px solid var(--rule); }
  table.rel th { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #666; }
  tr.stranded td { background: #fdf6e8; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .cand-title { font-weight: 600; }
  .cand-meta { font-size: 11px; color: #666; }
  .nogate { display: inline-block; font-size: 10px; padding: 1px 5px; border-radius: 2px;
            background: #eee; color: #555; margin-left: 6px; vertical-align: middle; }
  .rel-actions { display: flex; gap: 10px; align-items: center; margin-top: 14px; }
  .rel-actions button { font-family: var(--sans); font-size: 13px; padding: 7px 14px;
                        border-radius: 3px; cursor: pointer; border: 1px solid #2b4f2b;
                        background: #2b4f2b; color: #fff; font-weight: 600; }
  .rel-actions button.secondary { background: #fff; color: #333; border-color: #a0a0a0; font-weight: 400; }
  .flash { padding: 10px 14px; margin: 0 0 16px; font-family: var(--sans); font-size: 14px; border: 1px solid var(--rule); }
  .flash.ok { background: #e6f3e6; border-color: #9bc79b; color: #2b4f2b; }
  .flash.err { background: #fbeeee; border-color: #d4a4a4; color: #8a2a2a; }
  .queued { font-family: var(--sans); font-size: 13px; padding: 9px 12px; border-radius: 3px;
            background: #eef2f8; border: 1px solid #b9cbe4; color: #24456f; margin: 0 0 16px; }
  .empty { font-family: var(--sans); font-size: 13px; color: #666; font-style: italic; }
`;

export const AdminRelease: FC<{ data: ReleaseData }> = ({ data }) => (
  <Layout title="Release — Blurpadurp admin">
    <style dangerouslySetInnerHTML={{ __html: styles }} />
    <AdminNav current="release" />
    <h2>Release</h2>

    {data.flash !== null ? (
      <div class={`flash ${data.flash.kind}`}>{data.flash.msg}</div>
    ) : null}

    {data.composeQueued ? (
      <div class="queued">
        A compose run is queued and will fire on the next scheduler tick
        (within an hour).
        {data.queuedArgs !== null ? ` Parameters: ${data.queuedArgs}` : ""}
      </div>
    ) : null}

    <section class="rel-sect">
      <h2>Release status</h2>
      <p class="hint">
        Everything standing between the pool and the next issue. A
        blocked pipeline logs and returns success, so this is the only
        place it's visible.
      </p>
      <ul class="blockers">
        {data.blockers.map((b) => (
          <li class={b.kind}>
            <span class="lab">{b.label}</span>
            <span class="det">{b.detail}</span>
            {b.href !== undefined ? (
              <a href={b.href}>{b.hrefLabel ?? "open"}</a>
            ) : null}
          </li>
        ))}
      </ul>
    </section>

    <section class="rel-sect">
      <h2>Unpublished backlog</h2>
      <p class="hint">
        Scored, never-published stories by age. Anything past the 7-day
        compose window (highlighted) is invisible to a normal run and
        will age out unless a catch-up run picks it up.
      </p>
      <table class="rel">
        <thead>
          <tr>
            <th>Age</th>
            <th class="num">Passed gate</th>
            <th class="num">Durable, gate-failing</th>
            <th>Reachable by a normal compose?</th>
          </tr>
        </thead>
        <tbody>
          {data.buckets.map((b) => (
            <tr class={b.stranded ? "stranded" : ""}>
              <td>{b.label}</td>
              <td class="num">{b.passing}</td>
              <td class="num">{b.durable}</td>
              <td>{b.stranded ? "no — stranded" : "yes"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>

    <section class="rel-sect">
      <h2>Catch-up picks</h2>
      <p class="hint">
        Stories 8–{data.retroWindowDays} days old, ranked by
        structural importance × half-life — the durable axis, which
        doesn't decay the way zeitgeist does. The gate is ignored here
        on purpose: it measures current conversation, which is the wrong
        question for a three-week-old story. Selecting none is a valid
        answer.
      </p>
      {data.candidates.length === 0 ? (
        <p class="empty">
          Nothing in the catch-up window — the backlog is either fresh
          enough for a normal run or already published.
        </p>
      ) : (
        <form method="post" action="/admin/release/compose">
          <table class="rel">
            <thead>
              <tr>
                <th />
                <th>Story</th>
                <th class="num">Age</th>
                <th class="num">Struct.</th>
                <th class="num">Half-life</th>
                <th class="num">Zeitgeist</th>
              </tr>
            </thead>
            <tbody>
              {data.candidates.map((c) => (
                <tr>
                  <td>
                    <input
                      type="checkbox"
                      name="story_id"
                      value={String(c.storyId)}
                    />
                  </td>
                  <td>
                    <div class="cand-title">
                      {c.sourceUrl !== null ? (
                        <a href={c.sourceUrl} rel="noreferrer noopener">
                          {c.title}
                        </a>
                      ) : (
                        c.title
                      )}
                      {!c.passedGate ? (
                        <span class="nogate" title="Did not pass the gate — selected on durable significance instead">
                          no gate
                        </span>
                      ) : null}
                    </div>
                    <div class="cand-meta">
                      {c.category ?? "—"}
                      {c.themeName !== null ? ` · ${c.themeName}` : ""}
                      {c.oneLiner.length > 0 ? ` · ${c.oneLiner}` : ""}
                    </div>
                  </td>
                  <td class="num">{c.ageDays}d</td>
                  <td class="num">{c.structural}</td>
                  <td class="num">{c.halfLife}</td>
                  <td class="num">{c.zeitgeist}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div class="rel-actions">
            <button type="submit" name="mode" value="selected">
              Compose with selected
            </button>
            <button type="submit" name="mode" value="ranked" class="secondary">
              Compose with top {data.retroMaxItems} by rank
            </button>
            <button type="submit" name="mode" value="plain" class="secondary">
              Compose fresh week only
            </button>
          </div>
        </form>
      )}
    </section>
  </Layout>
);

// Editor sandbox — read-only "what would the editor see right now?".
// Mirror to /admin/explore/gate but for the post-gate stage. Surfaces
// the theme-first pool selection: which themes are above the line,
// which are just below, and what the editor would have to choose from.
//
// Doesn't run the editor LLM — purely a database-driven snapshot of
// the pool that compose() would build right now under current config.

import type { FC } from "hono/jsx";

import { AdminCrumbs, AdminNav } from "./admin-nav.tsx";
import { ExplorerNav } from "./admin-explore.tsx";
import { Layout } from "./layout.tsx";

export interface SandboxBucket {
  themeId: number | null;
  themeName: string | null;
  category: string | null;
  storyCount: number;
  maxComposite: number;
  tier1Total: number;
  // Wikipedia (ITN or Current Events) flagged a story on this theme.
  // Wikipedia entries are not in the pool itself — they ride the
  // theme system as a curation signal only.
  wikipediaCorroborated: boolean;
  stories: Array<{
    id: number;
    title: string;
    composite: number | null;
    confidence: string | null;
    sourceUrl: string | null;
    tier1Sources: number;
    totalSources: number;
  }>;
}

export interface EditorSandboxData {
  maxThemes: number;
  ingestWindowDays: number;
  totalPassers: number;
  totalThemes: number;
  poolStories: number;
  included: SandboxBucket[];
  excluded: SandboxBucket[];
  byCategory: Array<{ category: string; passers: number; inPool: number }>;
}

const STYLES = `
  .sb-summary {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 12px; margin: 0 0 24px;
  }
  .sb-cell {
    background: #fff; border: 1px solid var(--rule);
    padding: 12px 14px; font-family: var(--sans);
  }
  .sb-cell .label { font-size: 11px; color: var(--ink-soft); text-transform: uppercase; letter-spacing: 0.04em; }
  .sb-cell .value { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; margin-top: 4px; }
  .sb-cell .sub { font-size: 11px; color: var(--ink-soft); margin-top: 2px; }

  .sb-section { margin: 0 0 28px; }
  .sb-section h3 {
    font-family: var(--sans); font-size: 13px; text-transform: uppercase;
    letter-spacing: 0.04em; color: var(--ink-soft); margin: 0 0 8px;
    font-weight: 600;
  }

  .sb-bucket {
    background: #fff; border: 1px solid var(--rule);
    margin: 0 0 10px; padding: 10px 14px;
  }
  .sb-bucket.below { opacity: 0.62; border-style: dashed; }
  .sb-bucket .head {
    display: flex; flex-wrap: wrap; gap: 12px; align-items: baseline;
    font-family: var(--sans); font-size: 13px;
  }
  .sb-bucket .head .name { font-weight: 600; flex: 1 1 auto; min-width: 0; }
  .sb-bucket .head .name a { color: var(--ink); text-decoration: none; }
  .sb-bucket .head .name a:hover { text-decoration: underline; }
  .sb-bucket .head .meta { color: var(--ink-soft); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .sb-bucket .head .cat {
    background: var(--paper); border: 1px solid var(--rule); padding: 1px 6px;
    color: var(--ink-soft); font-size: 11px; text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .sb-bucket ul { list-style: none; margin: 6px 0 0; padding: 0; font-size: 13px; }
  .sb-bucket li {
    display: flex; gap: 10px; padding: 4px 0; align-items: baseline;
    border-top: 1px dotted var(--rule);
  }
  .sb-bucket li:first-child { border-top: 0; }
  .sb-bucket li .composite {
    font-family: var(--sans); font-variant-numeric: tabular-nums;
    color: var(--ink-soft); width: 40px; text-align: right;
  }
  .sb-bucket li .title { flex: 1 1 auto; min-width: 0; }
  .sb-bucket li .title a { color: var(--ink); }
  .sb-bucket li .sources { font-family: var(--sans); font-size: 11px; color: var(--ink-soft); white-space: nowrap; }

  .sb-cat-table { width: 100%; border-collapse: collapse; font-size: 13px; background: #fff; border: 1px solid var(--rule); }
  .sb-cat-table th, .sb-cat-table td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--rule); }
  .sb-cat-table th { font-family: var(--sans); font-size: 11px; color: var(--ink-soft); text-transform: uppercase; letter-spacing: 0.04em; }
  .sb-cat-table td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .sb-cat-table .ratio-bar { display: inline-block; height: 4px; background: #c2dac0; margin-right: 6px; vertical-align: middle; }
`;

export const AdminEditorSandbox: FC<{ data: EditorSandboxData }> = ({ data }) => (
  <Layout title="Editor sandbox — Blurpadurp admin">
    <style dangerouslySetInnerHTML={{ __html: STYLES }} />
    <AdminNav current="explore" />
    <ExplorerNav current="editor" />
    <AdminCrumbs
      trail={[
        { label: "Explore", href: "/admin/explore" },
        { label: "Editor sandbox" },
      ]}
    />
    <h2>Editor sandbox</h2>
    <p style="color: var(--ink-soft); font-size: 14px; font-family: var(--sans);">
      Read-only view of the pool the editor would see right now —
      same theme-first selection compose() runs. No LLM call. Theme
      cap is <code>editor.pool_max_themes</code> ({data.maxThemes});
      ingest window is the last {data.ingestWindowDays} days.
    </p>

    <div class="sb-summary">
      <Cell label="Passers" value={data.totalPassers} sub="gate-pass, unpublished, in-window" />
      <Cell label="Distinct themes" value={data.totalThemes} sub="incl. singleton-loose" />
      <Cell label="Themes in pool" value={data.included.length} sub={`cap ${data.maxThemes}`} />
      <Cell label="Stories in pool" value={data.poolStories} sub={`out of ${data.totalPassers}`} />
      <Cell label="Pool fill" value={`${Math.round((data.included.length / Math.max(1, data.maxThemes)) * 100)}%`} sub="of theme cap" />
      <Cell label="Below the line" value={data.excluded.length} sub="themes cut by cap" />
    </div>

    <div class="sb-section">
      <h3>Pool composition by category</h3>
      <table class="sb-cat-table">
        <thead>
          <tr>
            <th>Category</th>
            <th class="num">Passers</th>
            <th class="num">In pool</th>
            <th class="num">Pool share</th>
          </tr>
        </thead>
        <tbody>
          {data.byCategory.map((c) => {
            const share = data.poolStories === 0 ? 0 : c.inPool / data.poolStories;
            const barWidth = Math.round(share * 200);
            return (
              <tr>
                <td>{c.category}</td>
                <td class="num">{c.passers}</td>
                <td class="num">
                  {c.inPool > 0 ? (
                    <span
                      class="ratio-bar"
                      style={`width: ${barWidth}px;`}
                      aria-hidden="true"
                    />
                  ) : null}
                  {c.inPool}
                </td>
                <td class="num">{(share * 100).toFixed(0)}%</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>

    <div class="sb-section">
      <h3>Above the line — {data.included.length} themes the editor will see</h3>
      {data.included.map((b) => <BucketCard b={b} below={false} />)}
    </div>

    {data.excluded.length > 0 ? (
      <div class="sb-section">
        <h3>Just below the line — {data.excluded.length} themes excluded by pool cap</h3>
        {data.excluded.slice(0, 30).map((b) => <BucketCard b={b} below={true} />)}
        {data.excluded.length > 30 ? (
          <p style="color: var(--ink-soft); font-size: 13px; font-family: var(--sans); margin: 6px 0 0;">
            … and {data.excluded.length - 30} more not shown.
          </p>
        ) : null}
      </div>
    ) : null}
  </Layout>
);

const Cell: FC<{ label: string; value: number | string; sub?: string }> = ({
  label,
  value,
  sub,
}) => (
  <div class="sb-cell">
    <div class="label">{label}</div>
    <div class="value">{value}</div>
    {sub !== undefined ? <div class="sub">{sub}</div> : null}
  </div>
);

const BucketCard: FC<{ b: SandboxBucket; below: boolean }> = ({ b, below }) => (
  <div class={`sb-bucket${below ? " below" : ""}`}>
    <div class="head">
      <span class="name">
        {b.themeId !== null ? (
          <a href={`/admin/themes/${b.themeId}`}>
            {b.themeName ?? `theme #${b.themeId}`}
          </a>
        ) : (
          <em>(unthemed singleton)</em>
        )}
      </span>
      {b.category !== null ? <span class="cat">{b.category}</span> : null}
      {b.wikipediaCorroborated ? (
        <span
          class="cat"
          title="Wikipedia ITN or Current Events portal includes this theme"
          style="background:#eef2fa;border-color:#b8c8e2;color:#324d80;"
        >
          ⊕ wikipedia
        </span>
      ) : null}
      <span class="meta">
        {b.storyCount} {b.storyCount === 1 ? "story" : "stories"} ·{" "}
        max comp {b.maxComposite} · tier1 {b.tier1Total}
      </span>
    </div>
    <ul>
      {b.stories.map((s) => (
        <li>
          <span class="composite">{s.composite ?? "—"}</span>
          <span class="title">
            <a href={`/admin/explore/story/${s.id}`}>{s.title}</a>
          </span>
          <span class="sources">
            {s.tier1Sources}/{s.totalSources} sources
            {s.confidence !== null ? ` · ${s.confidence}` : ""}
          </span>
        </li>
      ))}
    </ul>
  </div>
);

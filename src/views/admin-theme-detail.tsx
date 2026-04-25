// Admin theme drilldown. Shows the member stories of one theme with
// their cosine similarity to the centroid — the core "is this cluster
// tight or sloppy?" diagnostic.
//
// The table sorts by cosine ascending by default so outliers (low
// values, candidates for "this story doesn't belong") rise to the top.
// Click a story to drill into its scorer output via /admin/explore/story.

import type { FC } from "hono/jsx";

import { AdminCrumbs, AdminNav } from "./admin-nav.tsx";
import { Layout } from "./layout.tsx";

export interface ThemeMember {
  id: number;
  title: string;
  cosine: number | null;
  composite: number | null;
  passedGate: boolean;
  publishedToReader: boolean;
  publishedAt: Date | null;
  ingestedAt: Date;
  sourceDomain: string | null;
}

export interface ThemeDetailData {
  theme: {
    id: number;
    name: string;
    category: string | null;
    firstSeenAt: Date;
    lastPublishedAt: Date | null;
    nStories: number;
    nStoriesPublished: number;
    cohesion: number | null;
    rollingAvg: number | null;
    rolling30d: number | null;
    isLongRunning: boolean;
    hasCentroid: boolean;
  };
  members: ThemeMember[];
}

const STYLES = `
  .theme-meta {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 12px;
    margin: 0 0 20px;
    padding: 14px 16px;
    background: #fff;
    border: 1px solid var(--rule);
    font-family: var(--sans);
  }
  .theme-meta dt {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--ink-soft); margin: 0 0 2px;
  }
  .theme-meta dd { margin: 0; font-size: 14px; }
  .theme-meta .cohesion-tight  { color: #2b4f2b; }
  .theme-meta .cohesion-decent { color: var(--ink); }
  .theme-meta .cohesion-loose  { color: #8a5e2a; }
  .theme-meta .cohesion-sloppy { color: #8a2a2a; font-weight: 600; }

  table.tm-members {
    width: 100%; border-collapse: collapse; font-size: 13px;
  }
  table.tm-members th, table.tm-members td {
    text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--rule);
    vertical-align: middle;
  }
  table.tm-members th {
    font-family: var(--sans); font-weight: 600; font-size: 11px;
    color: var(--ink-soft); text-transform: uppercase; letter-spacing: 0.04em;
  }
  table.tm-members td.num {
    text-align: right; font-variant-numeric: tabular-nums;
  }
  table.tm-members .cos-bar {
    display: inline-block; height: 6px; background: #c2dac0;
    vertical-align: middle; margin-right: 6px; border-radius: 1px;
  }
  table.tm-members .cos-loose .cos-bar  { background: #d8c89b; }
  table.tm-members .cos-sloppy .cos-bar { background: #d4a4a4; }
  table.tm-members .pass-pass { color: #2b4f2b; font-weight: 600; }
  table.tm-members .pass-fail { color: var(--ink-soft); }
  table.tm-members .pub-yes { color: #2b4f2b; }
  table.tm-members .pub-no  { color: var(--ink-soft); }
`;

function cohesionClass(c: number | null): string {
  if (c === null) return "";
  if (c >= 0.9) return "cohesion-tight";
  if (c >= 0.8) return "cohesion-decent";
  if (c >= 0.7) return "cohesion-loose";
  return "cohesion-sloppy";
}

function cosineBucket(c: number | null): "tight" | "decent" | "loose" | "sloppy" | null {
  if (c === null) return null;
  if (c >= 0.9) return "tight";
  if (c >= 0.8) return "decent";
  if (c >= 0.7) return "loose";
  return "sloppy";
}

export const AdminThemeDetail: FC<{ data: ThemeDetailData }> = ({ data }) => {
  const t = data.theme;
  return (
    <Layout title={`${t.name || `theme #${t.id}`} — Blurpadurp admin`}>
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      <AdminNav current="themes" />
      <AdminCrumbs
        trail={[
          { label: "Themes", href: "/admin/themes" },
          { label: t.name || `theme #${t.id}` },
        ]}
      />
      <h2>{t.name || <em>(unnamed theme #{t.id})</em>}</h2>

      <dl class="theme-meta">
        <div>
          <dt>Category</dt>
          <dd>{t.category ?? "—"}</dd>
        </div>
        <div>
          <dt>Members</dt>
          <dd>{t.nStories.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Published</dt>
          <dd>{t.nStoriesPublished.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Cohesion</dt>
          <dd class={cohesionClass(t.cohesion)}>
            {t.cohesion !== null ? t.cohesion.toFixed(3) : "—"}
            {t.cohesion === null && t.nStories === 1 ? (
              <span style="color: var(--ink-soft); font-size: 12px; margin-left: 6px;">
                (singleton)
              </span>
            ) : null}
            {t.cohesion === null && !t.hasCentroid ? (
              <span style="color: var(--ink-soft); font-size: 12px; margin-left: 6px;">
                (no centroid)
              </span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>Rolling avg</dt>
          <dd>{t.rollingAvg !== null ? t.rollingAvg.toFixed(2) : "—"}</dd>
        </div>
        <div>
          <dt>30d avg</dt>
          <dd>{t.rolling30d !== null ? t.rolling30d.toFixed(2) : "—"}</dd>
        </div>
        <div>
          <dt>First seen</dt>
          <dd>{t.firstSeenAt.toISOString().slice(0, 10)}</dd>
        </div>
        <div>
          <dt>Last published</dt>
          <dd>
            {t.lastPublishedAt !== null
              ? t.lastPublishedAt.toISOString().slice(0, 10)
              : "—"}
          </dd>
        </div>
        <div>
          <dt>Long-running</dt>
          <dd>{t.isLongRunning ? "★ on" : "off"}</dd>
        </div>
      </dl>

      <h3>Members ({data.members.length})</h3>
      <p style="color: var(--ink-soft); font-size: 13px; font-family: var(--sans); margin: -8px 0 12px;">
        Sorted by cosine to centroid ascending — outliers at top. A row
        in red is a candidate for "this story doesn't really belong here."
      </p>

      <div class="adm-scroll">
        <table class="tm-members">
          <thead>
            <tr>
              <th class="num">Cosine</th>
              <th>Title</th>
              <th class="num">Composite</th>
              <th>Gate</th>
              <th>Published</th>
              <th>Source</th>
              <th>Ingested</th>
            </tr>
          </thead>
          <tbody>
            {data.members.map((m) => {
              const bucket = cosineBucket(m.cosine);
              const cosClass = bucket !== null ? `cos-${bucket}` : "";
              const barWidthPx =
                m.cosine !== null
                  ? Math.max(2, Math.round(m.cosine * 60))
                  : 0;
              return (
                <tr class={cosClass}>
                  <td class="num">
                    {m.cosine !== null ? (
                      <>
                        <span
                          class="cos-bar"
                          style={`width: ${barWidthPx}px;`}
                          aria-hidden="true"
                        />
                        {m.cosine.toFixed(3)}
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    <a href={`/admin/explore/story/${m.id}`}>{m.title}</a>
                  </td>
                  <td class="num">
                    {m.composite !== null ? m.composite.toFixed(0) : "—"}
                  </td>
                  <td class={m.passedGate ? "pass-pass" : "pass-fail"}>
                    {m.passedGate ? "PASS" : "fail"}
                  </td>
                  <td class={m.publishedToReader ? "pub-yes" : "pub-no"}>
                    {m.publishedToReader ? "yes" : "no"}
                  </td>
                  <td>{m.sourceDomain ?? "—"}</td>
                  <td style="color: var(--ink-soft); font-size: 12px; font-family: var(--sans);">
                    {m.ingestedAt.toISOString().slice(0, 10)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {data.members.length === 0 ? (
        <p>
          <em>No member stories.</em>
        </p>
      ) : null}
    </Layout>
  );
};

// Faceted story browser. Filters are URL query params so the state is
// shareable. No client-side JS — GET form, server renders the result.

import type { FC } from "hono/jsx";
import { Layout } from "./layout.tsx";
import { AdminCrumbs, AdminNav } from "./admin-nav.tsx";
import { ExplorerNav } from "./admin-explore.tsx";

export type GateFilter = "any" | "pass" | "fail" | "reject";
export type SortKey = "composite" | "published" | "scored" | "ingested";

export interface StoryFilter {
  category?: string;
  minComposite?: number;
  maxComposite?: number;
  confidence?: string;
  gate?: GateFilter;
  source?: string;
  factor?: string;
  q?: string;
  sort?: SortKey;
  page?: number;
}

export interface StoryRow {
  id: number;
  title: string;
  source: string;
  category: string | null;
  themeId: number | null;
  themeName: string | null;
  composite: number | null;
  confidence: string | null;
  passedGate: boolean;
  earlyReject: boolean;
  publishedAt: Date | null;
  scoredAt: Date | null;
  factors: string[];
}

export interface StoriesData {
  filter: StoryFilter;
  categories: string[];
  sources: string[];
  factors: string[];
  total: number;
  page: number;
  pageSize: number;
  rows: StoryRow[];
}

const STYLES = `
  .x-filters { background: #fff; border: 1px solid var(--rule); padding: 14px 16px; margin: 0 0 16px; }
  .x-filters form { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; align-items: end; }
  .x-filters label { display: block; font-family: var(--sans); font-size: 11px; color: var(--ink-soft); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 3px; }
  .x-filters input, .x-filters select {
    width: 100%; padding: 6px 8px; border: 1px solid var(--rule); font-family: inherit; font-size: 13px; background: var(--paper);
  }
  .x-filters .actions { display: flex; gap: 6px; }
  .x-filters button {
    padding: 6px 14px; font-size: 13px; font-family: var(--sans); background: var(--ink); color: var(--paper); border: none; cursor: pointer;
  }
  .x-filters a.reset {
    padding: 6px 12px; font-size: 13px; font-family: var(--sans); border: 1px solid var(--rule); text-decoration: none; color: var(--ink-soft); background: #fff;
  }

  table.x-table { width: 100%; min-width: 820px; border-collapse: collapse; font-size: 13px; }
  table.x-table th, table.x-table td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--rule); vertical-align: top; }
  table.x-table th { font-family: var(--sans); font-weight: 600; font-size: 11px; color: var(--ink-soft); text-transform: uppercase; letter-spacing: 0.04em; }
  table.x-table th a { color: inherit; text-decoration: none; }
  table.x-table th a.sorted { color: var(--ink); }
  table.x-table td.num { text-align: right; font-variant-numeric: tabular-nums; }
  table.x-table .chip { display: inline-block; padding: 1px 6px; border-radius: 2px; font-family: var(--sans); font-size: 10px; margin-right: 3px; background: rgba(0,0,0,0.06); color: var(--ink-soft); }
  table.x-table .pass { color: #4a6b4a; font-weight: 600; }
  table.x-table .fail { color: #a63a3a; }
  table.x-table .reject { color: var(--ink-soft); }
  table.x-table .title { max-width: 340px; }
  table.x-table .title a { color: var(--ink); text-decoration: none; }
  table.x-table .title a:hover { text-decoration: underline; }

  .x-pager { display: flex; gap: 12px; justify-content: space-between; align-items: center; margin: 16px 0 0; font-family: var(--sans); font-size: 13px; }
  .x-pager a { padding: 5px 10px; border: 1px solid var(--rule); text-decoration: none; color: var(--ink); }
  .x-pager .muted { color: var(--ink-soft); }
`;

function qs(f: StoryFilter, overrides: Partial<StoryFilter> = {}): string {
  const merged = { ...f, ...overrides };
  const parts: string[] = [];
  if (merged.category) parts.push(`category=${encodeURIComponent(merged.category)}`);
  if (merged.minComposite !== undefined)
    parts.push(`min=${merged.minComposite}`);
  if (merged.maxComposite !== undefined)
    parts.push(`max=${merged.maxComposite}`);
  if (merged.confidence) parts.push(`conf=${encodeURIComponent(merged.confidence)}`);
  if (merged.gate) parts.push(`gate=${merged.gate}`);
  if (merged.source) parts.push(`source=${encodeURIComponent(merged.source)}`);
  if (merged.factor) parts.push(`factor=${encodeURIComponent(merged.factor)}`);
  if (merged.q) parts.push(`q=${encodeURIComponent(merged.q)}`);
  if (merged.sort) parts.push(`sort=${merged.sort}`);
  if (merged.page !== undefined) parts.push(`page=${merged.page}`);
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

const SortLink: FC<{
  column: SortKey;
  label: string;
  filter: StoryFilter;
}> = ({ column, label, filter }) => {
  const sorted = (filter.sort ?? "composite") === column;
  return (
    <a
      class={sorted ? "sorted" : ""}
      href={`/admin/explore/stories${qs(filter, { sort: column, page: 1 })}`}
    >
      {label}
      {sorted ? " ↓" : ""}
    </a>
  );
};

export const AdminExploreStories: FC<{ data: StoriesData }> = ({ data }) => {
  const { filter, rows, total, page, pageSize } = data;
  const hasPrev = page > 1;
  const hasNext = page * pageSize < total;

  return (
    <Layout title="Stories — Explorer">
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      <AdminNav current="explore" />
      <AdminCrumbs
        trail={[
          { label: "Explorer", href: "/admin/explore" },
          { label: "Stories" },
        ]}
      />
      <h2>Stories</h2>
      <ExplorerNav current="stories" />

      <div class="x-filters">
        <form method="get" action="/admin/explore/stories">
          <div>
            <label for="q">Title contains</label>
            <input
              id="q"
              name="q"
              type="text"
              value={filter.q ?? ""}
              placeholder="…"
            />
          </div>
          <div>
            <label for="category">Category</label>
            <select id="category" name="category">
              <option value="">all</option>
              {data.categories.map((c) => (
                <option value={c} selected={filter.category === c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label for="source">Source</label>
            <select id="source" name="source">
              <option value="">all</option>
              {data.sources.map((s) => (
                <option value={s} selected={filter.source === s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label for="conf">Confidence</label>
            <select id="conf" name="conf">
              <option value="">any</option>
              <option value="high" selected={filter.confidence === "high"}>
                high
              </option>
              <option value="medium" selected={filter.confidence === "medium"}>
                medium
              </option>
              <option value="low" selected={filter.confidence === "low"}>
                low
              </option>
            </select>
          </div>
          <div>
            <label for="gate">Gate</label>
            <select id="gate" name="gate">
              <option value="any">any</option>
              <option value="pass" selected={filter.gate === "pass"}>
                passed
              </option>
              <option value="fail" selected={filter.gate === "fail"}>
                failed
              </option>
              <option value="reject" selected={filter.gate === "reject"}>
                early-reject
              </option>
            </select>
          </div>
          <div>
            <label for="min">Composite ≥</label>
            <input
              id="min"
              name="min"
              type="number"
              step="1"
              min="0"
              max="25"
              value={filter.minComposite ?? ""}
            />
          </div>
          <div>
            <label for="max">Composite ≤</label>
            <input
              id="max"
              name="max"
              type="number"
              step="1"
              min="0"
              max="25"
              value={filter.maxComposite ?? ""}
            />
          </div>
          <div>
            <label for="factor">Has factor</label>
            <select id="factor" name="factor">
              <option value="">any</option>
              {data.factors.map((f) => (
                <option value={f} selected={filter.factor === f}>
                  {f}
                </option>
              ))}
            </select>
          </div>
          <input type="hidden" name="sort" value={filter.sort ?? "composite"} />
          <div class="actions">
            <button type="submit">Filter</button>
            <a href="/admin/explore/stories" class="reset">
              Reset
            </a>
          </div>
        </form>
      </div>

      <p style="font-family: var(--sans); font-size: 13px; color: var(--ink-soft); margin: 0 0 8px;">
        {total.toLocaleString()} stories match · page {page} of{" "}
        {Math.max(1, Math.ceil(total / pageSize))}
      </p>

      <div class="adm-scroll">
      <table class="x-table">
        <thead>
          <tr>
            <th>
              <SortLink column="ingested" label="Ingested" filter={filter} />
            </th>
            <th class="title">Title</th>
            <th>Source</th>
            <th>Cat</th>
            <th>Theme</th>
            <th class="num">
              <SortLink column="composite" label="Comp" filter={filter} />
            </th>
            <th>Conf</th>
            <th>Gate</th>
            <th>Factors</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const gateLabel = r.earlyReject
              ? "reject"
              : r.passedGate
                ? "pass"
                : "fail";
            return (
              <tr>
                <td>
                  {r.scoredAt?.toISOString().slice(0, 10) ??
                    r.publishedAt?.toISOString().slice(0, 10) ??
                    "—"}
                </td>
                <td class="title">
                  <a href={`/admin/explore/story/${r.id}`}>{r.title}</a>
                </td>
                <td>{r.source}</td>
                <td>{r.category ?? "—"}</td>
                <td>
                  {r.themeId !== null ? (
                    <a href={`/theme/${r.themeId}`}>
                      {r.themeName ?? `#${r.themeId}`}
                    </a>
                  ) : (
                    "—"
                  )}
                </td>
                <td class="num">
                  {r.composite !== null ? r.composite.toFixed(0) : "—"}
                </td>
                <td>{r.confidence ?? "—"}</td>
                <td class={gateLabel}>{gateLabel}</td>
                <td>
                  {r.factors.slice(0, 4).map((f) => (
                    <span class="chip">{f}</span>
                  ))}
                  {r.factors.length > 4 ? (
                    <span class="chip">+{r.factors.length - 4}</span>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>

      {rows.length === 0 ? (
        <p style="margin-top: 20px;">
          <em>No stories match these filters.</em>
        </p>
      ) : null}

      <div class="x-pager">
        {hasPrev ? (
          <a href={`/admin/explore/stories${qs(filter, { page: page - 1 })}`}>
            ← prev
          </a>
        ) : (
          <span class="muted">prev</span>
        )}
        <span class="muted">
          rows {(page - 1) * pageSize + 1}–{Math.min(total, page * pageSize)} of{" "}
          {total}
        </span>
        {hasNext ? (
          <a href={`/admin/explore/stories${qs(filter, { page: page + 1 })}`}>
            next →
          </a>
        ) : (
          <span class="muted">next</span>
        )}
      </div>
    </Layout>
  );
};

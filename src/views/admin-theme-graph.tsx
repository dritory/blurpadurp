// Admin theme-graph view. Force-directed network of themes connected
// by centroid cosine similarity. Reveals over-fragmentation (the
// Apple-CEO problem from earlier — five themes that should be one
// show as a tight subgraph), category drift (mixed colors in a
// cluster), and sloppy themes (long thin edges to unrelated clusters).
//
// All data is rendered server-side as JSON inside a <script> tag and
// picked up by the theme-graph.ts island on mount. Filter controls
// (category, min cosine, hide singletons) are URL params — server
// re-renders, no client-side filtering, search-engine-friendly.

import type { FC } from "hono/jsx";

import { AdminCrumbs, AdminNav } from "./admin-nav.tsx";
import { Layout } from "./layout.tsx";

export interface GraphNode {
  id: number;
  name: string;
  category: string | null;
  n_stories: number;
  /** Avg cosine to centroid; null = singleton or no centroid. */
  cohesion: number | null;
}

export interface GraphEdge {
  a: number;
  b: number;
  cosine: number;
}

export interface ThemeGraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  filters: {
    minCosine: number;
    category: string | null;
    hideSingletons: boolean;
  };
  totals: {
    themes: number;
    edges: number;
  };
  categories: string[];
}

const STYLES = `
  .graph-controls {
    display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
    margin: 0 0 16px; padding: 10px 14px; background: #fff;
    border: 1px solid var(--rule); font-family: var(--sans); font-size: 13px;
  }
  .graph-controls form {
    display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
    margin: 0;
  }
  .graph-controls label { color: var(--ink-soft); font-size: 12px; }
  .graph-controls input[type=number],
  .graph-controls select {
    font: inherit; font-family: var(--sans); font-size: 13px;
    padding: 4px 8px; border: 1px solid var(--rule); background: #fff;
  }
  .graph-controls input[type=range] { vertical-align: middle; }
  .graph-controls .totals { color: var(--ink-soft); font-size: 12px; margin-left: auto; }
  .graph-controls button {
    padding: 6px 12px; font: inherit; font-family: var(--sans); font-size: 13px;
    border: 1px solid var(--rule); background: #fff; color: var(--ink); cursor: pointer;
  }
  .graph-controls button:hover { border-color: var(--ink); }

  .graph-canvas {
    /* vis-network's canvas is absolutely positioned; the container
       needs to be a positioning context. Without this the canvas
       escapes the box and renders to (0,0) of the document. */
    position: relative;
    width: 100%; height: calc(100vh - 240px); min-height: 540px;
    background: #fff; border: 1px solid var(--rule);
    overflow: hidden;
  }

  .graph-legend {
    display: flex; flex-wrap: wrap; gap: 14px; margin: 12px 0 0;
    font-family: var(--sans); font-size: 12px; color: var(--ink-soft);
  }
  .graph-legend .swatch {
    display: inline-block; width: 12px; height: 12px; border-radius: 50%;
    margin-right: 4px; vertical-align: middle;
  }
  .graph-legend .label-line { display: flex; align-items: center; gap: 4px; }
`;

// Color palette for node fills, keyed by category slug. Stays in sync
// with the 9 active categories from migrations/001_init.sql.
export const CATEGORY_COLORS: Record<string, string> = {
  politics: "#7a3b3b",
  science: "#3b6a7a",
  technology: "#3b5a7a",
  economy: "#6a5a2a",
  culture: "#7a3b6a",
  internet_culture: "#5a3b7a",
  environment_climate: "#3b7a4a",
  health: "#3b7a7a",
  society: "#6a6a6a",
  uncategorized: "#9a9a9a",
};

export const AdminThemeGraph: FC<{ data: ThemeGraphData }> = ({ data }) => (
  <Layout title="Theme graph — Blurpadurp admin">
    <style dangerouslySetInnerHTML={{ __html: STYLES }} />
    <AdminNav
      current="explore"
      clientBundles={["/assets/build/theme-graph.js"]}
    />
    <AdminCrumbs
      trail={[
        { label: "Explore", href: "/admin/explore" },
        { label: "Theme graph" },
      ]}
    />
    <h2>Theme graph</h2>
    <p style="color: var(--ink-soft); font-size: 14px; font-family: var(--sans);">
      Each node is a theme. Edges connect themes whose centroids exceed the
      cosine threshold. Tight subgraphs of high-cosine themes are
      candidates for merging. Mixed-category subgraphs hint at
      mis-categorization.
    </p>

    <div class="graph-controls">
      <form method="get" action="/admin/explore/graph">
        <label for="min-cosine">min cosine</label>
        <input
          id="min-cosine"
          type="number"
          name="min_cosine"
          step="0.01"
          min="0.5"
          max="0.99"
          value={data.filters.minCosine.toFixed(2)}
        />
        <label for="cat">category</label>
        <select id="cat" name="category">
          <option value="">all</option>
          {data.categories.map((c) => (
            <option value={c} selected={data.filters.category === c}>
              {c}
            </option>
          ))}
        </select>
        <label title="Singletons (themes with one member) make up most of the corpus and clutter the graph; hidden by default.">
          <input
            type="checkbox"
            name="show_singletons"
            value="1"
            checked={!data.filters.hideSingletons}
          />{" "}
          show singletons
        </label>
        <button type="submit">apply</button>
      </form>
      <span class="totals">
        {data.totals.themes.toLocaleString()} themes ·{" "}
        {data.totals.edges.toLocaleString()} edges
      </span>
    </div>

    <div id="graph-canvas" class="graph-canvas" aria-label="Theme network graph" />

    <div class="graph-legend">
      <span>Categories:</span>
      {Object.entries(CATEGORY_COLORS).map(([cat, color]) => (
        <span class="label-line">
          <span class="swatch" style={`background: ${color};`} />
          {cat}
        </span>
      ))}
    </div>

    {/* Render data inline. The island parses this on mount; keeps it
        out of bundle and out of the URL. */}
    <script
      id="graph-data"
      type="application/json"
      dangerouslySetInnerHTML={{
        __html: JSON.stringify({
          nodes: data.nodes,
          edges: data.edges,
          colors: CATEGORY_COLORS,
        }),
      }}
    />
  </Layout>
);

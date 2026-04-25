/// <reference lib="dom" />
// Theme-graph island. Reads the embedded JSON dataset, renders a
// force-directed network via vis-network. Click a node to drill into
// the theme detail page.

import { Network, type Data, type Options } from "vis-network/standalone";

interface GraphNode {
  id: number;
  name: string;
  category: string | null;
  n_stories: number;
  cohesion: number | null;
}

interface GraphEdge {
  a: number;
  b: number;
  cosine: number;
}

interface Payload {
  nodes: GraphNode[];
  edges: GraphEdge[];
  colors: Record<string, string>;
}

function mount(): void {
  const dataNode = document.getElementById("graph-data");
  const canvas = document.getElementById("graph-canvas");
  if (dataNode === null || canvas === null) return;
  try {
    mountInner(dataNode, canvas);
  } catch (e) {
    // Surface init errors visibly. Without this, the page just renders
    // a white canvas and the operator has no signal that anything's
    // wrong without opening devtools.
    canvas.innerHTML = "";
    const msg = document.createElement("pre");
    msg.style.cssText =
      "padding:16px;color:#8a2a2a;font:13px ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;";
    msg.textContent =
      "Graph init failed:\n" + (e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ""}` : String(e));
    canvas.appendChild(msg);
    // Re-throw so it also lands in devtools / error reporters.
    throw e;
  }
}

function mountInner(dataNode: HTMLElement, canvas: HTMLElement): void {
  const payload: Payload = JSON.parse(dataNode.textContent ?? "{}");

  // Node size scales with member count. Squashed by sqrt so a theme
  // with 50 stories doesn't visually drown a theme with 5.
  const minStories = 1;
  const sizeFor = (n: number): number => 8 + Math.sqrt(Math.max(1, n - minStories)) * 4;

  const colorFor = (category: string | null): string => {
    const key = category ?? "uncategorized";
    return payload.colors[key] ?? payload.colors.uncategorized ?? "#9a9a9a";
  };

  const nodes = payload.nodes.map((n) => ({
    id: n.id,
    label: n.name.length > 40 ? n.name.slice(0, 37) + "…" : n.name,
    title: buildTooltip(n),
    value: sizeFor(n.n_stories),
    color: {
      background: colorFor(n.category),
      border: colorFor(n.category),
      highlight: { background: "#fff5d1", border: "#d4b84a" },
    },
    font: { color: "#222", size: 11, face: "system-ui, sans-serif" },
  }));

  // vis-network treats edges as undirected when source/target ordering
  // doesn't matter for layout. Edge opacity scales with cosine strength
  // so weak connections recede visually.
  const edges = payload.edges.map((e) => {
    const t = Math.max(0, Math.min(1, (e.cosine - 0.5) / 0.5));
    return {
      from: e.a,
      to: e.b,
      width: 0.5 + t * 2.5,
      color: {
        color: `rgba(60, 60, 60, ${(0.15 + t * 0.5).toFixed(3)})`,
        highlight: "#2b4f2b",
      },
      title: `cosine ${e.cosine.toFixed(3)}`,
      smooth: false,
    };
  });

  const data: Data = { nodes, edges };
  const options: Options = {
    physics: {
      enabled: true,
      // Gentler repulsion so dense subgraphs don't collapse to a dot.
      barnesHut: {
        gravitationalConstant: -3500,
        centralGravity: 0.15,
        springLength: 100,
        springConstant: 0.03,
        damping: 0.45,
      },
      stabilization: { iterations: 200, fit: true },
    },
    interaction: {
      hover: true,
      tooltipDelay: 120,
      navigationButtons: true,
      keyboard: { enabled: true },
    },
    nodes: {
      shape: "dot",
      borderWidth: 1,
      scaling: { min: 6, max: 30, label: { enabled: false } },
    },
    edges: {
      smooth: false,
    },
  };

  const network = new Network(canvas, data, options);
  network.on("click", (params: { nodes: number[] }) => {
    if (params.nodes.length === 0) return;
    const id = params.nodes[0];
    if (typeof id === "number") {
      window.location.href = `/admin/themes/${id}`;
    }
  });
}

function buildTooltip(n: GraphNode): string {
  const parts: string[] = [];
  parts.push(escape(n.name || `theme #${n.id}`));
  parts.push(`${n.category ?? "(no category)"} · ${n.n_stories} stories`);
  if (n.cohesion !== null) {
    parts.push(`cohesion ${n.cohesion.toFixed(3)}`);
  }
  return parts.join("\n");
}

function escape(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mount);
} else {
  mount();
}

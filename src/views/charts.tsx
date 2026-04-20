// Hand-rolled SVG chart primitives for the admin explorer. No chart
// library — these are small, data-dense, server-rendered.

import type { FC } from "hono/jsx";

export const Histogram: FC<{
  data: number[];
  min: number;
  max: number;
  bins?: number;
  width?: number;
  height?: number;
  label?: string;
}> = ({ data, min, max, bins = 25, width = 320, height = 90, label }) => {
  const counts = new Array(bins).fill(0) as number[];
  for (const v of data) {
    const c = Math.max(min, Math.min(max, v));
    const b =
      max === min
        ? 0
        : Math.min(bins - 1, Math.floor(((c - min) / (max - min)) * bins));
    counts[b] = (counts[b] ?? 0) + 1;
  }
  const mx = Math.max(1, ...counts);
  const barW = width / bins;
  return (
    <svg
      width={width}
      height={height}
      role="img"
      aria-label={label ?? "Histogram"}
      style="display: block;"
    >
      {counts.map((c, i) => {
        const h = (c / mx) * (height - 14);
        return (
          <rect
            x={i * barW}
            y={height - 14 - h}
            width={barW - 1}
            height={h}
            fill="var(--accent)"
            opacity="0.8"
          >
            <title>{`${(min + ((max - min) * i) / bins).toFixed(1)}–${(min + ((max - min) * (i + 1)) / bins).toFixed(1)}: ${c}`}</title>
          </rect>
        );
      })}
      <text
        x="0"
        y={height - 2}
        font-family="var(--sans)"
        font-size="10"
        fill="var(--ink-soft)"
      >
        {min}
      </text>
      <text
        x={width}
        y={height - 2}
        font-family="var(--sans)"
        font-size="10"
        fill="var(--ink-soft)"
        text-anchor="end"
      >
        {max}
      </text>
    </svg>
  );
};

export const HBar: FC<{
  items: Array<{ label: string; value: number; sublabel?: string }>;
  max?: number;
}> = ({ items, max }) => {
  const mx = max ?? Math.max(1, ...items.map((i) => i.value));
  return (
    <ul
      style="list-style: none; padding: 0; margin: 0; font-family: var(--sans); font-size: 13px;"
    >
      {items.map((i) => (
        <li
          style="display: grid; grid-template-columns: 140px 1fr 50px; gap: 8px; align-items: center; line-height: 1.9; border-bottom: 1px solid var(--rule);"
        >
          <span style="text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">
            {i.label}
          </span>
          <span style="position: relative; height: 12px; background: rgba(0,0,0,0.04);">
            <span
              style={`display: block; height: 100%; width: ${Math.round((i.value / mx) * 100)}%; background: var(--accent); opacity: 0.75;`}
            ></span>
          </span>
          <span style="text-align: right; font-variant-numeric: tabular-nums;">
            {i.value}
            {i.sublabel !== undefined ? (
              <span style="color: var(--ink-soft); font-size: 11px; margin-left: 4px;">
                {i.sublabel}
              </span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
};

export const Timeline: FC<{
  days: Array<{ day: string; count: number; passed?: number }>;
  width?: number;
  height?: number;
}> = ({ days, width = 640, height = 72 }) => {
  const mx = Math.max(1, ...days.map((d) => d.count));
  const w = Math.max(2, width / Math.max(1, days.length));
  return (
    <svg width={width} height={height} style="display: block;">
      {days.map((d, i) => {
        const total = (d.count / mx) * (height - 18);
        const pass = ((d.passed ?? 0) / mx) * (height - 18);
        return (
          <>
            <rect
              x={i * w}
              y={height - 18 - total}
              width={w - 1}
              height={total}
              fill="var(--accent)"
              opacity="0.5"
            >
              <title>{`${d.day}: ${d.count} scored, ${d.passed ?? 0} passed`}</title>
            </rect>
            {pass > 0 ? (
              <rect
                x={i * w}
                y={height - 18 - pass}
                width={w - 1}
                height={pass}
                fill="#4a6b4a"
                opacity="0.85"
              />
            ) : null}
          </>
        );
      })}
      <text
        x="0"
        y={height - 2}
        font-family="var(--sans)"
        font-size="10"
        fill="var(--ink-soft)"
      >
        {days[0]?.day ?? ""}
      </text>
      <text
        x={width}
        y={height - 2}
        font-family="var(--sans)"
        font-size="10"
        fill="var(--ink-soft)"
        text-anchor="end"
      >
        {days[days.length - 1]?.day ?? ""}
      </text>
    </svg>
  );
};

export function quantiles(xs: number[], qs = [0.1, 0.5, 0.9]): number[] {
  if (xs.length === 0) return qs.map(() => 0);
  const sorted = [...xs].sort((a, b) => a - b);
  return qs.map((q) => {
    const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1))));
    return sorted[idx]!;
  });
}

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

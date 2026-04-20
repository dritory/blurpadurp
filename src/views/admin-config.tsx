import type { FC } from "hono/jsx";
import { Layout } from "./layout.tsx";

export interface ConfigRow {
  key: string;
  value: unknown;
  updatedAt: Date;
}

const ADMIN_STYLES = `
  .cfg-list { margin: 0; padding: 0; list-style: none; }
  .cfg-row { padding: 16px 0; border-bottom: 1px solid var(--rule); margin: 0; }
  .cfg-key { font-family: var(--sans); font-weight: 600; font-size: 15px; margin: 0 0 4px; }
  .cfg-when { font-family: var(--sans); font-size: 12px; color: var(--ink-soft); margin: 0 0 8px; }
  .cfg-form { display: flex; gap: 8px; align-items: flex-start; }
  .cfg-form textarea {
    flex: 1; padding: 8px 10px; border: 1px solid var(--rule);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 13px; background: #fff; resize: vertical; min-height: 38px;
  }
  .cfg-form button {
    padding: 8px 14px; font-size: 13px; font-family: var(--sans);
    background: var(--ink); color: var(--paper); border: none; cursor: pointer;
    flex-shrink: 0;
  }
`;

export const AdminConfig: FC<{
  rows: ConfigRow[];
  flash: { kind: "ok" | "error"; msg: string } | null;
}> = ({ rows, flash }) => (
  <Layout title="Config — Blurpadurp admin">
    <style dangerouslySetInnerHTML={{ __html: ADMIN_STYLES }} />
    <h2>Config</h2>
    <p>
      <em>
        Values are raw JSON — a string needs quotes, a number doesn't. The{" "}
        <code>updated_at</code> field refreshes automatically on save.
      </em>
    </p>
    {flash !== null ? (
      <div class={`flash ${flash.kind === "error" ? "error" : ""}`}>
        {flash.msg}
      </div>
    ) : null}
    <ul class="cfg-list">
      {rows.map((r) => (
        <li class="cfg-row">
          <p class="cfg-key">{r.key}</p>
          <p class="cfg-when">
            updated {r.updatedAt.toISOString().replace("T", " ").slice(0, 16)}Z
          </p>
          <form class="cfg-form" method="post" action="/admin/config">
            <input type="hidden" name="key" value={r.key} />
            <textarea name="value" rows={1}>
              {JSON.stringify(r.value)}
            </textarea>
            <button type="submit">Save</button>
          </form>
        </li>
      ))}
    </ul>
  </Layout>
);

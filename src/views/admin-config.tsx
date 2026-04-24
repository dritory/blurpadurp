import type { FC } from "hono/jsx";
import { Layout } from "./layout.tsx";
import { AdminNav } from "./admin-nav.tsx";

export interface ConfigRow {
  key: string;
  value: unknown;
  updatedAt: Date;
}

export interface ConfigFlash {
  kind: "ok" | "error";
  msg: string;
  key: string | null;
}

const ADMIN_STYLES = `
  .cfg-list { margin: 0; padding: 0; list-style: none; }
  .cfg-row { padding: 16px 0; border-bottom: 1px solid var(--rule); margin: 0; }
  .cfg-row.just-saved { background: linear-gradient(90deg, rgba(74,107,74,0.08), transparent 70%); }
  .cfg-key { font-family: var(--sans); font-weight: 600; font-size: 15px; margin: 0 0 4px; display: flex; align-items: center; gap: 8px; }
  .cfg-when { font-family: var(--sans); font-size: 12px; color: var(--ink-soft); margin: 0 0 8px; }
  .cfg-form { display: flex; gap: 8px; align-items: flex-start; }
  .cfg-form textarea {
    flex: 1; padding: 10px 12px; border: 1px solid var(--rule);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 13px; line-height: 1.45; background: #fff; resize: vertical; min-height: 72px;
  }
  .cfg-form button {
    padding: 10px 16px; min-height: 40px; font-size: 13px; font-family: var(--sans);
    background: var(--ink); color: var(--paper); border: none; cursor: pointer;
    flex-shrink: 0;
  }

  @media (max-width: 640px) {
    .cfg-form { flex-direction: column; }
    .cfg-form textarea { width: 100%; }
    .cfg-form button { width: 100%; }
  }
`;

export const AdminConfig: FC<{
  rows: ConfigRow[];
  flash: ConfigFlash | null;
}> = ({ rows, flash }) => {
  const savedKey =
    flash !== null && flash.kind === "ok" ? flash.key : null;
  return (
    <Layout title="Config — Blurpadurp admin">
      <style dangerouslySetInnerHTML={{ __html: ADMIN_STYLES }} />
      <AdminNav current="config" />
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
        {rows.map((r) => {
          const justSaved = savedKey === r.key;
          return (
            <li
              class={`cfg-row ${justSaved ? "just-saved" : ""}`}
              id={`cfg-${r.key}`}
            >
              <p class="cfg-key">
                {r.key}
                {justSaved ? <span class="adm-toast">✓ Saved</span> : null}
              </p>
              <p class="cfg-when">
                updated {r.updatedAt.toISOString().replace("T", " ").slice(0, 16)}Z
              </p>
              <form class="cfg-form" method="post" action="/admin/config">
                <input type="hidden" name="key" value={r.key} />
                <textarea name="value" rows={3}>
                  {JSON.stringify(r.value)}
                </textarea>
                <button type="submit">Save</button>
              </form>
            </li>
          );
        })}
      </ul>
    </Layout>
  );
};

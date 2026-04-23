import type { FC } from "hono/jsx";
import type {
  CapturedRow,
  ReplayRow,
  ReplaySummary,
} from "../pipeline/fixture.ts";
import { Layout } from "./layout.tsx";
import { AdminCrumbs, AdminNav } from "./admin-nav.tsx";

export interface FixtureFile {
  name: string;
  sizeBytes: number;
  mtime: Date;
  kind: "capture" | "replay" | "composer-replay" | "editor-replay" | "unknown";
}

const ADMIN_STYLES = `
  table.fx { width: 100%; border-collapse: collapse; font-size: 14px; }
  table.fx th, table.fx td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--rule); }
  table.fx th { font-family: var(--sans); font-weight: 600; font-size: 12px; color: var(--ink-soft); text-transform: uppercase; letter-spacing: 0.04em; }
  table.fx td.num { font-variant-numeric: tabular-nums; }
  table.fx tr.shift { background: #fff7e0; }
  .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin: 16px 0 28px; }
  .summary-cell { background: #fff; border: 1px solid var(--rule); padding: 10px 14px; }
  .summary-cell .label { font-family: var(--sans); font-size: 12px; color: var(--ink-soft); text-transform: uppercase; letter-spacing: 0.04em; }
  .summary-cell .value { font-family: var(--sans); font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; margin-top: 4px; }
`;

function issueIdFromName(name: string): number | null {
  const m = /^(?:composer|editor)-replay-i(\d+)-/.exec(name);
  return m && m[1] !== undefined ? Number(m[1]) : null;
}

const FixturesTable: FC<{ files: FixtureFile[] }> = ({ files }) => (
  <div class="adm-scroll">
  <table class="fx">
    <thead>
      <tr>
        <th>File</th>
        <th>Issue</th>
        <th>Size</th>
        <th>Modified</th>
      </tr>
    </thead>
    <tbody>
      {files.map((f) => {
        const issueId = issueIdFromName(f.name);
        return (
          <tr>
            <td>
              <a href={`/admin/fixtures/${encodeURIComponent(f.name)}`}>
                {f.name}
              </a>
            </td>
            <td>
              {issueId !== null ? (
                <a href={`/admin/review/${issueId}`}>#{issueId}</a>
              ) : (
                <span style="color: var(--ink-soft);">—</span>
              )}
            </td>
            <td class="num">{formatBytes(f.sizeBytes)}</td>
            <td>{f.mtime.toISOString().replace("T", " ").slice(0, 16)}Z</td>
          </tr>
        );
      })}
    </tbody>
  </table>
  </div>
);

export const AdminFixturesList: FC<{ files: FixtureFile[] }> = ({ files }) => {
  const composerReplays = files.filter((f) => f.kind === "composer-replay");
  const editorReplays = files.filter((f) => f.kind === "editor-replay");
  const scorerFiles = files.filter(
    (f) => f.kind !== "composer-replay" && f.kind !== "editor-replay",
  );
  return (
    <Layout title="Fixtures — Blurpadurp admin">
      <style dangerouslySetInnerHTML={{ __html: ADMIN_STYLES }} />
      <AdminNav current="fixtures" />
      <h2>Fixtures</h2>
      {files.length === 0 ? (
        <p>
          <em>
            No fixtures yet. Run <code>bun run cli composer-replay</code>,{" "}
            <code>bun run cli editor-replay</code>, or{" "}
            <code>bun run cli fixture-capture</code>.
          </em>
        </p>
      ) : (
        <>
          <h3>Composer replays</h3>
          {composerReplays.length === 0 ? (
            <p>
              <em>
                None yet. Run <code>bun run cli composer-replay</code>.
              </em>
            </p>
          ) : (
            <FixturesTable files={composerReplays} />
          )}
          <h3 style="margin-top: 32px;">Editor replays</h3>
          {editorReplays.length === 0 ? (
            <p>
              <em>
                None yet. Run <code>bun run cli editor-replay</code>.
              </em>
            </p>
          ) : (
            <FixturesTable files={editorReplays} />
          )}
          <h3 style="margin-top: 32px;">Scorer fixtures</h3>
          {scorerFiles.length === 0 ? (
            <p>
              <em>
                None yet. Run <code>bun run cli fixture-capture</code>.
              </em>
            </p>
          ) : (
            <FixturesTable files={scorerFiles} />
          )}
        </>
      )}
    </Layout>
  );
};

export const AdminCaptureView: FC<{
  name: string;
  rows: CapturedRow[];
}> = ({ name, rows }) => (
  <Layout title={`${name} — fixture`}>
    <style dangerouslySetInnerHTML={{ __html: ADMIN_STYLES }} />
    <AdminNav current="fixtures" />
    <AdminCrumbs
      trail={[
        { label: "Fixtures", href: "/admin/fixtures" },
        { label: name },
      ]}
    />
    <h2>{name}</h2>
    <p class="issue-meta">capture · {rows.length} stories</p>
    <div class="adm-scroll">
    <table class="fx">
      <thead>
        <tr>
          <th>ID</th>
          <th>Title</th>
          <th>Source</th>
          <th>Category</th>
          <th>Composite</th>
          <th>Confidence</th>
          <th>Early-reject</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr>
            <td class="num">{r.story_id}</td>
            <td>{r.title.slice(0, 80)}</td>
            <td>{r.source_name}</td>
            <td>{r.raw_output.classification.category}</td>
            <td class="num">
              {String(r.raw_output.scores.composite ?? "")}
            </td>
            <td>{r.raw_output.reasoning.confidence}</td>
            <td>{r.raw_output.classification.early_reject ? "yes" : ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  </Layout>
);

export const AdminReplayView: FC<{
  name: string;
  rows: ReplayRow[];
  summary: ReplaySummary;
}> = ({ name, rows, summary }) => {
  const delta =
    `${summary.compositeMeanDelta >= 0 ? "+" : ""}` +
    summary.compositeMeanDelta.toFixed(2);
  const first = rows[0];
  return (
    <Layout title={`${name} — replay`}>
      <style dangerouslySetInnerHTML={{ __html: ADMIN_STYLES }} />
      <AdminNav current="fixtures" />
      <AdminCrumbs
        trail={[
          { label: "Fixtures", href: "/admin/fixtures" },
          { label: name },
        ]}
      />
      <h2>{name}</h2>
      {first !== undefined ? (
        <p class="issue-meta">
          replay · {first.source_prompt_version ?? "—"} →{" "}
          {first.replay_prompt_version} · {first.replay_model_id}
        </p>
      ) : null}

      <div class="summary-grid">
        <div class="summary-cell">
          <div class="label">Parsed</div>
          <div class="value">
            {summary.parsed}/{summary.total}
          </div>
        </div>
        <div class="summary-cell">
          <div class="label">Composite Δ</div>
          <div class="value">{delta}</div>
        </div>
        <div class="summary-cell">
          <div class="label">Category shifts</div>
          <div class="value">{summary.categoryShifts}</div>
        </div>
        <div class="summary-cell">
          <div class="label">Early-reject flips</div>
          <div class="value">{summary.earlyRejectFlips}</div>
        </div>
        <div class="summary-cell">
          <div class="label">Confidence shifts</div>
          <div class="value">{summary.confidenceShifts}</div>
        </div>
        <div class="summary-cell">
          <div class="label">Mean latency</div>
          <div class="value">{Math.round(summary.latencyMeanMs)}ms</div>
        </div>
      </div>

      <div class="adm-scroll">
      <table class="fx">
        <thead>
          <tr>
            <th>ID</th>
            <th>Category</th>
            <th>Composite</th>
            <th>Early-reject</th>
            <th>Confidence</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const cap = r.captured_output;
            const rep = r.replay_output;
            const shift = rep !== null && diffsFrom(cap, rep);
            return (
              <tr class={shift ? "shift" : ""}>
                <td class="num">{r.story_id}</td>
                <td>
                  {cap.classification.category}
                  {rep !== null && rep.classification.category !== cap.classification.category
                    ? ` → ${rep.classification.category}`
                    : ""}
                </td>
                <td class="num">
                  {String(cap.scores.composite ?? "—")}
                  {rep !== null && rep.scores.composite !== cap.scores.composite
                    ? ` → ${String(rep.scores.composite ?? "—")}`
                    : ""}
                </td>
                <td>
                  {cap.classification.early_reject ? "yes" : "no"}
                  {rep !== null && rep.classification.early_reject !== cap.classification.early_reject
                    ? ` → ${rep.classification.early_reject ? "yes" : "no"}`
                    : ""}
                </td>
                <td>
                  {cap.reasoning.confidence}
                  {rep !== null &&
                  rep.reasoning.confidence !==
                    cap.reasoning.confidence
                    ? ` → ${rep.reasoning.confidence}`
                    : ""}
                </td>
                <td>{r.error ?? ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
    </Layout>
  );
};

const REPLAY_BAR_STYLES = `
  .replay-bar { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 16px; font-family: var(--sans); font-size: 13px; }
  .replay-bar a { padding: 5px 10px; border: 1px solid var(--rule); background: #fff; color: var(--ink); text-decoration: none; }
  .replay-bar a:hover { border-color: var(--ink); }

  .diff-sbs { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 16px 0 0; }
  .diff-sbs .col { background: #fff; border: 1px solid var(--rule); padding: 14px 16px; min-width: 0; }
  .diff-sbs .col h3 { margin: 0 0 10px; font-family: var(--sans); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--ink-soft); font-weight: 600; }
  .diff-sbs .col pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: var(--serif); font-size: 15px; line-height: 1.55; }

  /* Expand the content area past .wrap's 680px so columns have room. */
  .diff-wrap { max-width: 1280px; margin-left: auto; margin-right: auto; }
  .wrap:has(.diff-wrap) { max-width: 1280px; }

  @media (max-width: 880px) {
    .diff-sbs { grid-template-columns: 1fr; }
  }
`;

// Parse a composer-replay *.diff.md file into three parts:
//   header   — everything before the first `---`
//   original — between `## Original` and the next `---`
//   replay   — after `## Replay`
// Returns null if the content doesn't match the replay-diff shape; in
// that case the caller falls back to the single-pane view.
function parseReplayDiff(content: string): {
  header: string;
  original: string;
  replay: string;
} | null {
  const original = content.match(/## Original\s*\n([\s\S]*?)\n---\n/);
  const replay = content.match(/## Replay\s*\n([\s\S]*)$/);
  if (!original || !replay) return null;
  const headerEnd = content.indexOf("\n---\n");
  const header =
    headerEnd > 0 ? content.slice(0, headerEnd).trimEnd() : "";
  return {
    header,
    original: original[1]!.trim(),
    replay: replay[1]!.trim(),
  };
}

export const AdminFixtureMarkdown: FC<{
  name: string;
  content: string;
  issueId: number | null;
}> = ({ name, content, issueId }) => {
  const parsed = parseReplayDiff(content);
  return (
    <Layout title={`${name} — fixture`}>
      <style dangerouslySetInnerHTML={{ __html: ADMIN_STYLES + REPLAY_BAR_STYLES }} />
      <AdminNav current="fixtures" />
      {issueId !== null ? (
        <nav class="replay-bar" aria-label="Replay actions">
          <a href="/admin/fixtures">← Fixtures</a>
          <a href={`/admin/review/${issueId}`}>Issue #{issueId} review</a>
          <a href={`/issue/${issueId}`}>Published issue</a>
          <a href={`/admin/fixtures/${name.replace(/\.diff\.md$/, ".html")}`}>
            Rendered brief
          </a>
        </nav>
      ) : null}
      <h2>{name}</h2>
      {parsed !== null ? (
        <div class="diff-wrap">
          <pre
            style="white-space: pre-wrap; font-family: var(--sans); font-size: 13px; color: var(--ink-soft); margin: 0 0 14px;"
          >
            {parsed.header}
          </pre>
          <div class="diff-sbs">
            <div class="col">
              <h3>Original</h3>
              <pre>{parsed.original}</pre>
            </div>
            <div class="col">
              <h3>Replay</h3>
              <pre>{parsed.replay}</pre>
            </div>
          </div>
        </div>
      ) : (
        <pre
          style="white-space: pre-wrap; font-family: var(--serif); font-size: 16px; line-height: 1.6; margin: 0;"
        >
          {content}
        </pre>
      )}
    </Layout>
  );
};

// Wraps composer-replay *.html (the rendered brief) in admin chrome so
// you can click back to the issue without losing context.
export const AdminReplayBrief: FC<{
  name: string;
  html: string;
  issueId: number | null;
}> = ({ name, html, issueId }) => (
  <Layout title={`${name} — replay`}>
    <style dangerouslySetInnerHTML={{ __html: ADMIN_STYLES + REPLAY_BAR_STYLES }} />
    <AdminNav current="fixtures" />
    {issueId !== null ? (
      <nav class="replay-bar" aria-label="Replay actions">
        <a href="/admin/fixtures">← Fixtures</a>
        <a href={`/admin/review/${issueId}`}>Issue #{issueId} review</a>
        <a href={`/issue/${issueId}`}>Published issue</a>
        <a href={`/admin/fixtures/${name.replace(/\.html$/, ".diff.md")}`}>
          Side-by-side diff
        </a>
      </nav>
    ) : null}
    <div class="issue-body" dangerouslySetInnerHTML={{ __html: html }} />
  </Layout>
);

function diffsFrom(
  cap: CapturedRow["raw_output"],
  rep: CapturedRow["raw_output"],
): boolean {
  return (
    cap.classification.category !== rep.classification.category ||
    cap.classification.early_reject !== rep.classification.early_reject ||
    cap.reasoning.confidence !==
      rep.reasoning.confidence ||
    cap.scores.composite !== rep.scores.composite
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

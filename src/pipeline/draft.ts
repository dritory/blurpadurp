// Draft actions: publish, discard, recompose, reedit.
//
// Called by the admin review page. Each action is idempotent-adjacent:
// publish/discard only operate on drafts (is_draft=true) and are no-ops
// if called on a published issue. Recompose and reedit require a draft.
//
// publishDraft flips is_draft=false and marks every pick story as
// published_to_reader=true in one transaction. Next hourly dispatch
// picks it up; the public pages (/, /archive, /issue) start showing it
// immediately since they filter on is_draft.
//
// discardDraft deletes the issue row. issue_pick and issue_annotation
// cascade. Stories go back into the pool (they were never marked
// published_to_reader, so they show up in the next compose naturally).
//
// recomposeDraft re-runs the composer only — same picks, same editor
// output — to iterate on composer prompt/voice without reshuffling
// editorial choices. Cheap (one LLM call).
//
// reeditDraft re-runs the whole editor → composer path, replacing the
// draft's picks entirely. Use when the editorial choices themselves
// are what you want to iterate.

import { sql } from "kysely";

import { makeComposer } from "../ai/composer.ts";
import { db } from "../db/index.ts";
import type { ComposerInput } from "../shared/composer-schema.ts";
import { loadSystemPromptText } from "../shared/prompts.ts";
import { buildPickRows, produceDraft } from "./compose.ts";

export async function publishDraft(issueId: number): Promise<boolean> {
  return db.transaction().execute(async (tx) => {
    // Allocate the public issue number from max+1 inside the same
    // transaction. Doing this in SQL (not as a JS read-then-write) keeps
    // it race-safe under the unique partial index on published_seq:
    // two simultaneous publishes would collide on the index, the loser
    // retries. Compose runs weekly so contention is theoretical, but
    // the unique index is cheap insurance.
    const updated = await tx
      .updateTable("issue")
      .set({
        is_draft: false,
        published_at: new Date(),
        published_seq: sql<number>`coalesce(
          (SELECT max(published_seq) FROM issue WHERE published_seq IS NOT NULL),
          0
        ) + 1`,
      })
      .where("id", "=", issueId)
      .where("is_draft", "=", true)
      .returning("id")
      .executeTakeFirst();
    if (updated === undefined) return false;

    const picks = await tx
      .selectFrom("issue_pick")
      .select("story_id")
      .where("issue_id", "=", issueId)
      .execute();
    const storyIds = picks.map((p) => Number(p.story_id));
    if (storyIds.length > 0) {
      await tx
        .updateTable("story")
        .set({ published_to_reader: true, published_to_reader_at: new Date() })
        .where("id", "in", storyIds)
        .execute();

      // Bump per-theme counter (used by /admin/themes for "stories
      // published" column). One increment per distinct theme — count
      // the stories that just flipped, not the issue, so an arc that
      // bundles three stories on the same theme adds three.
      await tx
        .updateTable("theme")
        .set((eb) => ({
          n_stories_published: eb("n_stories_published", "+", sql<number>`(
            SELECT count(*)::int FROM story s
            WHERE s.theme_id = theme.id AND s.id IN (${sql.join(storyIds)})
          )`),
        }))
        .where(({ exists, selectFrom }) =>
          exists(
            selectFrom("story as s")
              .select("s.id")
              .whereRef("s.theme_id", "=", "theme.id")
              .where("s.id", "in", storyIds),
          ),
        )
        .execute();
    }
    return true;
  });
}

export async function discardDraft(issueId: number): Promise<boolean> {
  // dispatch_log.issue_id REFERENCES issue(id) with no ON DELETE CASCADE
  // (unlike issue_pick / issue_annotation). A draft that's been emailed
  // to reviewers therefore has dispatch_log rows, and deleting the issue
  // would hit the FK. Drop those rows first, in the same transaction —
  // they log sends for an issue that never shipped, so there's nothing
  // worth keeping. (Published issues are never deleted, so this only
  // ever touches draft-send rows.)
  return db.transaction().execute(async (tx) => {
    // Drop send-log rows first (the FK points this way), but only for a
    // genuine draft — the EXISTS guard keeps a non-draft id from
    // clearing a published issue's audit log.
    await tx
      .deleteFrom("dispatch_log")
      .where("issue_id", "=", issueId)
      .where(({ exists, selectFrom }) =>
        exists(
          selectFrom("issue")
            .select("id")
            .where("id", "=", issueId)
            .where("is_draft", "=", true),
        ),
      )
      .execute();
    const result = await tx
      .deleteFrom("issue")
      .where("id", "=", issueId)
      .where("is_draft", "=", true)
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0) > 0;
  });
}

export type RecomposeResult =
  | { ok: true }
  | { ok: false; reason: "not_draft" | "missing_input" };

export async function recomposeDraft(issueId: number): Promise<RecomposeResult> {
  const iss = await db
    .selectFrom("issue")
    .select(["id", "is_draft", "composer_input_jsonb"])
    .where("id", "=", issueId)
    .executeTakeFirst();
  if (iss === undefined || !iss.is_draft) return { ok: false, reason: "not_draft" };
  if (iss.composer_input_jsonb === null)
    return { ok: false, reason: "missing_input" };
  return runRecompose(issueId, iss.composer_input_jsonb);
}

// Replay-and-replace on a PUBLISHED issue. Overwrites composed_html /
// composed_markdown / title in place; no edit history, no rollback.
// Cheat hatch for the case where a prompt rev produces meaningfully
// better prose than what shipped — published issues are normally
// supposed to be a stable record (silence-is-a-feature, every scored
// item persisted forever — see CLAUDE.md), so this exists for the
// small-audience case where re-rendering a past issue is preferable
// to it standing as published. Use sparingly.
export type ReplayReplaceResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "missing_input" };

export async function replayReplaceIssue(
  issueId: number,
): Promise<ReplayReplaceResult> {
  const iss = await db
    .selectFrom("issue")
    .select(["id", "composer_input_jsonb"])
    .where("id", "=", issueId)
    .executeTakeFirst();
  if (iss === undefined) return { ok: false, reason: "not_found" };
  if (iss.composer_input_jsonb === null)
    return { ok: false, reason: "missing_input" };
  return runRecompose(issueId, iss.composer_input_jsonb);
}

async function runRecompose(
  issueId: number,
  composerInput: unknown,
): Promise<{ ok: true }> {
  const cfg = await loadComposerConfig();
  const prompt = await loadSystemPromptText(
    "composer",
    "docs/composer-prompt.md",
    "replay",
  );
  const effectiveVersion =
    prompt.source === "staged"
      ? `${cfg.promptVersion}-staged`
      : cfg.promptVersion;
  const composer = makeComposer({
    version: effectiveVersion,
    modelId: cfg.modelId,
    promptPath: "docs/composer-prompt.md",
    maxTokens: cfg.maxTokens,
    systemPromptText: prompt.text,
  });

  const input = composerInput as unknown as ComposerInput;
  const output = await composer.run(input);

  await db
    .updateTable("issue")
    .set({
      title: output.title,
      composed_markdown: output.markdown,
      composed_html: output.html,
      composer_prompt_version: effectiveVersion,
      composer_model_id: cfg.modelId,
    })
    .where("id", "=", issueId)
    .execute();

  return { ok: true };
}

export type ReeditResult =
  | { ok: true }
  | { ok: false; reason: "not_draft" | "no_pool" };

export async function reeditDraft(issueId: number): Promise<ReeditResult> {
  const iss = await db
    .selectFrom("issue")
    .select(["id", "is_draft"])
    .where("id", "=", issueId)
    .executeTakeFirst();
  if (iss === undefined || !iss.is_draft) return { ok: false, reason: "not_draft" };

  // Release current picks first so stories are eligible for the editor
  // pool query again (it filters by published_to_reader=false AND
  // NOT EXISTS in issue_pick for drafts — actually the pool query
  // doesn't exclude draft picks today because the single-draft guard
  // makes that unnecessary; deleting picks here is still the right
  // move so the re-edit path starts from a clean slate).
  await db.deleteFrom("issue_pick").where("issue_id", "=", issueId).execute();

  const draft = await produceDraft("replay");
  if (draft === null) return { ok: false, reason: "no_pool" };

  await db.transaction().execute(async (tx) => {
    await tx
      .updateTable("issue")
      .set({
        title: draft.output.title,
        composed_markdown: draft.output.markdown,
        composed_html: draft.output.html,
        story_ids: draft.storyIds,
        composer_prompt_version: draft.cfg["composer.prompt_version"],
        composer_model_id: draft.cfg["composer.model_id"],
        editor_input_jsonb: JSON.stringify(draft.editorInput) as never,
        editor_output_jsonb: JSON.stringify(draft.editorResult) as never,
        shrug_candidates_jsonb: JSON.stringify(draft.shrug) as never,
        composer_input_jsonb: JSON.stringify(draft.composerInput) as never,
      })
      .where("id", "=", issueId)
      .execute();

    const pickRows = buildPickRows(issueId, draft.composerInput);
    if (pickRows.length > 0) {
      await tx.insertInto("issue_pick").values(pickRows).execute();
    }
  });

  return { ok: true };
}

async function loadComposerConfig(): Promise<{
  promptVersion: string;
  modelId: string;
  maxTokens: number;
}> {
  const rows = await db
    .selectFrom("config")
    .select(["key", "value"])
    .where("key", "in", [
      "composer.prompt_version",
      "composer.model_id",
      "composer.max_tokens",
    ])
    .execute();
  const map: Record<string, unknown> = {};
  for (const r of rows) map[r.key] = r.value;
  return {
    promptVersion: String(map["composer.prompt_version"]),
    modelId: String(map["composer.model_id"]),
    maxTokens: Number(map["composer.max_tokens"]),
  };
}

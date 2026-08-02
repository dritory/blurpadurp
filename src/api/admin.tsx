// Admin routes (registered only when ADMIN_PASSWORD is set — see the gate
// in index.tsx). Extracted from index.tsx (#9). The admin data loaders
// live in loaders.tsx; this module is the route handlers + their wiring.

import type { Hono, } from "hono";
import { sql } from "kysely";
import { resolve } from "node:path";

import { db } from "../db/index.ts";
import {
  composeDraftFromInput,
  discardDraft,
  publishDraft,
  recomposeDraft,
  reeditDraft,
  replayReplaceIssue,
} from "../pipeline/draft.ts";
import type {
  CapturedRow,
  ReplayRow,
} from "../pipeline/fixture.ts";
import { replayComposer, summarizeReplay } from "../pipeline/fixture.ts";
import { loadPipelineStatus } from "./status.ts";
import { loadStorageStatus } from "./storage-status.ts";
import { AdminStatus } from "../views/admin-status.tsx";
import { normalizeHost } from "../shared/source-blocklist.ts";
import { signToken, } from "../shared/tokens.ts";
import {
  AdminConfig,
} from "../views/admin-config.tsx";
import {
  AdminCosts,
} from "../views/admin-costs.tsx";
import {
  AdminEval,
} from "../views/admin-eval.tsx";
import {
  AdminExplore,
} from "../views/admin-explore.tsx";
import {
  AdminExploreGate,
} from "../views/admin-explore-gate.tsx";
import {
  AdminExploreStories,
} from "../views/admin-explore-stories.tsx";
import {
  AdminExploreDropped,
} from "../views/admin-explore-dropped.tsx";
import {
  AdminExploreBalance,
} from "../views/admin-explore-balance.tsx";
import {
  AdminExploreStory,
} from "../views/admin-explore-story.tsx";
import {
  AdminCaptureView,
  AdminFixtureMarkdown,
  AdminFixturesList,
  AdminReplayBrief,
  AdminReplayView,
} from "../views/admin-fixtures.tsx";
import {
  AdminIssues,
} from "../views/admin-issues.tsx";
import {
  AdminPrompts,
  type PromptStageKey,
} from "../views/admin-prompts.tsx";
import {
  AdminReview,
  AnnotationsList,
} from "../views/admin-review.tsx";
import {
  AdminThemes,
} from "../views/admin-themes.tsx";
import {
  AdminThemeDetail,
} from "../views/admin-theme-detail.tsx";
import {
  AdminThemeGraph,
} from "../views/admin-theme-graph.tsx";
import {
  AdminSources,
  type HostSortDir,
  type HostSortKey,
} from "../views/admin-sources.tsx";
import {
  AdminReviewers,
} from "../views/admin-reviewers.tsx";
import {
  AdminPathFilters,
} from "../views/admin-path-filters.tsx";
import {
  AdminTitleFilters,
} from "../views/admin-title-filters.tsx";
import {
  AdminGlossTerms,
} from "../views/admin-gloss-terms.tsx";
import { validateTitleRegex } from "../shared/title-noise.ts";
import { AdminRelease, type ReleaseData } from "../views/admin-release.tsx";
import { resendDraftToReviewers } from "../pipeline/dispatch.ts";
import {
  runCheckAndStore,
  runCheckOnMarkdown,
  findingsToNotes,
} from "../shared/auto-fix.ts";
import type {
  CheckResult,
  CheckFinding,
  FixCandidate,
} from "../shared/check-schema.ts";
import {
  AdminScheduler,
} from "../views/admin-scheduler.tsx";
import {
  getStage as getSchedulerStage,
} from "../scheduler.ts";
import {
  AdminEditorSandbox,
} from "../views/admin-editor-sandbox.tsx";
import {
  listFixtures,
  loadCostData,
  clampInt,
  loadExplorerData,
  parseStoryFilter,
  normalizePathPattern,
  loadPathFiltersData,
  loadTitleFiltersData,
  loadGlossTermsData,
  loadReleaseData,
  loadSchedulerData,
  loadStoriesData,
  loadStoryDrilldown,
  parseDroppedFilter,
  loadDroppedData,
  parseBalanceFilter,
  loadBalanceData,
  loadGateSandboxData,
  loadEvalStats,
  loadNextEvalCandidate,
  parseThemeFilter,
  parseFlashGeneric,
  loadReviewersData,
  loadSourcesData,
  loadThemesData,
  loadThemeDetail,
  loadEditorSandboxData,
  loadThemeGraphData,
  loadConfigRows,
  parseConfigFlash,
  loadAnnotations,
  loadIssueSnippets,
  loadReview,
  loadReplaysForIssue,
  loadEditorReplaysForIssue,
  loadAdminIssues,
  loadPromptEditor,
  parseReviewFlash,
} from "./loaders.tsx";
import { PUBLIC_URL } from "./config.ts";

// Queue a stage for the next scheduler tick, with an optional jsonb
// payload (mig 067). UPSERT rather than DO NOTHING: `stage` is the
// primary key, which usefully caps the queue at one pending run per
// stage, but with args in play a second request carrying *different*
// parameters must replace the first rather than be silently dropped.
async function queueStageRun(stage: string, args: unknown): Promise<void> {
  const payload = args === null ? null : (JSON.stringify(args) as never);
  await db
    .insertInto("pipeline_force_run")
    .values({ stage, args: payload })
    .onConflict((oc) =>
      oc.column("stage").doUpdateSet({ args: payload, requested_at: new Date() }),
    )
    .execute();
}

export function registerAdminRoutes(app: Hono): void {
  app.get("/admin", (c) => c.redirect("/admin/issues", 302));

  app.get("/admin/release", async (c) => {
    const q = c.req.query();
    let flash: ReleaseData["flash"] = null;
    if (q.queued === "plain")
      flash = { kind: "ok", msg: "Normal compose queued — fresh week only." };
    else if (q.queued === "ranked")
      flash = {
        kind: "ok",
        msg: "Catch-up compose queued with the top-ranked backlog items.",
      };
    else if (q.queued === "selected")
      flash = {
        kind: "ok",
        msg: `Catch-up compose queued with ${q.n ?? "0"} selected item(s).`,
      };
    else if (q.error === "draft_open")
      flash = {
        kind: "err",
        msg: "An open draft blocks compose — publish or discard it first.",
      };
    else if (q.error === "no_selection")
      flash = {
        kind: "err",
        msg: "No stories selected. Tick some, or use one of the other two buttons.",
      };
    return c.html(<AdminRelease data={await loadReleaseData(flash)} />);
  });

  // Queue a compose run from the console. Three modes: 'plain' (fresh
  // week only), 'ranked' (fresh week + top-N backlog by durable
  // significance), 'selected' (fresh week + exactly these story ids).
  //
  // Queues rather than runs: compose can take minutes and the web
  // machine idle-stops out from under long work, which is why manual
  // triggers have always gone through pipeline_force_run (mig 043).
  app.post("/admin/release/compose", async (c) => {
    const body = await c.req.parseBody({ all: true });
    const mode = String(body.mode ?? "plain");

    // Refuse early rather than letting the operator queue a run that
    // compose will silently skip — that indistinguishability is the
    // whole reason this page exists.
    const openDraft = await db
      .selectFrom("issue")
      .select("id")
      .where("is_draft", "=", true)
      .executeTakeFirst();
    if (openDraft !== undefined) {
      return c.redirect("/admin/release?error=draft_open", 303);
    }

    if (mode === "plain") {
      await queueStageRun("compose", null);
      return c.redirect("/admin/release?queued=plain", 303);
    }
    if (mode === "ranked") {
      await queueStageRun("compose", { retro: true });
      return c.redirect("/admin/release?queued=ranked", 303);
    }

    const raw = body.story_id;
    const ids = (Array.isArray(raw) ? raw : raw !== undefined ? [raw] : [])
      .map((v) => Number(v))
      .filter((n) => Number.isInteger(n) && n > 0);
    if (ids.length === 0) {
      return c.redirect("/admin/release?error=no_selection", 303);
    }
    await queueStageRun("compose", { retro: { storyIds: ids } });
    return c.redirect(`/admin/release?queued=selected&n=${ids.length}`, 303);
  });

  app.get("/admin/issues", async (c) => {
    const issues = await loadAdminIssues();
    return c.html(<AdminIssues issues={issues} />);
  });

  app.get("/admin/review/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id) || id <= 0) return c.notFound();
    const data = await loadReview(id);
    if (data === null) return c.notFound();
    const [replays, editorReplays] = await Promise.all([
      loadReplaysForIssue(id),
      loadEditorReplaysForIssue(id),
    ]);
    const flash = parseReviewFlash(c.req.query());
    const shareToken = c.req.query("share_token");
    const shareName = c.req.query("share_name");
    const share =
      shareToken !== undefined &&
      shareToken.length > 0 &&
      shareName !== undefined &&
      shareName.length > 0
        ? {
            url: `${PUBLIC_URL}/draft/${id}?token=${encodeURIComponent(shareToken)}`,
            reviewerName: shareName,
          }
        : null;
    return c.html(
      <AdminReview
        data={data}
        replays={replays}
        editorReplays={editorReplays}
        flash={flash}
        share={share}
      />,
    );
  });

  app.post("/admin/review/:id/publish", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id) || id <= 0) return c.notFound();
    const ok = await publishDraft(id);
    if (!ok) return c.redirect(`/admin/review/${id}?error=not_draft`, 303);
    return c.redirect(`/admin/review/${id}?published=1`, 303);
  });

  app.post("/admin/review/:id/discard", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id) || id <= 0) return c.notFound();
    const ok = await discardDraft(id);
    if (!ok) return c.redirect(`/admin/review/${id}?error=not_draft`, 303);
    return c.redirect("/admin/issues?discarded=1", 303);
  });

  // Park a draft (or release it) against the auto-publish sweep. Without
  // this, discarding would be the only way to stop a draft you want to
  // sit on — and the sweep sets the same flag itself when a draft hits
  // its deadline still failing the checker, so clearing it here is the
  // "I've looked at it, try again" action.
  app.post("/admin/review/:id/hold", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id) || id <= 0) return c.notFound();
    const body = await c.req.parseBody();
    const hold = String(body.hold ?? "") === "1";
    const updated = await db
      .updateTable("issue")
      .set({ hold })
      .where("id", "=", id)
      .where("is_draft", "=", true)
      .returning("id")
      .executeTakeFirst();
    if (updated === undefined) {
      return c.redirect(`/admin/review/${id}?error=not_draft`, 303);
    }
    return c.redirect(`/admin/review/${id}?${hold ? "held" : "released"}=1`, 303);
  });

  app.post("/admin/review/:id/edit", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id) || id <= 0) return c.notFound();
    const body = await c.req.parseBody();
    const title = String(body.title ?? "").trim();
    const composedHtml = String(body.composed_html ?? "");
    const composedMarkdown = String(body.composed_markdown ?? "");
    if (title.length === 0 || composedHtml.length === 0) {
      return c.redirect(`/admin/review/${id}?error=empty_edit`, 303);
    }
    const updated = await db
      .updateTable("issue")
      .set({
        title,
        composed_html: composedHtml,
        composed_markdown: composedMarkdown,
        // Brief edited by hand — any stored checker result + pending fix
        // proposal are now stale.
        check_jsonb: null,
        fix_candidate_jsonb: null,
      })
      .where("id", "=", id)
      .where("is_draft", "=", true)
      .returning("id")
      .executeTakeFirst();
    if (updated === undefined) {
      return c.redirect(`/admin/review/${id}?error=not_draft`, 303);
    }
    return c.redirect(`/admin/review/${id}?edited=1`, 303);
  });

  // Run the checker (re-lints deterministically for grounding, runs the
  // LLM tasks), persists the task-tagged result on the issue so it
  // survives the redirect + is visible to draft reviewers. Report-only:
  // never touches the brief. Available on any issue.
  app.post("/admin/review/:id/check", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id) || id <= 0) return c.notFound();
    const result = await runCheckAndStore(id);
    if (result === null) {
      return c.redirect(`/admin/review/${id}?error=not_found`, 303);
    }
    if (result === "failed") {
      return c.redirect(`/admin/review/${id}?error=check_failed`, 303);
    }
    return c.redirect(`/admin/review/${id}?checked=1#gloss`, 303);
  });

  // The reject→fix round, NON-DESTRUCTIVELY: feed the current checker
  // findings back into a targeted re-compose (drafts only), re-check the
  // candidate prose, and stash it as a PROPOSAL on fix_candidate_jsonb.
  // The live draft is untouched — the reviewer previews and then Accepts
  // or Discards (routes below). Click again to re-generate the proposal.
  app.post("/admin/review/:id/check-fix", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id) || id <= 0) return c.notFound();
    const iss = await db
      .selectFrom("issue")
      .select(["is_draft", "check_jsonb", "composer_input_jsonb"])
      .where("id", "=", id)
      .executeTakeFirst();
    if (iss === undefined) {
      return c.redirect(`/admin/review/${id}?error=not_found`, 303);
    }
    if (!iss.is_draft) {
      return c.redirect(`/admin/review/${id}?error=fix_not_draft`, 303);
    }
    if (iss.composer_input_jsonb === null) {
      return c.redirect(`/admin/review/${id}?error=fix_failed`, 303);
    }
    // Prefer stored findings; if none stored yet, run a check first.
    let findings: CheckFinding[] =
      (iss.check_jsonb as CheckResult | null)?.findings ?? [];
    if (findings.length === 0) {
      const fresh = await runCheckAndStore(id);
      if (fresh === null || fresh === "failed") {
        return c.redirect(`/admin/review/${id}?error=check_failed`, 303);
      }
      findings = fresh.findings;
    }
    const notes = findingsToNotes(findings);
    if (notes.length === 0) {
      // Findings exist but none are gloss problems we can recompose away.
      return c.redirect(`/admin/review/${id}?nothing_to_fix=1#gloss`, 303);
    }
    let candidate: FixCandidate;
    try {
      const out = await composeDraftFromInput(iss.composer_input_jsonb, notes);
      const recheck = await runCheckOnMarkdown(out.markdown);
      if (recheck === "failed") {
        return c.redirect(`/admin/review/${id}?error=check_failed`, 303);
      }
      candidate = {
        created_at: new Date().toISOString(),
        notes,
        title: out.title,
        composed_markdown: out.markdown,
        composed_html: out.html,
        prompt_version: out.promptVersion,
        model_id: out.modelId,
        check: recheck,
      };
    } catch (err) {
      console.error("[check-fix]", err);
      return c.redirect(`/admin/review/${id}?error=fix_failed`, 303);
    }
    await db
      .updateTable("issue")
      .set({ fix_candidate_jsonb: JSON.stringify(candidate) as never })
      .where("id", "=", id)
      .where("is_draft", "=", true)
      .execute();
    return c.redirect(`/admin/review/${id}?fix_proposed=1#gloss`, 303);
  });

  // Apply a pending fix proposal: copy the candidate prose onto the draft
  // and adopt its re-check as the live result. The ONLY mutation of draft
  // prose in the fix path, and only on explicit reviewer action.
  app.post("/admin/review/:id/check-fix-accept", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id) || id <= 0) return c.notFound();
    const iss = await db
      .selectFrom("issue")
      .select(["is_draft", "fix_candidate_jsonb"])
      .where("id", "=", id)
      .executeTakeFirst();
    if (iss === undefined || !iss.is_draft || iss.fix_candidate_jsonb === null) {
      return c.redirect(`/admin/review/${id}?error=no_proposal`, 303);
    }
    const cand = iss.fix_candidate_jsonb as FixCandidate;
    await db
      .updateTable("issue")
      .set({
        title: cand.title,
        composed_markdown: cand.composed_markdown,
        composed_html: cand.composed_html,
        composer_prompt_version: cand.prompt_version,
        composer_model_id: cand.model_id,
        check_jsonb: JSON.stringify(cand.check) as never,
        fix_candidate_jsonb: null,
      })
      .where("id", "=", id)
      .where("is_draft", "=", true)
      .execute();
    return c.redirect(`/admin/review/${id}?fixed=1#gloss`, 303);
  });

  // Drop a pending fix proposal — draft untouched.
  app.post("/admin/review/:id/check-fix-discard", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id) || id <= 0) return c.notFound();
    await db
      .updateTable("issue")
      .set({ fix_candidate_jsonb: null })
      .where("id", "=", id)
      .execute();
    return c.redirect(`/admin/review/${id}?fix_discarded=1#gloss`, 303);
  });

  // Non-destructive composer replay: re-runs the composer on the
  // issue's persisted composer_input_jsonb using the current prompt +
  // model from config, writes the result to fixtures/, and never
  // touches the issue row. Works for both drafts and published issues
  // — the point is to preview how the latest prompt would render a
  // past issue without overwriting it.
  app.post("/admin/review/:id/replay-composer", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id) || id <= 0) return c.notFound();
    try {
      await replayComposer({ issueId: id });
    } catch (err) {
      console.error("[replay-composer]", err);
      return c.redirect(`/admin/review/${id}?error=replay_failed`, 303);
    }
    return c.redirect(`/admin/review/${id}?replayed=1`, 303);
  });

  // Destructive: re-runs the composer using the current prompt + model
  // and overwrites the issue's stored prose. Same code path as
  // recomposeDraft minus the is_draft gate. Cheat hatch for the rare
  // case where a prompt rev produces meaningfully better prose than
  // what shipped and the audience is small enough that rewriting a
  // published issue in-place is acceptable. The UI gates this behind a
  // strong confirm.
  app.post("/admin/review/:id/replay-replace", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id) || id <= 0) return c.notFound();
    try {
      const res = await replayReplaceIssue(id);
      if (!res.ok) {
        return c.redirect(`/admin/review/${id}?error=${res.reason}`, 303);
      }
    } catch (err) {
      console.error("[replay-replace]", err);
      return c.redirect(`/admin/review/${id}?error=replay_replace_failed`, 303);
    }
    return c.redirect(`/admin/review/${id}?replay_replaced=1`, 303);
  });

  app.post("/admin/review/:id/share", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id) || id <= 0) return c.notFound();
    const body = await c.req.parseBody();
    const reviewerName = String(body.reviewer_name ?? "").trim().slice(0, 60);
    if (reviewerName.length === 0) {
      return c.redirect(`/admin/review/${id}?error=empty_reviewer`, 303);
    }
    const iss = await db
      .selectFrom("issue")
      .select("is_draft")
      .where("id", "=", id)
      .executeTakeFirst();
    if (iss === undefined || !iss.is_draft) {
      return c.redirect(`/admin/review/${id}?error=not_draft_share`, 303);
    }
    const token = signToken({
      kind: "draft-preview",
      subscriptionId: id,
      reviewerName,
    });
    const params = new URLSearchParams({
      shared: "1",
      share_token: token,
      share_name: reviewerName,
    });
    return c.redirect(`/admin/review/${id}?${params.toString()}#share`, 303);
  });

  // Manual re-send of the draft-preview email to reviewers who haven't
  // already received this draft (new reviewers + prior failed sends).
  // The hourly sweep sends each draft once; this is the operator's
  // override for "I added a reviewer" / "a send bounced" / "I just
  // re-composed and want it back out now".
  app.post("/admin/review/:id/resend-draft", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id) || id <= 0) return c.notFound();
    let res: Awaited<ReturnType<typeof resendDraftToReviewers>>;
    try {
      res = await resendDraftToReviewers(id);
    } catch (err) {
      console.error("[resend-draft]", err);
      return c.redirect(`/admin/review/${id}?error=resend_failed#share`, 303);
    }
    if (!res.ok) {
      const code = res.reason === "not_draft" ? "not_draft_share" : "not_found";
      return c.redirect(`/admin/review/${id}?error=${code}#share`, 303);
    }
    const params = new URLSearchParams({
      resent: "1",
      resent_total: String(res.totalReviewers),
      resent_n: String(res.sent),
      resent_failed: String(res.failed),
      resent_targeted: String(res.targeted),
    });
    return c.redirect(`/admin/review/${id}?${params.toString()}#share`, 303);
  });

  app.post("/admin/review/:id/recompose", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id) || id <= 0) return c.notFound();
    try {
      const res = await recomposeDraft(id);
      if (!res.ok)
        return c.redirect(`/admin/review/${id}?error=${res.reason}`, 303);
      return c.redirect(`/admin/review/${id}?recomposed=1`, 303);
    } catch (err) {
      console.error("[recompose]", err);
      return c.redirect(`/admin/review/${id}?error=recompose_failed`, 303);
    }
  });

  app.post("/admin/review/:id/annotate", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id) || id <= 0) return c.notFound();
    const body = await c.req.parseBody();
    // Slot is legacy — the anchor (or its absence) is now the only
    // targeting signal. Hardcode a neutral value so the NOT NULL
    // schema constraint stays satisfied without misleading metadata.
    const slot = "general";
    const text = String(body.body ?? "").trim();
    const rawAnchor = String(body.anchor_key ?? "").trim();
    const anchorKey = rawAnchor.length > 0 ? rawAnchor : null;
    const isHtmx = c.req.header("HX-Request") === "true";
    const renderList = async () => {
      const list = await loadAnnotations(id);
      const snippets = await loadIssueSnippets(id);
      return c.html(
        <AnnotationsList issueId={id} annotations={list} snippets={snippets} />,
      );
    };
    if (text.length === 0) {
      if (isHtmx) return renderList();
      return c.redirect(`/admin/review/${id}?error=empty_note`, 303);
    }
    await db
      .insertInto("issue_annotation")
      .values({ issue_id: id, slot, body: text, anchor_key: anchorKey })
      .execute();
    if (isHtmx) return renderList();
    return c.redirect(`/admin/review/${id}?noted=1#notes`, 303);
  });

  app.post("/admin/review/:id/annotations/:aid/delete", async (c) => {
    const id = Number(c.req.param("id"));
    const aid = Number(c.req.param("aid"));
    if (!Number.isFinite(id) || !Number.isFinite(aid)) return c.notFound();
    await db
      .deleteFrom("issue_annotation")
      .where("id", "=", aid)
      .where("issue_id", "=", id)
      .execute();
    if (c.req.header("HX-Request") === "true") {
      const list = await loadAnnotations(id);
      const snippets = await loadIssueSnippets(id);
      return c.html(
        <AnnotationsList issueId={id} annotations={list} snippets={snippets} />,
      );
    }
    return c.redirect(`/admin/review/${id}?deleted_note=1#notes`, 303);
  });

  app.get("/admin/prompts", async (c) => {
    const stageParam = c.req.query("stage");
    const stage: PromptStageKey =
      stageParam === "editor" ? "editor" : "composer";
    const data = await loadPromptEditor(stage, c.req.query());
    return c.html(<AdminPrompts data={data} />);
  });

  app.post("/admin/prompts/:stage", async (c) => {
    const stageParam = c.req.param("stage");
    const stage: PromptStageKey =
      stageParam === "editor" ? "editor" : "composer";
    const body = await c.req.parseBody();
    const action = String(body.action ?? "save");
    const promptMd = String(body.prompt_md ?? "");

    if (action === "download") {
      return c.body(promptMd, 200, {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="${stage}-prompt.md"`,
      });
    }
    if (action === "clear") {
      await db
        .deleteFrom("prompt_draft")
        .where("stage", "=", stage)
        .execute();
      return c.redirect(`/admin/prompts?stage=${stage}&cleared=1`, 303);
    }
    // save
    if (promptMd.trim().length === 0) {
      return c.redirect(`/admin/prompts?stage=${stage}&error=empty`, 303);
    }
    await db
      .insertInto("prompt_draft")
      .values({ stage, prompt_md: promptMd, updated_at: new Date() })
      .onConflict((oc) =>
        oc.column("stage").doUpdateSet({
          prompt_md: promptMd,
          updated_at: new Date(),
        }),
      )
      .execute();
    return c.redirect(`/admin/prompts?stage=${stage}&saved=1`, 303);
  });

  app.post("/admin/review/:id/reedit", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id) || id <= 0) return c.notFound();
    try {
      const res = await reeditDraft(id);
      if (!res.ok)
        return c.redirect(`/admin/review/${id}?error=${res.reason}`, 303);
      return c.redirect(`/admin/review/${id}?reedited=1`, 303);
    } catch (err) {
      console.error("[reedit]", err);
      return c.redirect(`/admin/review/${id}?error=reedit_failed`, 303);
    }
  });

  app.get("/admin/status", async (c) => {
    const [s, storage] = await Promise.all([
      loadPipelineStatus(),
      loadStorageStatus(),
    ]);
    return c.html(<AdminStatus s={s} storage={storage} />);
  });

  app.get("/admin/scheduler", async (c) => {
    const q = c.req.query();
    const flash =
      q.triggered || q.cleared || q.saved
        ? {
            triggered: q.triggered,
            cleared: q.cleared,
            saved: q.saved,
          }
        : null;
    const data = await loadSchedulerData(flash);
    return c.html(<AdminScheduler d={data} />);
  });

  app.post("/admin/scheduler/edit", async (c) => {
    const form = await c.req.parseBody();
    const stage = String(form.stage ?? "");
    if (getSchedulerStage(stage) === undefined) return c.text("unknown stage", 404);
    const intervalSec = Number(form.interval_sec);
    const enabled = String(form.enabled ?? "1") === "1";
    if (!Number.isFinite(intervalSec) || intervalSec < 60) {
      return c.redirect("/admin/scheduler", 303);
    }
    await db
      .updateTable("pipeline_schedule")
      .set({ interval_sec: Math.floor(intervalSec), enabled, updated_at: sql`now()` })
      .where("stage", "=", stage)
      .execute();
    return c.redirect(`/admin/scheduler?saved=${encodeURIComponent(stage)}`, 303);
  });

  // Manual trigger. Inserts a row into pipeline_force_run; the next
  // scheduler tick (≤1h) drains it and fires the stage on the
  // scheduler machine. We do NOT run pipeline work on the http_service
  // — long stages outlast Fly's idle-stop and get killed mid-flight.
  app.post("/admin/run/:stage", async (c) => {
    const stage = c.req.param("stage");
    if (getSchedulerStage(stage) === undefined) return c.text("unknown stage", 404);
    await queueStageRun(stage, null);
    return c.redirect(`/admin/scheduler?triggered=${encodeURIComponent(stage)}`, 303);
  });

  app.post("/admin/lock/:stage/clear", async (c) => {
    const stage = c.req.param("stage");
    if (getSchedulerStage(stage) === undefined) return c.text("unknown stage", 404);
    await db.deleteFrom("pipeline_lock").where("stage_name", "=", stage).execute();
    return c.redirect(`/admin/scheduler?cleared=${encodeURIComponent(stage)}`, 303);
  });

  app.get("/admin/costs", async (c) => {
    const data = await loadCostData();
    return c.html(<AdminCosts data={data} />);
  });

  app.get("/admin/explore", async (c) => {
    const data = await loadExplorerData();
    return c.html(<AdminExplore data={data} />);
  });

  app.get("/admin/explore/stories", async (c) => {
    const filter = parseStoryFilter(c.req.query());
    const data = await loadStoriesData(filter);
    return c.html(<AdminExploreStories data={data} />);
  });

  app.get("/admin/explore/story/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id) || id <= 0) return c.notFound();
    const d = await loadStoryDrilldown(id);
    if (d === null) return c.notFound();
    return c.html(<AdminExploreStory d={d} />);
  });

  app.get("/admin/explore/dropped", async (c) => {
    const data = await loadDroppedData(parseDroppedFilter(c.req.query()));
    return c.html(<AdminExploreDropped data={data} />);
  });

  app.get("/admin/explore/balance", async (c) => {
    const data = await loadBalanceData(parseBalanceFilter(c.req.query()));
    return c.html(<AdminExploreBalance data={data} />);
  });

  app.get("/admin/explore/gate", async (c) => {
    const q = c.req.query();
    const lookback = clampInt(q.days, 7, 365, 30);
    const x = clampInt(q.x, 0, 25, -1);
    const cf = (q.cf === "low" || q.cf === "medium" || q.cf === "high")
      ? q.cf
      : null;
    const data = await loadGateSandboxData({
      lookbackDays: lookback,
      xThreshold: x,
      confidenceFloor: cf,
    });
    return c.html(<AdminExploreGate d={data} />);
  });

  app.get("/admin/explore/editor", async (c) => {
    const data = await loadEditorSandboxData();
    return c.html(<AdminEditorSandbox data={data} />);
  });

  app.get("/admin/explore/graph", async (c) => {
    const q = c.req.query();
    // Defaults tuned post-embedding-upgrade. With better cohesion the
    // signal moved up — at the old 0.65 every theme had 10+ neighbors,
    // graph became unreadable. 0.80 keeps only meaningfully-similar
    // pairs. Singletons hidden by default since 735/873 are singletons
    // and they swamp the multi-story themes visually; toggle them on
    // to investigate "did this story attach to anything?" cases.
    const minCosineRaw = Number(q.min_cosine ?? "0.80");
    const minCosine = Number.isFinite(minCosineRaw)
      ? Math.max(0.5, Math.min(0.99, minCosineRaw))
      : 0.80;
    const category = typeof q.category === "string" && q.category !== ""
      ? q.category
      : null;
    // Hide singletons by default. The form uses an inverted checkbox
    // (`show_singletons`) since unchecked HTML checkboxes are omitted
    // from the form payload — there's no clean way to default a
    // `hide_singletons` checkbox to true without a hidden-field hack.
    const hideSingletons = q.show_singletons !== "1";
    const data = await loadThemeGraphData({
      minCosine,
      category,
      hideSingletons,
    });
    return c.html(<AdminThemeGraph data={data} />);
  });

  app.get("/admin/themes", async (c) => {
    const filter = parseThemeFilter(c.req.query("filter"));
    const data = await loadThemesData(
      filter,
      parseFlashGeneric(c.req.query("saved"), c.req.query("error")),
    );
    return c.html(<AdminThemes data={data} />);
  });

  app.get("/admin/themes/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id) || id <= 0) return c.notFound();
    const data = await loadThemeDetail(id);
    if (data === null) return c.notFound();
    return c.html(<AdminThemeDetail data={data} />);
  });

  app.post("/admin/themes/toggle", async (c) => {
    const body = await c.req.parseBody();
    const themeId = Number(body.theme_id);
    const next = body.next === "on";
    const filter = parseThemeFilter(
      typeof body.filter === "string" ? body.filter : undefined,
    );
    if (!Number.isFinite(themeId) || themeId <= 0) {
      return c.redirect(`/admin/themes?filter=${filter}&error=bad_id`, 303);
    }
    await db
      .updateTable("theme")
      .set({ is_long_running: next })
      .where("id", "=", themeId)
      .execute();
    return c.redirect(`/admin/themes?filter=${filter}&saved=1`, 303);
  });

  app.get("/admin/sources", async (c) => {
    const win = Number(c.req.query("window"));
    const windowDays = [7, 14, 30, 60, 90].includes(win) ? win : 30;
    const rawSort = c.req.query("sort");
    const sort: HostSortKey = (
      ["host", "ingested", "passed", "passRate", "published"] as const
    ).includes(rawSort as HostSortKey)
      ? (rawSort as HostSortKey)
      : "ingested";
    const dir: HostSortDir =
      c.req.query("dir") === "asc" ? "asc" : "desc";
    const data = await loadSourcesData(windowDays, sort, dir, c.req.query());
    return c.html(<AdminSources data={data} />);
  });

  app.post("/admin/sources/block", async (c) => {
    const body = await c.req.parseBody({ all: true });
    const reasonRaw = String(body.reason ?? "").trim();
    // Accept body.host as either a single string (typed-in form, "block
    // this source" button) or an array (bulk-block checkboxes from the
    // hosts-seen table). parseBody({all:true}) gives arrays for repeated
    // names; collapse both shapes into a flat list.
    const rawList = Array.isArray(body.host)
      ? body.host.map(String)
      : body.host !== undefined
        ? [String(body.host)]
        : [];
    const trimmed = rawList.map((s) => s.trim()).filter((s) => s.length > 0);
    if (trimmed.length === 0) {
      return c.redirect("/admin/sources?error=empty_host", 303);
    }
    const hosts: string[] = [];
    for (const raw of trimmed) {
      let host: string | null = null;
      try {
        const u = new URL(raw);
        host = normalizeHost(u.hostname);
      } catch {
        host = normalizeHost(raw.replace(/^https?:\/\//, "").split("/")[0]!);
      }
      if (host !== null && host.length > 0 && host.includes(".")) {
        hosts.push(host);
      }
    }
    if (hosts.length === 0) {
      return c.redirect("/admin/sources?error=bad_host", 303);
    }
    const dedup = [...new Set(hosts)];
    await db
      .insertInto("source_blocklist")
      .values(
        dedup.map((host) => ({
          host,
          reason: reasonRaw.length > 0 ? reasonRaw : null,
        })),
      )
      .onConflict((oc) => oc.column("host").doNothing())
      .execute();
    const flashKey = dedup.length === 1 ? "blocked" : "blocked_n";
    const flashVal =
      dedup.length === 1
        ? encodeURIComponent(dedup[0]!)
        : String(dedup.length);
    return c.redirect(
      `/admin/sources?${flashKey}=${flashVal}#hosts-seen`,
      303,
    );
  });

  app.post("/admin/sources/unblock", async (c) => {
    const body = await c.req.parseBody();
    const host = normalizeHost(String(body.host ?? "").trim());
    if (host.length === 0)
      return c.redirect("/admin/sources?error=empty_host", 303);
    await db
      .deleteFrom("source_blocklist")
      .where("host", "=", host)
      .execute();
    return c.redirect(`/admin/sources?unblocked=${encodeURIComponent(host)}`, 303);
  });

  app.get("/admin/reviewers", async (c) => {
    const data = await loadReviewersData(c.req.query());
    return c.html(<AdminReviewers data={data} />);
  });

  // Add a reviewer by email. Upsert: if the address already exists we
  // flip is_reviewer on (and clear an unsubscribe) rather than erroring;
  // a fresh address is inserted pre-confirmed so dispatch sends to it on
  // the next sweep without a confirmation round-trip (operator-curated).
  app.post("/admin/reviewers/add", async (c) => {
    const body = await c.req.parseBody();
    const email = String(body.email ?? "").trim().toLowerCase();
    // Same shallow check the public subscribe path uses — a real address
    // has one @ with text either side. Resend rejects the rest.
    if (email.length === 0 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return c.redirect("/admin/reviewers?error=bad_email", 303);
    }
    await db
      .insertInto("email_subscription")
      .values({ email, confirmed_at: new Date(), is_reviewer: true })
      .onConflict((oc) =>
        oc.column("email").doUpdateSet({
          is_reviewer: true,
          unsubscribed_at: null,
          confirmed_at: sql`coalesce(email_subscription.confirmed_at, now())`,
        }),
      )
      .execute();
    return c.redirect(
      `/admin/reviewers?added=${encodeURIComponent(email)}`,
      303,
    );
  });

  app.post("/admin/reviewers/:id/toggle", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id) || id <= 0) return c.notFound();
    const body = await c.req.parseBody();
    const make = String(body.make ?? "") === "1";
    const updated = await db
      .updateTable("email_subscription")
      .set({ is_reviewer: make })
      .where("id", "=", id)
      .returning("email")
      .executeTakeFirst();
    if (updated === undefined) {
      return c.redirect("/admin/reviewers?error=no_subscription", 303);
    }
    return c.redirect(
      `/admin/reviewers?${make ? "promoted" : "demoted"}=${encodeURIComponent(updated.email)}`,
      303,
    );
  });

  app.get("/admin/path-filters", async (c) => {
    const q = c.req.query();
    const flash =
      q.added || q.removed || q.toggled || q.error
        ? {
            added: q.added,
            removed: q.removed,
            toggled: q.toggled,
            error: q.error,
          }
        : null;
    const data = await loadPathFiltersData(flash);
    return c.html(<AdminPathFilters d={data} />);
  });

  app.post("/admin/path-filters/add", async (c) => {
    const body = await c.req.parseBody();
    const pattern = normalizePathPattern(String(body.pattern ?? ""));
    const mode = String(body.mode ?? "block") === "tag" ? "tag" : "block";
    const note = String(body.note ?? "").trim().slice(0, 400) || null;
    if (pattern === null) {
      return c.redirect(
        "/admin/path-filters?error=" + encodeURIComponent("pattern required"),
        303,
      );
    }
    try {
      await db
        .insertInto("url_path_filter")
        .values({ pattern, mode, note })
        .execute();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.redirect(
        "/admin/path-filters?error=" + encodeURIComponent(msg.slice(0, 200)),
        303,
      );
    }
    return c.redirect(
      "/admin/path-filters?added=" + encodeURIComponent(pattern),
      303,
    );
  });

  app.post("/admin/path-filters/toggle", async (c) => {
    const body = await c.req.parseBody();
    const pattern = String(body.pattern ?? "");
    const row = await db
      .selectFrom("url_path_filter")
      .select(["mode"])
      .where("pattern", "=", pattern)
      .executeTakeFirst();
    if (!row) return c.redirect("/admin/path-filters", 303);
    const next = row.mode === "block" ? "tag" : "block";
    await db
      .updateTable("url_path_filter")
      .set({ mode: next })
      .where("pattern", "=", pattern)
      .execute();
    return c.redirect(
      "/admin/path-filters?toggled=" + encodeURIComponent(pattern),
      303,
    );
  });

  app.post("/admin/path-filters/delete", async (c) => {
    const body = await c.req.parseBody();
    const pattern = String(body.pattern ?? "");
    await db
      .deleteFrom("url_path_filter")
      .where("pattern", "=", pattern)
      .execute();
    return c.redirect(
      "/admin/path-filters?removed=" + encodeURIComponent(pattern),
      303,
    );
  });

  app.get("/admin/title-filters", async (c) => {
    const q = c.req.query();
    const flash =
      q.added || q.removed || q.toggled || q.error
        ? {
            added: q.added,
            removed: q.removed,
            toggled: q.toggled,
            error: q.error,
          }
        : null;
    const data = await loadTitleFiltersData(flash);
    return c.html(<AdminTitleFilters d={data} />);
  });

  app.post("/admin/title-filters/add", async (c) => {
    const body = await c.req.parseBody();
    // Title regex is opaque user input — preserve case (regex flags
    // already force `i`-mode at compile time) and only trim outer
    // whitespace. Empty after trim → reject.
    const pattern = String(body.pattern ?? "").trim();
    const mode = String(body.mode ?? "block") === "tag" ? "tag" : "block";
    const note = String(body.note ?? "").trim().slice(0, 400) || null;
    if (pattern.length === 0 || pattern.length > 500) {
      return c.redirect(
        "/admin/title-filters?error=" +
          encodeURIComponent("pattern must be 1–500 chars"),
        303,
      );
    }
    const v = validateTitleRegex(pattern);
    if (!v.ok) {
      return c.redirect(
        "/admin/title-filters?error=" +
          encodeURIComponent("invalid regex: " + v.error),
        303,
      );
    }
    try {
      await db
        .insertInto("title_regex_filter")
        .values({ pattern, mode, note })
        .execute();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.redirect(
        "/admin/title-filters?error=" + encodeURIComponent(msg.slice(0, 200)),
        303,
      );
    }
    return c.redirect(
      "/admin/title-filters?added=" + encodeURIComponent(pattern),
      303,
    );
  });

  app.post("/admin/title-filters/toggle", async (c) => {
    const body = await c.req.parseBody();
    const pattern = String(body.pattern ?? "");
    const row = await db
      .selectFrom("title_regex_filter")
      .select(["mode"])
      .where("pattern", "=", pattern)
      .executeTakeFirst();
    if (!row) return c.redirect("/admin/title-filters", 303);
    const next = row.mode === "block" ? "tag" : "block";
    await db
      .updateTable("title_regex_filter")
      .set({ mode: next })
      .where("pattern", "=", pattern)
      .execute();
    return c.redirect(
      "/admin/title-filters?toggled=" + encodeURIComponent(pattern),
      303,
    );
  });

  app.post("/admin/title-filters/delete", async (c) => {
    const body = await c.req.parseBody();
    const pattern = String(body.pattern ?? "");
    await db
      .deleteFrom("title_regex_filter")
      .where("pattern", "=", pattern)
      .execute();
    return c.redirect(
      "/admin/title-filters?removed=" + encodeURIComponent(pattern),
      303,
    );
  });

  app.get("/admin/gloss-terms", async (c) => {
    const q = c.req.query();
    const flash =
      q.added || q.removed || q.error
        ? { added: q.added, removed: q.removed, error: q.error }
        : null;
    const data = await loadGlossTermsData(flash);
    return c.html(<AdminGlossTerms d={data} />);
  });

  app.post("/admin/gloss-terms/add", async (c) => {
    const body = await c.req.parseBody();
    // A term is a literal name, not a regex — trim and collapse inner
    // whitespace, preserve case (display only; matching is case-
    // insensitive). All-caps terms are pointless here (the linter's
    // acronym detector owns them), so reject them with a hint.
    const term = String(body.term ?? "").trim().replace(/\s+/g, " ");
    const note = String(body.note ?? "").trim().slice(0, 400) || null;
    if (term.length === 0 || term.length > 60) {
      return c.redirect(
        "/admin/gloss-terms?error=" +
          encodeURIComponent("term must be 1–60 chars"),
        303,
      );
    }
    if (/^[A-Z][A-Z0-9]{1,5}$/.test(term)) {
      return c.redirect(
        "/admin/gloss-terms?error=" +
          encodeURIComponent(
            "all-caps acronyms are auto-detected — no need to add them",
          ),
        303,
      );
    }
    try {
      await db
        .insertInto("gloss_term")
        .values({ term, note })
        .onConflict((oc) => oc.column("term").doNothing())
        .execute();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.redirect(
        "/admin/gloss-terms?error=" + encodeURIComponent(msg.slice(0, 200)),
        303,
      );
    }
    return c.redirect(
      "/admin/gloss-terms?added=" + encodeURIComponent(term),
      303,
    );
  });

  app.post("/admin/gloss-terms/delete", async (c) => {
    const body = await c.req.parseBody();
    const term = String(body.term ?? "");
    await db.deleteFrom("gloss_term").where("term", "=", term).execute();
    return c.redirect(
      "/admin/gloss-terms?removed=" + encodeURIComponent(term),
      303,
    );
  });

  app.get("/admin/eval", async (c) => {
    const stats = await loadEvalStats();
    const candidate = await loadNextEvalCandidate();
    const flash =
      c.req.query("saved") !== undefined ? "Labeled. Next:" : null;
    return c.html(<AdminEval stats={stats} candidate={candidate} flash={flash} />);
  });

  app.post("/admin/eval", async (c) => {
    const body = await c.req.parseBody();
    const storyId = Number(body.story_id);
    const label = String(body.label ?? "");
    const notes =
      typeof body.notes === "string" && body.notes.trim().length > 0
        ? body.notes.trim().slice(0, 400)
        : null;
    if (!Number.isFinite(storyId) || storyId <= 0) {
      return c.redirect("/admin/eval", 303);
    }
    if (!["yes", "maybe", "no", "skip"].includes(label)) {
      return c.redirect("/admin/eval", 303);
    }
    await db
      .insertInto("eval_label")
      .values({
        story_id: storyId,
        label: label as "yes" | "maybe" | "no" | "skip",
        notes,
      })
      .onConflict((oc) =>
        oc.column("story_id").doUpdateSet({
          label: label as "yes" | "maybe" | "no" | "skip",
          notes,
          labeled_at: new Date(),
        }),
      )
      .execute();
    return c.redirect("/admin/eval?saved=1", 303);
  });

  app.get("/admin/config", async (c) => {
    const rows = await loadConfigRows();
    const flash = parseConfigFlash(
      c.req.query("saved"),
      c.req.query("error"),
      c.req.query("key"),
    );
    return c.html(<AdminConfig rows={rows} flash={flash} />);
  });

  app.get("/admin/fixtures", async (c) => {
    const files = await listFixtures();
    return c.html(<AdminFixturesList files={files} />);
  });

  app.get("/admin/fixtures/:name", async (c) => {
    const name = c.req.param("name");
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) return c.notFound();
    const path = resolve("fixtures", name);
    const text = await Bun.file(path).text().catch(() => null);
    if (text === null) return c.notFound();

    const issueIdMatch = /^(?:composer|editor)-replay-i(\d+)-/.exec(name);
    const issueId = issueIdMatch && issueIdMatch[1] !== undefined
      ? Number(issueIdMatch[1])
      : null;

    // Composer-replay HTML: wrap the rendered brief in admin chrome so
    // you can click back to the issue review without losing context.
    if (name.endsWith(".html")) {
      return c.html(
        <AdminReplayBrief name={name} html={text} issueId={issueId} />,
      );
    }

    // Composer- and editor-replay diffs: side-by-side markdown viewer.
    if (name.endsWith(".diff.md")) {
      return c.html(
        <AdminFixtureMarkdown name={name} content={text} issueId={issueId} />,
      );
    }

    // Editor-replay raw JSON — return as-is for inspection.
    if (name.startsWith("editor-replay-") && name.endsWith(".json")) {
      return c.body(text, 200, { "Content-Type": "application/json" });
    }

    // Scorer fixtures (JSONL).
    const rows = text
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as unknown);
    if (rows.length === 0) return c.text("(empty fixture)", 200);
    const first = rows[0] as Record<string, unknown>;
    if ("replay_output" in first || "replay_prompt_version" in first) {
      const replayRows = rows as ReplayRow[];
      return c.html(
        <AdminReplayView
          name={name}
          rows={replayRows}
          summary={summarizeReplay(replayRows)}
        />,
      );
    }
    if ("raw_input" in first && "raw_output" in first) {
      return c.html(<AdminCaptureView name={name} rows={rows as CapturedRow[]} />);
    }
    return c.text("(unknown fixture format)", 200);
  });

  app.post("/admin/config", async (c) => {
    const body = await c.req.parseBody();
    const key = typeof body.key === "string" ? body.key : "";
    const rawValue = typeof body.value === "string" ? body.value : "";
    if (key === "") {
      return c.redirect("/admin/config?error=missing_key", 303);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawValue);
    } catch {
      return c.redirect(
        `/admin/config?error=bad_json&key=${encodeURIComponent(key)}`,
        303,
      );
    }
    const res = await db
      .updateTable("config")
      .set({
        value: JSON.stringify(parsed) as never,
        updated_at: new Date(),
      })
      .where("key", "=", key)
      .executeTakeFirst();
    if (res.numUpdatedRows === BigInt(0)) {
      return c.redirect(
        `/admin/config?error=unknown_key&key=${encodeURIComponent(key)}`,
        303,
      );
    }
    return c.redirect(
      `/admin/config?saved=1&key=${encodeURIComponent(key)}#cfg-${encodeURIComponent(key)}`,
      303,
    );
  });
}

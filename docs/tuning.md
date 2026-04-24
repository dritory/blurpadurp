# Tuning

How to iterate on prompts and config without draining the pool or
spending money you don't need to spend. Written after the first
half-dozen real compose runs — it codifies the workflow that
actually worked.

## The core principle

**Ingest + score once. Re-compose never. Replay instead.**

Every `bun run cli compose` flips `published_to_reader = true` on
every story it uses (including shrug items now). The next compose
sees a smaller pool. If you compose → read → tweak the composer
prompt → compose again, you're drinking your own bathwater: the
pool is different, the editor picks are different, you can't tell
if the voice change is from your prompt or the new input.

The harness solves this. Capture the scorer's I/O once. Persist the
composer's input with every issue. Then replay either against
different prompts or models. No DB state moves.

## The loop

```
1. One real run (costs real money, captures real state):
   bun run cli ingest
   bun run cli score
   bun run cli compose         # this persists composer_input_jsonb

2. Lock state to disk:
   bun run cli fixture-capture 100
                               # writes fixtures/capture-<ts>.jsonl

3. Note the issue_id:
   psql: SELECT id FROM issue ORDER BY id DESC LIMIT 1;

4. Iterate — zero pool-drain, one Anthropic call per replay:

   # Scorer prompt iteration:
   bun run cli fixture-replay fixtures/capture-<ts>.jsonl \
       docs/scoring-prompt.md prompt-v0.3-draft \
       claude-haiku-4-5-20251001
   # → fixtures/replay-<ts>.jsonl + printed diff summary

   # Composer prompt iteration:
   bun run cli composer-replay <issue_id> docs/composer-prompt.md \
       composer-v0.4-draft claude-sonnet-4-6
   # → fixtures/composer-replay-i<N>-<ts>.md / .html / .diff.md

5. Read the diffs in a markdown viewer OR at /admin/fixtures.

6. When satisfied, bump the config version via migration,
   re-ingest, re-score, re-compose on fresh data.
```

## When to reset state

If you need to re-compose (e.g. you're testing editor + composer
together on the same pool), reset the pool first:

```sql
UPDATE story SET published_to_reader = false, published_to_reader_at = NULL;
DELETE FROM issue;  -- optional; also clears archive
```

This is a dev-only move. Never on production data.

## When to bump versions

Prompts are version-bumped via config migration. The rule:

- **Editing the prompt content without bumping**: drafts, iteration.
  Don't do this against production. On dev it's fine — the scorer's
  cache is keyed on version, so same-version-different-content can
  return stale cached output.
- **Bumping the file header + config migration together**: when
  you're ready to commit to the change. Pattern:
  `migrations/0XX_composer_v0_N.sql` with an UPDATE on
  `config.composer.prompt_version`.

Look at `migrations/013_prompt_versions.sql` as the canonical
example.

## Diagnosis paths

When output looks wrong, trace backwards through the pipeline:

| Symptom | First check | Then |
|---|---|---|
| Voice drift / bloat / meta-framing | `docs/composer-prompt.md` — did a recent edit weaken a rule? Grep for the banned phrase in prompt. | `composer-replay` with a known-good version vs current to isolate. |
| Story should have been in arc but came as single | `/admin/review/<issue_id>` — do the picks share a `theme_id`? | If same theme: editor prompt failed — grep `← arc` logic in `editor-prompt.md`. If different themes: theme-attach failed — `src/ai/theme-confirm.ts`. |
| Worth watching is empty | Pool's confidence distribution — `SELECT point_in_time_confidence, count(*) FROM story WHERE scored_at >= now() - interval '30 days' GROUP BY 1`. If few low items, rank-based fallback is kicking in. | Check `CONVERSATION_TOP_N` / `WORTH_KNOWING_TOP_N` in `compose.ts`. Worth watching gets ranks 11+. |
| Shrug items repeat | `SELECT id, title, published_to_reader FROM story WHERE id IN (<shrug ids from last issue>)`. | If `published_to_reader = false`, `persistIssue` didn't mark them. Check the storyIds union logic. |
| Cost spiked | `/admin/costs` — which stage? | If scorer: ingest dumped a flood. If composer: prompt-version bump invalidated cache. |
| Gate firing too often / rarely | `/admin/explore/gate` sandbox — slide the threshold, see the eval-label hit rate. | Adjust `config.gate.x_threshold` via `/admin/config`. |

## Tuning prompts: the prompt-first vs code-first rule

Default preference: **hard structure beats prompt instructions.**

If you find yourself writing "the model should not do X" in a prompt,
ask whether the code can prevent X instead:
- "Don't put watch-worthy items in Conversation" → compose.ts
  pre-sorts into `conversation[]`.
- "Group stories by theme" → editor returns arc picks; compose.ts
  expands into ComposerInput.items.
- "Only cite tier-1 sources" → `src/shared/source-tiers.ts` filters
  at ingest.

Reserve prompt instructions for things code can't enforce: voice
register, word choice, observation-vs-summary framing. That's what
models are good at.

## Eval loop (coming, not yet in use)

Label stories at `/admin/eval` (yes / maybe / no / skip). Then
`bun run cli eval` reports precision/recall against the current
gate and sweeps thresholds. Use this BEFORE bumping a prompt
version to see if the new prompt moves the scorer in your
direction.

You need ~50 labels for this to be meaningful. One sitting over
coffee.

## What not to do

- Don't re-run the pipeline to "see what the composer does" — use
  `composer-replay`.
- Don't edit a prompt and leave its version tag unchanged if the
  content materially changed (silent cache hits will haunt you).
- Don't tune in production. Every prompt iteration should pass
  fixture-replay before landing.
- Don't delete `ai_call_log` rows. Ever. They're the training set
  for the eventual surrogate and the drift-detection substrate.
- Don't add new banned phrases to the composer prompt without
  a before/after example — just listing the phrase isn't
  enforceable.
- Don't lower the gate to fill a quiet week. Silence is correct.

## When you're genuinely stuck

`docs/runbook.md` covers the 12 failure modes that are likely to
surface in production. If the symptom isn't there, the admin
explorer (`/admin/explore`) + gate sandbox (`/admin/explore/gate`)
are designed to answer "what is the algorithm actually doing?"
without opening a SQL client.

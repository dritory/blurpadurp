# Scoring

The scoring prompt is the product. It encodes the editorial voice, the
importance/significance distinction, and the precision bias. This doc
specifies what the scorer must do, which techniques achieve the precision
target, and how we maintain calibration over time.

The prompt itself lives in `scoring-prompt.md` (current version: v2).

## Design target

**Maximize precision on what people discuss now.** Missing a story that
will matter in 12 months but is currently discussed only by specialists is
acceptable (it's scored and logged via `structural_importance` for
retrospective surfacing). Publishing a story nobody discusses is not.
Silence is cheap.

The mission is conversational: a subscriber should be able to quit social
media and still follow every interesting lunch conversation. The gate
measures that directly.

## Point-in-time discipline — the master rule

Every scoring call carries an `as_of_date`. The scorer reasons *as of that
date* and must not reference information that became available after it.

- **In production:** `as_of_date = today`.
- **In Mode A backtest:** `as_of_date = story.published_at`.
- **In Mode B backtest:** `as_of_date` was `today` at the time the score
  was originally produced; nothing changes.

The point-in-time rule is the single defense against hindsight bias, and
it's also what makes backtesting valid. See `backtesting.md`.

Implication for gold anchors: **they are scored the way a well-calibrated
observer would have scored them at the time, not the way we know them now.**
A 2017 transformer paper gets a 0 on zeitgeist (no one was discussing it
in general conversation). Missing that paper is an accepted trade — it is
an in-circle signal, not zeitgeist.

## Rubric axes

| Axis | Question | Role |
|---|---|---|
| **zeitgeist_score** (0–5) | Will informed adults be discussing this in conversations over the next 1–2 weeks? | **Gate** |
| **half_life** (0–5) | How long before this fades from general conversation? | Multiplier |
| **reach** (0–5) | How broadly does "discussing this" span demographics? | Tiebreaker |
| **non_obviousness** (0–5) | Will the reader encounter this in their default channels anyway? | Penalty: subtracted |
| **structural_importance** (0–5) | Does this change the world's long-term trajectory? | **Logged only — does NOT gate** |

The gate is conversational relevance, not world-historical weight.
`structural_importance` is captured on every story (for retrospective
curation and future features) but is not part of the publish decision.

### Gate formula

```
composite = (zeitgeist_score * half_life) - non_obviousness

pass_absolute   = composite >= X
pass_relative   = composite > (theme.rolling_composite_avg + Δ)
pass_confidence = (point_in_time_confidence != "low")
pass            = pass_absolute AND pass_relative AND pass_confidence
```

`X` and `Δ` are the two numeric dials. **Low confidence blocks the gate
regardless of composite.**

Calibrate `X` and `Δ` against historical GDELT data until the weekly pass
rate centers on ~3–10 items. The target silence rate is 1–10% of cycles
(down from v1's 10–30%) — a weekly "what's happening" feed almost always
has something worth covering.

## Precision techniques (inside the scoring prompt)

1. **Cheap early-reject list — applied before scoring.**
   Pattern-match categorical rejects; never spend tokens on them. Rejected
   classes: sports results, celebrity personal lives, single-poll horse-race
   politics, earnings beats, stock moves without policy impact, crime
   stories without systemic angle, weather events without unprecedented
   scale, routine corporate product launches, award ceremonies.

2. **12-month retrodiction field — mandatory output.**
   > *"Imagine the reader reads this 12 months from today. Will knowing this
   > change any decision, belief, or model of the world? Answer with a
   > specific mechanism, not vibes."*

   Vague answer ⇒ auto-fail. Concrete mechanism required.

3. **Forced steelman of triviality AND importance — both mandatory.**
   Before numeric scores, the scorer writes both the strongest case for
   triviality and the strongest case for importance. Reasoning-before-numbers
   prevents "pick a number and rationalize."

4. **Base-rate anchoring.**
   > *"How many events of this class happen per year globally?"*

   High base rate ⇒ importance cap. Low base rate (first-of-kind) ⇒ allowed
   to score high.

5. **Gold anchor examples in the prompt — seven buckets (v2).**
   See `scoring-prompt.md`. Structured as:
   - **A.** Big-and-universally-discussed (easy 5s)
   - **B.** Novel-specialist at the time — ACCEPTED MISSES (low zeitgeist,
     low confidence; may have high `structural_importance`)
   - **C.** Novel-specialist that broke out (publishes once crossover
     evidence exists, e.g., ChatGPT week 1)
   - **D.** Cultural / universal-recognition events (Taylor Swift, Prince)
   - **E.** Hype that broke through (Clubhouse peak, GameStop squeeze —
     publishes this cycle, decays via half_life)
   - **F.** In-circle hype that does NOT break through (rejects —
     `in_circle_hype`, `manufactured_hype`, `controversy_flash`)
   - **G.** Correctly low (default floor)

6. **Theme-history context injection.**
   For themes with prior stories, the scorer receives the theme's timeline.
   Prompt: *"Given these prior events in this theme, does the new event
   materially advance or alter the trajectory?"* Doubles as anti-repetition
   and calibration anchor.

7. **Point-in-time confidence field.**
   Required output. `high` | `medium` | `low`. `low` is a gate-blocker
   regardless of composite score. Novel/unclear/speculative → `low`.

## Structural defenses (extension slots — v1 does not implement)

The scorer JSON schema includes null slots for these to land without churn:

8. **Ensemble for borderline cases.** Populates `verification.ensemble_*`.
9. **Two-stage verification.** Populates `verification.second_pass_*`.
10. **Tool-augmented deep path.** Populates `tools_used`. Triggered only
    for borderline items (fast-path composite within margin of threshold,
    or confidence = medium) — full tool use every call is too slow.

## System-level defenses (maintenance layer)

11. **Gold evaluation set.**
    Hand-label 80–120 historical events across the spectrum as the anchor
    for operator-labeled ground truth. Re-run the scorer against this set
    on every prompt change. Track **precision**, not accuracy.

12. **Pin the model version.**
    Use dated model IDs (e.g. `claude-haiku-4-5-20251001`), not floating
    aliases. Model upgrades silently change world model; upgrade
    deliberately via shadow mode + Mode A backtest.

13. **Shadow mode for prompt changes.**
    Never deploy a rubric change straight to production. Run it in parallel
    for 2–4 weeks. Compare what it *would* have published against what the
    old prompt did. Anything the new prompt would publish that you'd reject
    ⇒ new prompt is worse.

14. **Reader-feedback loop.**
    Every issue item has a one-click "this didn't belong" button. A click
    logs the item + scores + justification to a false-positives table and
    flags it in the gold set.

15. **Reject logging & near-miss review.**
    Log rejected items with their scores. Skim the near-miss list
    (scored just below threshold) monthly.

16. **Rolling backtest (Mode B).**
    The permanent validation layer. See `backtesting.md`. Precision@12w is
    the headline metric; drift = investigate.

## What most protects world-model quality

LLM world models drift when reasoning in isolation. Per-call context
injection is the strongest preservative:

- `as_of_date` (always).
- The theme's prior published summary (recency grounding, anti-repetition).
- GDELT metadata (tone, mention count, source breadth) — ground truth the
  LLM alone can't generate.
- Wikipedia Current Events cross-check (human filter signal).

The scorer is a **reasoner over evidence**, never a remembrance engine.

## Scoring output schema (v1.1)

The scorer returns a single JSON object. Free-text reasoning is paired with
structured companions so the data is SQL-queryable, not just readable.

```json
{
  "schema_version": "2.0",
  "scorer_version": "prompt-v2",
  "scored_at": "ISO-8601",
  "as_of_date": "ISO-8601-date",

  "classification": {
    "category": "<enum: 10 category slugs>",
    "theme_continuation_of": null,
    "early_reject": false,
    "early_reject_reason": null
  },

  "reasoning": {
    "base_rate_estimate": "<free text>",
    "base_rate_per_year": <number>,

    "retrodiction_12mo": "<free text>",

    "steelman_trivial": "<free text>",
    "steelman_important": "<free text>",

    "factors": {
      "trigger":     ["<vocab>", ...],
      "penalty":     ["<vocab>", ...],
      "uncertainty": ["<vocab>", ...]
    },

    "theme_relationship": "<enum>",
    "point_in_time_confidence": "low|medium|high"
  },

  "scores": {
    "zeitgeist_score": 0,
    "half_life": 0,
    "reach": 0,
    "non_obviousness": 0,
    "structural_importance": 0,
    "composite": 0
  },

  "verification": null,
  "tools_used": null,
  "watchlist_signal": null,
  "viral_signals_considered": null,

  "one_line_summary": ""
}
```

composite = (zeitgeist_score * half_life) - non_obviousness.
structural_importance is captured but does NOT enter the composite.

Reasoning fields are written before score fields. The gate reads `scores`,
`reasoning.point_in_time_confidence`, and `reasoning.theme_relationship`
(the last one feeds repetition-suppression weights). Everything else is for
auditability, future extension, and analysis.

### Controlled vocabularies

Full enumeration lives in `scoring-prompt-v1.md`. Summary:

- **trigger** (what pushed zeitgeist/importance up): 11 tags —
  systemic_risk, regulatory_change, technical_breakthrough, novel_finding,
  geopolitical_realignment, cultural_absorption, `crossover_discussion`,
  market_structure_change, precedent_setting, scale_of_impact,
  first_of_kind.
- **penalty** (what dragged scores down): 12 tags — high_base_rate,
  hindsight_required, reversible, single_platform, unreplicated,
  preclinical_only, speculative_forecast, `in_circle_hype`,
  `manufactured_hype`, `controversy_flash`, symbolic_only, narrow_audience.
- **uncertainty** (why confidence is low/medium): 6 tags — novel_event_type,
  insufficient_evidence, contested_interpretation, long_causal_chain,
  no_precedent, counterfactual_required.
- **theme_relationship** (single enum): new_theme, continuation_routine,
  continuation_escalation, continuation_reversal, continuation_resolution.

Vocabularies are extended by convention (new tag = prompt revision + schema
migration + backfill). Not extended at inference time.

### Query patterns this enables

```sql
-- Penalty factors correlated with false positives
SELECT factor, count(*) AS n
FROM story_factor sf
JOIN story s ON s.id = sf.story_id
JOIN ground_truth gt ON gt.story_id = s.id
WHERE sf.kind = 'penalty'
  AND s.passed_gate = true
  AND gt.ground_truth_score < 2
GROUP BY factor
ORDER BY n DESC;

-- Base-rate distribution by category
SELECT category,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY base_rate_per_year) AS median,
       percentile_cont(0.9) WITHIN GROUP (ORDER BY base_rate_per_year) AS p90
FROM story
GROUP BY category;

-- Confidence calibration — precision by uncertainty tag
SELECT unnest(uncertainty) AS tag,
       avg(gt.ground_truth_score) AS avg_gt,
       count(*) AS n
FROM story s JOIN ground_truth gt ON gt.story_id = s.id
WHERE s.passed_gate = true
GROUP BY tag;

-- Repetition-suppression audit
SELECT theme_relationship, count(*) FILTER (WHERE passed_gate) AS passed,
                           count(*) AS total
FROM story GROUP BY theme_relationship;
```

## Minimum viable precision stack

If building staged, these five get ~90% of the precision benefit at ~10% of
the effort:

1. Cheap early-reject list
2. Gold anchor examples in prompt (Buckets A/B/C/D, point-in-time scored)
3. 12-month retrodiction output field
4. Forced dual steelman (trivial + important)
5. Weekly re-run against a 100-item gold set

Everything else is an upgrade.

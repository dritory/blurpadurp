# Scoring

The scoring prompt is the product. It encodes the editorial voice, the
importance/significance distinction, and the precision bias. This doc
specifies what the scorer must do, which techniques achieve the precision
target, and how we maintain calibration over time.

The prompt itself (v1) lives in `scoring-prompt-v1.md`.

## Design target

**Maximize precision. Accept low recall.**

Missing an important story is tolerable. Publishing a dud is not. Silence is
the cheapest failure mode. Every technique in this doc trades recall for
precision.

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
A 2017 transformer paper gets a 3 with low confidence, not a 5. Missing
future winners is an accepted precision/recall tradeoff.

## Rubric axes

| Axis | Question | Role |
|---|---|---|
| **Importance** (0–5) | Does this change the world's trajectory or the reader's model of it? | Gate (hard threshold) |
| **Durability** (0–5) | Will this still matter in 12 months? | Multiplies importance |
| **Non-obviousness** (0–5) | Would the reader learn this anyway? | Penalty: subtracted |
| **Significance** (0–5) | Raw magnitude / scale / attention | Tiebreaker only; cannot pass the gate alone |

*Significance* (magnitude in the moment) and *importance* (matters to
world model / decisions) are deliberately separate. A plane crash is highly
significant but may have low importance. A quiet regulatory change may be
the reverse. The gate uses importance, not significance.

### Gate formula (v1)

```
composite = (importance * durability) - non_obviousness

pass_absolute = composite >= X
pass_relative = composite > (theme.rolling_importance_avg + Δ)
pass_confidence = (point_in_time_confidence != "low")
pass          = pass_absolute AND pass_relative AND pass_confidence
```

`X` and `Δ` are the two numeric dials. **Low confidence blocks the gate
regardless of composite.** This is how point-in-time honesty becomes teeth:
if the scorer can't confidently judge, we don't publish.

Calibrate `X` and `Δ` against historical GDELT data until the weekly pass
rate centers on ~1–5 items across all categories.

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

5. **Gold anchor examples in the prompt — four buckets.**
   See `scoring-prompt-v1.md`. Structured as:
   - **A.** Big-and-recognized-at-the-time (teaches easy 5s)
   - **B.** Novel-but-uncertain (teaches acceptance of missing future
     winners — scored 2–3 with low confidence)
   - **C.** Looked-big-but-fizzled (teaches hype skepticism)
   - **D.** Correctly-low-at-the-time (teaches the default floor)

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

## Scoring output schema (v1)

The scorer returns a single JSON object:

```json
{
  "schema_version": "1.0",
  "scorer_version": "prompt-v1",
  "scored_at": "ISO-8601",
  "as_of_date": "ISO-8601-date",

  "classification": {
    "category": "technology",
    "theme_continuation_of": null,
    "early_reject": false,
    "early_reject_reason": null
  },

  "reasoning": {
    "base_rate_estimate": "...",
    "retrodiction_12mo": "...",
    "steelman_trivial": "...",
    "steelman_important": "...",
    "point_in_time_confidence": "low|medium|high"
  },

  "scores": {
    "importance": 0,
    "durability": 0,
    "non_obviousness": 0,
    "significance": 0,
    "composite": 0
  },

  "verification": null,
  "tools_used": null,
  "watchlist_signal": null,
  "viral_signals_considered": null,

  "one_line_summary": ""
}
```

Reasoning fields are written before score fields. The gate reads `scores`
and `reasoning.point_in_time_confidence`. Everything else is for
auditability and future extension.

## Minimum viable precision stack

If building staged, these five get ~90% of the precision benefit at ~10% of
the effort:

1. Cheap early-reject list
2. Gold anchor examples in prompt (Buckets A/B/C/D, point-in-time scored)
3. 12-month retrodiction output field
4. Forced dual steelman (trivial + important)
5. Weekly re-run against a 100-item gold set

Everything else is an upgrade.

# Scoring

The scoring prompt is the product. It encodes the editorial voice, the
importance/significance distinction, and the precision bias. This doc
specifies what the scorer must do, which techniques achieve the precision
target, and how we maintain calibration over time.

## Design target

**Maximize precision. Accept low recall.**

Missing an important story is tolerable. Publishing a dud is not. Silence is
the cheapest failure mode. Every technique in this doc trades recall for
precision.

## Rubric axes

| Axis | Question | Role |
|---|---|---|
| **Importance** (0–5) | Does this change the world's trajectory or the reader's model of it? | Gate (hard threshold) |
| **Durability** (0–5) | Will this still matter in 12 months? | Multiplies importance |
| **Non-obviousness** (0–5) | Would the reader learn this anyway? | Penalty: subtracted |
| **Significance** (0–5) | Raw magnitude / scale / attention | Tiebreaker only; cannot pass the gate alone |

Note: *significance* (magnitude in the moment) and *importance* (matters to
world model / decisions) are deliberately separate. A plane crash is highly
significant but may have low importance. A quiet regulatory change may be
the reverse. The gate uses importance, not significance.

### Gate formula (v1)

```
composite = (importance * durability) - non_obviousness
pass_absolute = composite >= X
pass_relative = composite > (theme.rolling_importance_avg + Δ)
pass          = pass_absolute AND pass_relative
```

`X` and `Δ` are the two tunable dials. Calibrate against historical GDELT
data until the weekly pass rate centers on ~1–5 items across all categories.

## Precision techniques (inside the scoring prompt)

1. **Cheap early-reject list — applied before scoring.**
   Pattern-match categorical rejects; never spend tokens on them. Rejected
   classes: sports results, celebrity personal lives, single-poll horse-race
   politics, earnings beats, stock moves without policy impact, crime stories
   without systemic angle, weather events without unprecedented scale.

2. **12-month retrodiction field — mandatory output.**
   > *"Imagine the reader reads this 12 months from today. Will knowing this
   > change any decision, belief, or model of the world? Answer with a
   > specific mechanism, not vibes."*

   Vague answer ⇒ auto-fail. Concrete mechanism required.

3. **Forced steelman of triviality — mandatory output.**
   > *"Write the strongest possible case that this story does NOT matter. If
   > that case is stronger than the case for importance, score ≤ 1."*

   Adversarial self-critique kills many borderline false positives.

4. **Base-rate anchoring.**
   > *"How many events of this class happen per year globally?"*

   High base rate ⇒ importance cap. Low base rate (first-of-kind) ⇒ allowed
   to score high.

5. **Gold anchor examples in the prompt.**
   8–12 hand-labeled calibration examples spanning the score range:
   - Obvious 5s: moon landing, GPT-4 release, WHO COVID declaration
   - Obvious 1s: Oscars, Super Bowl halftime, routine congressional bill
   - Hard mid-range: a specific drug approval, a mid-tier diplomatic rupture

6. **Theme-history context injection.**
   For themes with prior stories, the scorer receives the theme's timeline.
   Prompt: *"Given these prior events in this theme: [list]. Does the new
   event materially advance or alter the trajectory?"* Doubles as
   anti-repetition and calibration anchor.

## Structural defenses (around the prompt)

7. **Ensemble for borderline cases.**
   Score twice with rephrased rubrics. Disagreement > 1 point ⇒ route to a
   third-arbiter call or reject outright.

8. **Two-stage threshold.**
   - Stage 1: rubric-based composite ≥ X → advances.
   - Stage 2: independent call, no rubric, just *"Should a curious intelligent
     adult hear about this event today? Yes/no, with reasoning."*

   Both must pass. Redundancy with diverse framings catches different failure
   modes.

9. **Tool-augmented scoring.**
   The scorer has access to:
   - Wikipedia lookup on entities (notability check).
   - Web search for "[event type] base rate" (real numbers, not LLM memory).
   - Search for prior similar events (first-of-kind vs. routine).

## System-level defenses (maintenance layer)

10. **Gold evaluation set.**
    Hand-label 80–120 historical GDELT events across the spectrum. Re-run the
    scorer against this set every week. Track **precision**, not accuracy
    (accuracy rewards rejecting everything). Regression ⇒ freeze publishing,
    diagnose, fix prompt, re-test.

11. **Pin the model version.**
    Use dated model IDs (e.g. `claude-haiku-4-5-20251001`), not floating
    aliases. Model upgrades silently change world model; upgrade deliberately
    via shadow mode.

12. **Shadow mode for prompt changes.**
    Never deploy a rubric change straight to production. Run it in parallel
    for 2–4 weeks. Compare what it *would* have published against what the
    old prompt did. You (the reader) are the eval signal. Anything the new
    prompt would publish that you'd reject ⇒ new prompt is worse.

13. **Reader-feedback loop.**
    Every issue item has a one-click "this didn't belong" button. A click
    logs the item + scores + justification to a false-positives table and
    flags it in the gold set. Over months, the single most valuable asset
    the system accumulates.

14. **Reject logging & near-miss review.**
    Log rejected items with their scores. Skim the near-miss list (scored
    just below threshold) monthly. Missed-but-important ⇒ loosen. The
    opposite ⇒ tighten.

## What most protects world-model quality

LLM world models drift when reasoning in isolation. Per-call context
injection is the strongest preservative:

- Current date (always).
- The theme's prior published summary (recency grounding).
- GDELT metadata (tone, mention count, source breadth) — ground truth the
  LLM alone can't generate.
- Wikipedia Current Events cross-check (human filter signal).

The scorer is a **reasoner over evidence**, never a remembrance engine.

## Minimum viable precision stack

If building staged, these five get ~90% of the precision benefit at ~10% of
the effort:

1. Cheap early-reject list
2. Gold anchor examples in prompt
3. 12-month retrodiction output field
4. Forced steelman of triviality
5. Weekly re-run against a 100-item gold set

Everything else is an upgrade.

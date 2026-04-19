# Backtesting

The scorer's quality is the product. Backtesting is how we measure it
honestly, detect drift over time, and validate prompt changes before they
reach the reader.

## The core trap: training-data leakage

Naive backtest (score a 2023 event, compare to known outcome) is polluted:
the model was **trained on those events and already knows what happened**.
Any apparent accuracy is hindsight laundering, not real-time judgment. A
pre-launch prompt can look calibrated in backtest and be completely blind
in production.

Two backtest modes that avoid this.

## Mode A — Post-cutoff backtest (smoke-test only)

Score only events whose *publication date is strictly after the scorer
model's knowledge cutoff*. The model cannot have memorized their outcomes.

- **Pros:** truly blind judgment on real events.
- **Cons:** narrow window. For a model with cutoff `YYYY-MM`, the usable
  window is from `YYYY-MM` to "far enough in the past that aftermath has
  unfolded" — at most a few months at any given time.
- **Role:** one-shot sanity check before launch and after major prompt
  revisions. Not a continuous metric.

## Mode B — Rolling production backtest (the real asset)

Score events **in real time at ingestion**. Log the score with its full
input. Every N weeks (default 12), take events that were scored 12+ weeks
ago and evaluate them against what has since unfolded.

Why this is clean: at score-time, the model was genuinely blind to the
future (outside its training data, outside its context). The score was a
true prospective judgment. At score-time + 12 weeks, we have ground truth.
The backtest is never contaminated.

Why this is the real asset:
- Accumulates labeled history organically — every week adds a week of it.
- Live metric dashboard: if precision@12w drifts, the prompt is drifting
  (or the world has shifted in a way the prompt doesn't handle).
- No lab/field gap — same prompt, same model, same inputs as production.

Mode A is the pre-launch smoke-test. Mode B is the permanent validation
layer.

## Ground truth construction

"Did it matter" is itself a judgment, not an oracle. We build ground truth
as a **composite** of three signals, with priority given to operator labels
where available.

### 1. Proxy signals (automated, cheap)

Deterministic features computable from public data at `score_time + 12w`:

- **Wikipedia expansion:** did the article or a relevant article gain ≥N
  bytes of text in the 12-week window?
- **Sustained mainstream coverage:** mentions in NYT / Guardian / BBC /
  Reuters / AP in the 30 days leading up to `score_time + 12w` (not just
  the burst at `score_time`)
- **GDELT theme persistence:** is the event's GDELT theme still active
  (stories tagged) at `score_time + 12w`?
- **Google Trends tail:** query volume at `score_time + 12w` ≥ 20% of peak?

Each is a boolean or scaled number. Combined into a composite "impact
score" via simple weighted sum.

### 2. LLM hindsight judge (mid-cost, independent failure modes)

A separate prompt (not the scorer) runs at `score_time + 12w` with full
knowledge of the intervening weeks:

> *"Given this event from {event_date} and the following 12 weeks of
> subsequent coverage, would a well-calibrated observer now say this event
> mattered durably? Score 0–5 on durable impact. Justify with specific
> mechanisms."*

Runs on the full backlog. Cross-checks the proxy signals — when they
disagree, flag for operator review.

### 3. Operator labels (small, gold)

The operator labels ~10 items per week from live output as genuinely
important / correctly rejected / missed / false alarm. Over months this
forms the anchor set against which both proxy signals and the LLM judge
are themselves calibrated.

### Composite ground truth

```
ground_truth_score = 0.4 * proxy_composite
                   + 0.4 * llm_judge_score
                   + 0.2 * operator_label_score   (if available)
```

Weights are defaults, stored in config and tunable. When operator labels
exist, their weight rises (they're the only human-anchored signal).

## Metrics tracked per run

| Metric | Definition | Target |
|---|---|---|
| **Precision@threshold** | Of items scored above threshold, fraction with ground_truth_score ≥ 3 | ≥ 90%, aim 95% |
| **Recall@threshold** | Of items with ground_truth_score ≥ 4, fraction we scored above threshold | ≥ 20% acceptable |
| **False-alarm surface** | List of above-threshold items with ground_truth_score < 2, grouped by category / theme | Analyze; usually reveals prompt weakness |
| **Miss surface** | List of sub-threshold items with ground_truth_score ≥ 4, grouped by category / theme | Analyze; may indicate rubric is too strict |
| **Confidence calibration** | Precision among `high` confidence scores vs. `low` confidence scores | `high` should exceed `low` by ≥ 15 pp |
| **Silence rate** | Fraction of cycles producing zero published items | 10–30% expected |

## Schema additions

```
Story additions
────────────────────
as_of_date              -- explicit date the scorer was told to reason from
scorer_model_id         -- pinned model ID at score time
scorer_prompt_version   -- git SHA or semver of the prompt
backtest_run_id         -- null for live scoring; set for Mode A backtests

GroundTruth
─────────────────
id
story_id
evaluated_at
proxy_composite         -- 0-5
llm_judge_score         -- 0-5
operator_label          -- 0-5 | null
ground_truth_score      -- composite, 0-5
evidence                -- jsonb: proxy signals breakdown + judge justification + operator notes

BacktestRun
─────────────────
id
mode                    -- 'A' (post-cutoff) or 'B' (rolling)
started_at
completed_at
prompt_version
model_id
story_count
metrics                 -- jsonb: precision, recall, surfaces, calibration
notes
```

## Data-leakage guardrails (both modes)

1. **`as_of_date` is always required** on the scoring prompt. The prompt
   forbids referencing post-`as_of_date` information. In production
   `as_of_date = today`. In Mode A, `as_of_date = story.published_at`.
2. **Scorer-model-id is logged** with every score. When a model upgrade
   happens, we can re-run Mode A to compare cross-version calibration on
   the same events.
3. **Ground-truth labels are stored with the evaluation date**. If a
   label's evaluation window would pre-date the scorer's cutoff, the label
   is excluded from that scorer's backtest (would leak).

## Integration with prompt iteration

The workflow for a prompt change:

1. Draft new prompt version.
2. **Mode A run** on the post-cutoff window (clean but narrow).
3. **Shadow run** against the last 4 weeks of live production (compare
   what the new prompt would have scored vs. what the old prompt did).
   Cannot yet compute precision (no 12-week ground truth) but can flag
   divergences for operator inspection.
4. Operator reviews divergences: does the new prompt make better
   calls on disagreements? Gut check is the final gate.
5. If accepted: deploy. Mode B's next rollover (in 12 weeks) will yield
   the first true precision measurement on live-scored data under the new
   prompt.

Shadow runs + Mode A give us pre-launch confidence. Mode B gives us
ongoing truth.

# Open questions

Undecided design choices. Each entry lists the question, the leading option,
and what resolving it unblocks.

## 1. Delivery medium

**Question:** Email, RSS, web page, push notification, SMS, something else?

**Leading option:** RSS as the primary channel, with optional email digest
that wraps the RSS entries. Both fit the silence rule natively (empty feed =
nothing to pull; no email sent if nothing to send). Push notifications are
ruled out: they're optimized for engagement, the opposite of the product.

**Unblocks:** composer output format, delivery plumbing, whether to host a
web archive of past issues.

## 2. Cadence target

**Question:** Daily, weekly, or purely event-driven (publish whenever the
gate fires)?

**Leading option:** Weekly by default (Sunday run), with event-driven
publication permitted if a story scores exceptionally high mid-cycle. Silence
is allowed on any cycle. Weekly is the tuning target for gate calibration
(aim: 1–5 items clear per average week).

**Unblocks:** scheduler config, gate threshold calibration, reader
expectations.

## 3. Theme granularity

**Question:** Broad themes (e.g. "AI") or narrow story-arcs (e.g. "GPT-5
launch arc")?

**Leading option:** Narrow, with LLM-driven merging when two narrow themes
converge. Broad themes accumulate noise and block everything; narrow themes
over-fragment without a merge mechanism. Merging is cheap: periodic job that
checks if two theme centroids have drifted close enough to combine.

**Unblocks:** theme-assignment prompt, repetition-suppression behavior.

## 4. Predictive importance layer

**Question:** Should we score on "might become important" in addition to
"already is important"?

**Leading option:** **Out of scope for v1.** Predictive scoring is high-value
but collides with the zero-false-alarms rule. If revisited, the clean design
is a watch list (parked items re-scored on new evidence, promoted to publish
only when retrospective importance crosses the threshold). Not a publishing
bypass.

**Unblocks:** nothing right now (deferred).

## 5. Surrogate / distilled scoring model

**Question:** Train a cheap classifier on LLM-generated labels, like News
Minimalist does?

**Leading option:** **Deferred.** At our volume (~100–300 centroids/day via
GDELT), LLM scoring is ~$5–10/mo. Distillation solves a cost problem we
don't have and adds maintenance burden (drift, retraining, rubric rigidity).
**However:** log every LLM score with its input from day one. If scale or
latency ever demands a surrogate, we train on accumulated data rather than
cold-starting.

**Unblocks:** nothing right now. Logging schema is specified in
architecture.md.

## 6. User configurability vs. fixed rubric

**Question:** Should the reader be able to tune the rubric (e.g. per-category
thresholds, topic blocks)?

**Leading option:** No user configuration in v1. The opinionated rubric *is*
the product. Per-user tuning recreates the filter-bubble problem. Since the
sole reader is the operator, the operator edits the rubric directly as code,
not through a UI.

**Unblocks:** UI scope (probably: none beyond a static web archive).

## 7. Product name

**Question:** What is this called?

**Leading option:** Unresolved. Working name: "the brief." Domain on file is
`blurpadurp.com`. Not committing until the product itself is closer to
shippable.

**Unblocks:** branding, domain routing, email-from address.

## 8. Categories taxonomy — final list

**Question:** Exact list of top-level categories.

**Leading option:** Ten buckets: geopolitics, policy, science, technology,
economy, culture, environment, health, business, society. Subject to
revision after looking at ~3 months of GDELT data to see what clusters
naturally.

**Unblocks:** category table seed data, per-category calibration targets.

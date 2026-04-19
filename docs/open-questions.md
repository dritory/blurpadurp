# Decisions & open questions

Questions from the initial design conversation. Decisions are locked in the
docs; remaining open items are flagged below.

## Decided

### Q1 — Delivery medium ✓
Web app (primary, public), opt-in email, opt-in web push (VAPID). No native
mobile app in v1 — PWA covers it. Silence respected across all channels.
Specified in architecture.md.

### Q2 — Cadence ✓
Weekly default, event-driven mid-cycle publication if a single item scores
`composite ≥ 2 × X`. All thresholds and the cadence interval are config-
driven, not hardcoded. Specified in architecture.md.

### Q3 — Theme granularity ✓
Narrow story-arcs with automatic merging when centroids converge.
Specified in architecture.md and scoring.md.

### Q4 — Predictive importance
Deferred from v1. If revisited, the design is a watch list (parked items
re-scored on new evidence; only publish on retrospective importance
crossing the threshold). Captured for future work.

### Q5 — Surrogate / distilled scoring model
Deferred. LLM scoring is cheap enough at our volume. Log every LLM score
with its input from day one so distillation is an option later.

### Q6 — User configurability ✓
No per-user rubric tuning, no thumbs up/down learning. One blunt knob
planned: per-category mute. Schema designed in v1 (`User`,
`UserCategoryMute`), UI deferred. Default: all categories on.

### Q7 — Product name ✓
**Blurpadurp.** Matches the domain, refuses to be precious about itself.

### Q8 — Categories ✓
Ten buckets, locked for v1, revisit after 3 months of data:

geopolitics, policy, science, technology, economy, culture,
internet culture, environment & climate, health, society

(`business` folded into `economy`; `internet culture` added as distinct
from traditional culture; `environment` renamed to `environment & climate`.)

## Still open

### O1 — Video source list & vote thresholds
We're including video content from YouTube Data API, curated YouTube
channels, and high-upvote-threshold Reddit posts. The specific channel
whitelist and vote thresholds need to be decided. Start with a small list
and expand as the pipeline is tuned.

**Unblocks:** video ingestion implementation.

### O2 — Email and push opt-in UX
Decided the channels exist; the actual sign-up flow, double-opt-in,
unsubscribe, and PWA install prompts are unspecified. Matters once the
web app starts being built.

**Unblocks:** frontend subscription flow.

### O3 — Hosting choice
Vercel / Fly / Railway / self-hosted VPS all work. Pick whichever is
cheapest and least friction for a solo operator. Not urgent until we ship.

**Unblocks:** nothing right now.

### O4 — Gate threshold calibration
`X` (absolute) and `Δ` (relative) need to be tuned against historical
GDELT data. Target: 1–5 items pass per average week across all categories,
with silence ~10–20% of cycles. Requires the scoring prompt to exist first.

**Unblocks:** going live.

### O5 — Scoring prompt v1
The rubric design is specified (scoring.md). The actual prompt text, with
gold anchor examples and structured output fields, is still to be drafted.
This is where the product really lives.

**Unblocks:** the scorer implementation; everything downstream.

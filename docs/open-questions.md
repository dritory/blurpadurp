# Decisions & open questions

## Decided

### Q1 — Delivery medium ✓
Web app (public, no login), opt-in email, opt-in web push. Each subscription
sets its own delivery time and timezone; hourly dispatcher respects those
windows. Event-driven issues can bypass the window only for subscribers with
`urgent_override` on. Silence respected across all channels.

### Q2 — Cadence ✓
Weekly default, event-driven mid-cycle publication if a single item scores
`composite ≥ 2 × X`. All thresholds and the cadence interval are config-
driven, not hardcoded.

### Q3 — Theme granularity ✓
Narrow story-arcs with automatic merging when centroids converge.

### Q4 — Predictive importance
Deferred from v1. Watch-list design captured for future work.

### Q5 — Surrogate / distilled scoring model
Deferred. LLM scoring is cheap enough at our volume. Log every LLM score
with input from day one to keep the option open.

### Q6 — User configurability ✓
No accounts, no passwords, no login. Subscriptions are the identity.
Preference management via signed-token links inside each email/push.
Per-subscription knobs: delivery time, timezone, urgent override, category
mutes. That's all. No thumbs, no keywords, no per-user rubric tuning.

### Q7 — Product name ✓
**Blurpadurp.**

### Q8 — Categories ✓
Ten buckets:

geopolitics, policy, science, technology, economy, culture,
internet culture, environment & climate, health, society

### Q9 — Videos and viral content ✓
First-class content, because covering zeitgeist is how the product keeps its
anti-social-media promise. Same rubric filters them; `internet culture` is
calibrated on "how out-of-the-loop would a reader feel" rather than
"changes the world's trajectory." Boosted by cross-platform spread,
mainstream-media crossover, longevity, derivative production. Delivery is
always autoplay-off with mandatory text caption so the reader can skip the
video and still get the reference.

## Still open

### O1 — Video & zeitgeist source whitelist
Initial whitelist of YouTube channels, subreddits, trend sources with
thresholds. Start small; expand as the pipeline is tuned.

### O2 — Signup + preferences UX
The flows exist conceptually (magic link for email, browser prompt for push,
signed-URL preference page). Actual page designs, copy, double-opt-in
compliance, unsubscribe flow, PWA install prompt — all TBD.

### O3 — Hosting choice
Vercel / Fly / Railway / self-hosted VPS all work. Not urgent.

### O4 — Gate threshold calibration
`X` and `Δ` tuned against historical GDELT data. Target: 1–5 items pass per
average week; silence ~10–20% of cycles. Requires scoring prompt first.

### O5 — Scoring prompt v1
Rubric design is specified. Actual prompt text with gold anchors, structured
output fields, and per-category calibration notes is still to be drafted.
**Highest-leverage open item — everything downstream depends on it.**

### O6 — Viral/zeitgeist scoring signals
How specifically to encode "cross-platform spread," "mainstream crossover,"
"longevity," and "derivative production" as features the scorer can use.
Some are measurable (Google Trends tail), some require a separate sub-model
(mainstream-media mention detector). Design during prompt drafting (O5).

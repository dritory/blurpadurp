# Concept — Blurpadurp

## What this is

An automated, anti-algorithm curated brief. Delivers only the highest-signal
items from the world's news across all topics. Success metric is the **opposite**
of engagement: fewer minutes of the reader's time per week = better product.

The operator is also the primary reader. The filter is the product.

## Non-negotiable rules

1. **Silence is a feature.** If nothing clears the bar in a cycle, publish
   nothing. No filler, no "slow news" recap.
2. **Whole story or no story.** No teaser headlines, no "click to read more."
   If something passes the gate, the substance is in the delivery.
3. **Minimum viable information.** Brevity over completeness. If the reader
   wants more, they go elsewhere — our job is done.
4. **Opinionated, not biased.** Strong stance on *what matters* (the importance
   rubric). Neutral on *how to interpret it* (no partisan framing).
5. **Categories on demand, not as layout.** An issue never carries an empty
   "nothing to report in X" section. A category only appears if something in
   it passed the gate this cycle.
6. **Interruptions are opt-in and rare.** Push notifications and emails are
   subscribed-to signals that a rare issue arrived, not engagement hooks.

## Scope

- **Topics:** all of them. Geopolitics, policy, science, technology, economy,
  culture, internet culture, environment & climate, health, society.
- **Geography:** global; English-language sources (v1).
- **Audience:** the operator is reader #1. The product is built for more users
  from v1 (web + opt-in email + opt-in push), but the rubric stays opinionated
  and globally applied. The only per-user knob v1 plans for is category mute
  (schema designed now, UI later).

## Explicit non-goals

- Not a feed. No infinite scroll, no recommendations, no "related stories."
- Not a breaking-news service. Latency of hours-to-days is fine.
- Not ad-supported. Cost model must stay solo-affordable.
- Not prediction-driven in v1. Predictive scoring is deferred.
- Not per-user personalized. The rubric is global. Category mute is the only
  planned per-user preference (see architecture.md).

## Editorial voice

Declarative, compressed, factual. Assumes a curious, literate adult reader.
Context only where the reader couldn't reconstruct it themselves. No jokes,
no cliffhangers, no "as we've reported." Reads like a briefing memo, not a
magazine column.

## How videos are handled

Videos are first-class content when they pass the rubric, but the delivery
pattern refuses the engagement-trap:

- Embedded player with **autoplay off, muted by default, no recommended next
  video, no loop**.
- Every video has a text caption describing what it shows, so a reader can
  skip the video and still get the information.
- In email, videos become thumbnail + link + text caption.
- In push notifications, videos are text-only with a "contains video" flag.

Most viral video is high-significance / low-importance and is rejected by
the rubric. What survives is typically a primary source (a speech, a
scientific demo, a rare event) where the video adds information beyond what
text carries.

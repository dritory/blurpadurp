# Architecture

## Pipeline

```
GDELT query (last 24h clustered events)
           +
Wikipedia Current Events Portal (daily scrape)
           +
Video sources (YouTube Data API, curated subreddits, outlet RSS)
           ↓
attach_to_theme  (embedding NN vs. theme centroids; LLM confirms continuation)
           ↓
score            (LLM rubric: importance, durability, non-obviousness, significance)
           ↓
normalize_by_category  (z-score within category baseline)
           ↓
gate             (absolute threshold AND relative-to-theme threshold)
           │
   ┌───────┴───────┐
   │               │
 passes         rejected
   │               │
   ↓               ↓
compose        log + discard
(Sonnet; fed
 prior_theme_summary
 to prevent repetition)
   ↓
persist issue
   ↓
deliver  ||  silence (if no items passed)
   ↓
   ├── web app (always, if issue persisted)
   ├── email    (to opted-in subscribers)
   └── web push (to opted-in subscribers)
```

Two gates must both pass to publish:
- **Absolute:** `importance × durability − non_obviousness ≥ X`
- **Relative:** score exceeds the theme's rolling importance average by Δ

Event-driven override: a single item scoring `composite ≥ 2 × X` may publish
mid-cycle outside the weekly schedule. Gate parameters (`X`, `Δ`, cadence,
override multiplier) live in a config table, not code constants.

## Sources

| Source | Role | Cost |
|---|---|---|
| **GDELT** (Event DB + GKG) | Primary firehose. Provides clustering, themes, tone, entities, source breadth. Queried via BigQuery or DOC 2.0 API. | Free |
| **Wikipedia Current Events Portal** | Crowdsourced human importance pre-filter. Used as a score booster for retrospective importance. | Free |
| **Direct RSS** (15–25 outlets) | Full article text for surviving items, fed to the composer. Reuters, AP, BBC, Nature, The Economist, etc. | Free |
| **YouTube Data API** | Trending videos + curated channel feeds (Nature, NASA, Veritasium, major outlets). Scored by the same rubric. | Free tier |
| **Curated subreddits** | High-vote-threshold posts from r/science, r/worldnews, r/videos (for video signal). Reddit JSON API. | Free |

Rejected: NewsAPI.org, Mediastack, NewsCatcher, Event Registry (paid tiers
don't add enough over GDELT to justify cost).

## Delivery channels

| Channel | Who gets it | When |
|---|---|---|
| **Web app** | Everyone (public) | Always, as soon as an issue is persisted |
| **Email** | Opted-in subscribers | On each new issue |
| **Web push (VAPID)** | Opted-in subscribers | On each new issue |

No native mobile app in v1 — PWA + web push covers iOS 16+ and Android. All
channels share one source of truth (the persisted issue). Silence is
respected everywhere: no issue → no email, no push, web shows the last
published issue.

## Data model

```
Category              Theme                           Story
─────────────         ─────────────────────           ──────────────────────
id                    id                              id
name                  category_id           ←──┐     title
description           name                     │     content / summary
                      description              │     source_url
                      first_seen_at            │     published_at
                      last_published_at        │     category_id
                      rolling_importance_avg   │     theme_id ─────────┘
                      rolling_importance_30d   │     embedding
                      n_stories_published      │     gdelt_event_id
                      centroid_embedding       │     wikipedia_corroborated (bool)
                                               │     importance, durability,
                                               │     non_obviousness, significance
                                               │     scored_at
                                               │     passed_gate (bool)
                                               │     published_to_reader (bool)
                                               │     published_at (to reader)
                                               │     score_justification (text)
                                               │     has_video (bool)
                                               │     video_url
                                               │     video_embed_url
                                               │     video_thumbnail_url
                                               │     video_duration_sec
                                               │     video_caption

Issue                              User                    UserCategoryMute
───────────────                    ─────────────           ─────────────────
id                                 id                      user_id
published_at                       email                   category_id
composed_html                      email_opt_in (bool)     muted_at
composed_markdown                  push_opt_in (bool)
story_ids (array)                  push_subscription_json
                                   created_at
```

- **Category:** fixed taxonomy, 10 buckets: geopolitics, policy, science,
  technology, economy, culture, internet culture, environment & climate,
  health, society.
- **Theme:** narrow story-arc (e.g. "2026 US tariff escalation"). Built by
  embedding-clustering stories within a category. Themes merge when centroids
  converge.
- **Story:** atomic event, post-clustering. GDELT handles initial dedup
  across outlets.
- **Issue:** a persisted published brief (composed content + story
  references). Exists only when the gate produces ≥1 item.
- **User / UserCategoryMute:** schema in place v1, UI deferred. Default
  behavior: every opted-in user receives the full issue. Per-category mute
  lands when the UI is built.

## Cost model

Sources are free; LLM inference and hosting are the real costs.

| Layer | Tool | Est. monthly cost |
|---|---|---|
| Sources | GDELT + Wikipedia + RSS + YouTube API | $0 |
| Storage | Postgres + pgvector on a small VPS | $5–10 |
| Scoring | Claude Haiku 4.5, ~100–300 cluster centroids/day | $4–10 |
| Composing | Claude Sonnet 4.6, 0–5 items per issue | $1–3 |
| Web hosting | Static/SSR (Vercel, Fly, Railway) | $0–10 |
| Email | Transactional provider (Resend, Mailgun) | $0 on free tier |
| Web push | VAPID (self-hosted) | $0 |
| **Total** | | **~$10–35/mo** |

Every LLM score is logged with its input. That dataset accretes for free; if
distillation to a surrogate model ever becomes worthwhile, we train on
logged scores rather than cold-starting.

## Infrastructure notes

- Single Postgres instance with `pgvector` extension for embeddings.
- Scheduled job (cron / systemd timer) runs the pipeline once per cycle.
- Cadence default: weekly. Configurable, not hardcoded.
- Pipeline runs every cycle; gate decides; composer runs only if ≥1 item
  passes. Silence is a valid cycle outcome.
- Model IDs are pinned (e.g. `claude-haiku-4-5-20251001`), never floating
  tags. Model upgrades go through shadow-mode validation (see scoring.md).
- Front end: server-rendered or static-generated, PWA-enabled for mobile
  install. No native app in v1.

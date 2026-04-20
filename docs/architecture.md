# Architecture

## Pipeline

```
Source layer (runs continuously/on schedule)
  ├── GDELT query (last 24h clustered events)
  ├── Wikipedia Current Events Portal (daily)
  ├── Video sources (YouTube Data API, curated channels, outlet RSS)
  └── Zeitgeist sources (Reddit r/OutOfTheLoop, KnowYourMeme,
                          Google Trends breakouts, mainstream-media
                          mentions of internet phenomena)
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
editor         log + discard
   │  (LLM curator: picks 10–15 from 30–80 passers —
   │   topic balance, under-covered-angle preference,
   │   duplicate collapse; see docs/editor-prompt.md)
   ↓
compose        (renders four functional sections — Conversation /
   ↓            Worth knowing / Worth watching / Worth a shrug;
persist issue   see docs/concept.md#section-scheme)
           ↓
Dispatch layer (runs hourly)
  For each opted-in subscription:
    if unsent issue exists AND
       (now is within subscriber's delivery window OR
        issue is event-driven AND subscriber has urgent_override):
      deliver via email or push
```

Two gates must both pass to publish:
- **Absolute:** `zeitgeist_score × half_life − non_obviousness ≥ X`
- **Relative:** composite exceeds the theme's rolling composite average by Δ
- **Confidence:** `point_in_time_confidence != "low"`

`structural_importance` is scored and stored but does NOT enter the gate.
It feeds retrospective curation later.

Event-driven override: a single item scoring `composite ≥ 2 × X` may publish
mid-cycle. Subscribers with `urgent_override = true` receive it immediately;
others receive it at their next scheduled delivery window. Gate parameters
(`X`, `Δ`, cadence, override multiplier) live in a config table, not code.

## Sources

| Source | Role | Cost |
|---|---|---|
| **GDELT** (Event DB + GKG) | Primary firehose for hard news. Provides clustering, themes, tone, entities, source breadth. BigQuery or DOC 2.0 API. | Free |
| **Wikipedia Current Events Portal** | Crowdsourced human importance pre-filter. Score booster for retrospective importance. | Free |
| **Direct RSS** (15–25 outlets) | Full article text for surviving items, fed to composer. Reuters, AP, BBC, Nature, The Economist, etc. | Free |
| **YouTube Data API** | Trending + curated channel feeds (Nature, NASA, Veritasium, major outlets). | Free tier |
| **Reddit JSON API** | r/science, r/worldnews, r/videos with high-upvote thresholds. r/OutOfTheLoop as a zeitgeist importance signal (people asking = mainstream catch-up demand). | Free |
| **KnowYourMeme** | "Confirmed" entries = meme has crossed from ephemeral to documented. Strong zeitgeist signal. | Free (scrape) |
| **Google Trends** | Breakout query detection; sustained tail = longevity signal. | Free |

Rejected: NewsAPI.org, Mediastack, NewsCatcher, Event Registry (paid tiers
don't add enough over GDELT to justify cost).

## Delivery channels

| Channel | Who gets it | When |
|---|---|---|
| **Web app** | Everyone (public, no login) | Always, as soon as an issue is persisted |
| **Email** | Opted-in subscribers | At subscriber's `delivery_time_local`; event-driven issues honor `urgent_override` |
| **Web push (VAPID)** | Opted-in subscribers | Same delivery logic as email |

No native mobile app in v1 — PWA + web push covers iOS 16+ and Android. All
channels share one source of truth (the persisted issue). Silence is
respected everywhere: no issue → no email, no push.

## Subscription model — no accounts

Subscriptions *are* the identity. No user table, no passwords, no login.

- **Email signup:** enter email → confirmation magic link → confirmed.
- **Push signup:** browser-native prompt → subscription stored.
- **Preferences management:** every email/push includes a "manage" link
  containing a signed token bound to that subscription. The link opens a
  public page where the subscriber sets delivery time, category mutes,
  urgent override, or unsubscribes. No login.
- **Multi-device:** each browser/email is an independent subscription.
  Accepted tradeoff — cross-device sync costs a login.

## Persistence principle

**Every item the scorer touches is stored indefinitely.** Passed, rejected,
early-rejected — all rows stay. The classified corpus is valuable as
training data for future surrogate models, as the input to backtesting
(Mode B), and as the substrate for all analysis queries. There is no
retention policy in v1; at ~100–300 centroids/day the corpus grows roughly
100k rows/year, which Postgres on a small VPS handles indefinitely.

The raw input fed to the scorer is stored alongside the score
(`story.raw_input`). This lets us re-score old items under a new prompt
version without re-fetching sources.

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
                      rolling_composite_avg    │     theme_id ─────────┘
                      rolling_composite_30d    │     embedding
                      n_stories_published      │     gdelt_event_id
                      centroid_embedding       │     wikipedia_corroborated
                                               │     as_of_date
                                               │     scorer_model_id
                                               │     scorer_prompt_version
                                               │     raw_input (jsonb)
                                               │     raw_output (jsonb)
                                               │
                                               │     -- denormalized from raw_output
                                               │     zeitgeist_score, half_life,
                                               │     reach, non_obviousness,
                                               │     structural_importance
                                               │     composite
                                               │     point_in_time_confidence
                                               │     theme_relationship
                                               │     base_rate_per_year
                                               │
                                               │     scored_at
                                               │     early_reject (bool)
                                               │     passed_gate (bool)
                                               │     published_to_reader (bool)
                                               │     published_at (to reader)
                                               │     backtest_run_id (null for live)
                                               │
                                               │     has_video (bool)
                                               │     video_url
                                               │     video_embed_url
                                               │     video_thumbnail_url
                                               │     video_duration_sec
                                               │     video_caption

StoryFactor (many-to-many tag table)
───────────────────────────────
story_id           -- FK → Story.id
kind               -- 'trigger' | 'penalty' | 'uncertainty'
factor             -- controlled vocabulary value
PRIMARY KEY (story_id, kind, factor)

Issue                     EmailSubscription              PushSubscription
─────────────────         ──────────────────────         ─────────────────────
id                        id                             id
published_at              email                          endpoint
is_event_driven (bool)    confirmed_at                   p256dh_key
composed_html             unsubscribed_at                auth_key
composed_markdown         delivery_time_local            user_agent_label
story_ids (array)         timezone                       delivery_time_local
                          urgent_override (bool)         timezone
                          category_mutes (jsonb[])       urgent_override (bool)
                          created_at                     category_mutes (jsonb[])
                                                         created_at
                                                         unsubscribed_at

DispatchLog
──────────────
id
issue_id
subscription_kind   -- 'email' | 'push'
subscription_id
dispatched_at
status
```

- **Category:** fixed taxonomy, 9 slugs — `politics`, `science`,
  `technology`, `economy`, `culture`, `internet_culture`,
  `environment_climate`, `health`, `society`.
- **Theme:** narrow story-arc. Built by embedding-clustering within a
  category. Merges when centroids converge.
- **Story:** atomic event, post-clustering. **Every scored item is
  persisted — passers, rejects, early-rejects.** `raw_input` and
  `raw_output` jsonb columns preserve exact scorer input/output for
  re-scoring under future prompt versions. Denormalized columns
  (`importance`, `theme_relationship`, `base_rate_per_year`, etc.) support
  SQL without jsonb digging for common queries.
- **StoryFactor:** many-to-many tag table; one row per (story, kind,
  factor) triple from the controlled vocabularies (`trigger`, `penalty`,
  `uncertainty`). Enables GROUP BY on factors without jsonb array
  unpacking.
- **Issue:** persisted published brief; exists only when gate produces ≥1
  item. `is_event_driven` distinguishes mid-cycle from scheduled.
- **EmailSubscription / PushSubscription:** the entire identity. No User
  table.
- **DispatchLog:** per-subscription delivery record; prevents double-sending
  when the hourly dispatcher runs.

## Cost model

| Layer | Tool | Est. monthly cost |
|---|---|---|
| Sources | GDELT + Wikipedia + RSS + YouTube + Reddit | $0 |
| Storage | Postgres + pgvector on a small VPS | $5–10 |
| Scoring | Claude Haiku 4.5, ~100–300 centroids/day | $4–10 |
| Composing | Claude Sonnet 4.6, 0–5 items/issue | $1–3 |
| Web hosting | Static/SSR (Vercel, Fly, Railway) | $0–10 |
| Email | Transactional provider (Resend, Mailgun) | $0 on free tier |
| Web push | VAPID (self-hosted) | $0 |
| **Total** | | **~$10–35/mo** |

Every LLM score is logged with its input. That dataset accretes for free;
distillation to a surrogate model is an option later.

## Infrastructure notes

- Single Postgres instance with `pgvector` for embeddings.
- Pipeline runs on a schedule (default: weekly composition; hourly dispatch).
- Cadence, thresholds, and override multiplier are config-driven.
- Model IDs are pinned; upgrades go through shadow-mode validation.
- Front end: SSR or static, PWA-enabled. No native app v1.

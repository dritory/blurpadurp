# Architecture

## Pipeline

```
GDELT query (last 24h clustered events)
           +
Wikipedia Current Events Portal (daily scrape)
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
deliver  ||  silence (if no items passed)
```

Two gates must both pass to publish:
- **Absolute:** `importance × durability − non_obviousness ≥ X`
- **Relative:** score exceeds the theme's rolling importance average by Δ

## Sources

| Source | Role | Cost |
|---|---|---|
| **GDELT** (Event DB + GKG) | Primary firehose. Provides clustering, themes, tone, entities, source breadth. Queried via BigQuery or DOC 2.0 API. | Free |
| **Wikipedia Current Events Portal** | Crowdsourced human importance pre-filter. Used as a score booster for retrospective importance. | Free |
| **Direct RSS** (15–25 outlets) | Full article text for surviving items, fed to the composer. Reuters, AP, BBC, Nature, The Economist, etc. | Free |

Rejected: NewsAPI.org, Mediastack, NewsCatcher, Event Registry (paid tiers
don't add enough over GDELT to justify cost).

## Data model

```
Category              Theme                           Story
─────────────         ─────────────────────           ──────────────────────
id                    id                              id
name                  category_id           ←──┐     title
                      name                     │     content / summary
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
```

- **Category** = fixed taxonomy, ~10 buckets (geopolitics, policy, science,
  tech, economy, culture, environment, health, business, society).
- **Theme** = narrow story-arc (e.g. "2026 US tariff escalation", not "trade").
  Built by embedding-clustering stories within a category. Themes merge when
  centroids converge.
- **Story** = atomic event, post-clustering. GDELT handles initial dedup
  across outlets.

## Cost model

Sources + storage are effectively free. The only cost is LLM inference.

| Layer | Tool | Est. monthly cost |
|---|---|---|
| Sources | GDELT + Wikipedia + RSS | $0 |
| Storage | Postgres + pgvector on a small VPS | $5–10 |
| Scoring | Claude Haiku 4.5, ~100–300 cluster centroids/day | $4–10 |
| Composing | Claude Sonnet 4.6, 0–5 items per issue | $1–3 |
| Delivery | Self-hosted RSS + transactional email free tier | $0 |
| **Total** | | **~$10–25/mo** |

Every LLM score is logged with its input. That dataset accretes for free; if
distillation to a surrogate model ever becomes worthwhile, we train on logged
scores rather than cold-starting.

## Infrastructure notes

- Single Postgres instance with `pgvector` extension for embeddings.
- Scheduled job (cron / systemd timer) runs the pipeline once per cycle.
- Cadence default: weekly. The pipeline runs, gate decides, composer runs only
  if at least one item passes. Silence is a valid cycle outcome.
- Model IDs are pinned (e.g. `claude-haiku-4-5-20251001`), never floating tags.
  Model upgrades go through shadow-mode validation (see scoring.md).

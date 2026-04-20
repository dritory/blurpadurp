# Concept — Blurpadurp

## What this is

An automated, anti-algorithm curated brief. Delivers only the highest-signal
items from across news, science, culture, and internet zeitgeist. Success
metric is the **opposite** of engagement: fewer minutes of the reader's time
per week = better product.

## Mission

**Let readers quit social media for keeping-up.**

Most people use social feeds to answer one question: *"What's everyone
talking about?"* Blurpadurp replaces that function. A reader who follows
Blurpadurp should be able to hold their own in any interesting
conversation — at lunch, at a dinner party, at the coffee machine, at
Easter dinner — without opening TikTok, X, or Reddit.

The gate is **current conversational relevance**, not long-term historical
weight. We publish what informed adults will actually be discussing over
the next 1–2 weeks. Long-term "structural" importance is scored separately
and stored for retrospective curation, but it does not drive the weekly
publish decision.

The filter is the product. The filter is opinionated and global.

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
6. **Interruptions are opt-in, configurable, and rare.** Push and email are
   subscribed-to signals that a rare issue arrived, delivered at the
   subscriber's preferred time. Never autoplaying, never badge-counting,
   never "you missed X items."
7. **Zero friction to subscribe.** No accounts, no passwords. The
   subscription itself is the identity. Managing preferences uses signed
   links from the subscriber's own email/push — no login anywhere.

## Scope

- **Topics:** geopolitics, policy, science, technology, economy, culture,
  internet culture, environment & climate, health, society.
- **Geography:** global; English-language sources (v1).
- **Audience:** anyone who wants off the social-media treadmill without
  falling out of the loop. The operator is reader #1. The rubric stays
  global and opinionated regardless of subscriber count.

## Explicit non-goals

- Not a feed. No infinite scroll, no recommendations, no "related stories."
- Not a breaking-news service. Latency of hours-to-days is fine.
- Not ad-supported. Cost model must stay solo-affordable.
- Not prediction-driven in v1. Predictive scoring is deferred.
- Not per-user personalized. The rubric is global. Only one per-user knob:
  category mute (blunt, not smart).

## Editorial voice

Wry, dry, observant. A sharp-eyed friend recapping the week — not a wire
service, not a press release, not an anchor reading a teleprompter. The
register is consistent across hard news and cultural items: understatement
and one sharp observation per story. Wit lives in word choice and
observation, never in jokes at the subject's expense. Assumes a curious,
literate adult reader. Context only where the reader couldn't reconstruct
it themselves. No cliffhangers, no "as we've reported," no
click-to-read-more. Closer to *The Economist*'s Espresso or Matt Levine's
Money Stuff than to a digest.

## Editorial principles

- **Consequential only.** No cherry-picked quotes, no motive attribution,
  no "this could turn into something." Enforced mechanically by the
  scorer's confidence gate and the 12-month retrodiction field.
- **Context, not interpretation.** Opinionated on *what belongs in the
  brief*, neutral on *what to think of it*. We give readers enough context
  to connect dots themselves; we do not tell them the conclusion.
- **Ride for the generalists.** Ten categories, no specialization. A reader
  should leave each issue with a wider surface area, not a deeper trench.
- **Silence is a feature.** Already stated above as a rule; restated here
  so it reads alongside the others.

## What we refuse

- Sports results (unless civic-scale — Olympics, World Cup finals).
- Routine product launches, earnings beats, and horse-race polling.
- Individual crime without a systemic angle.
- Weather without unprecedented scale.
- Award ceremonies (unless the outcome is the story).
- Viral content trapped on a single platform.
- Celebrity personal lives (unless universally-known subject at a life
  milestone, or a public-interest legal matter).
- In-circle hype, manufactured hype, and controversy-flashes — named and
  dismissed in the *Worth a shrug* section rather than covered.

## Section scheme

Every issue is organized into the same four functional sections. Any
section may be empty; missing sections are simply omitted.

| Section | What it holds |
|---|---|
| **This week's conversation** | The items a reader will be asked about. Highest-signal gate-passers, full paragraphs. |
| **Worth knowing** | Gate-passers that matter even if nobody's talking about them yet. Tight one-paragraph items. |
| **Worth watching** | Items on emerging or uncertain threads — passed the gate but still developing. One sentence each. |
| **Worth a shrug** | The anti-FOMO section. Hype the algorithm pushed this week that didn't clear our gate — named, one wry line, dismissed. |

## How videos and viral content are handled

Videos and viral content are first-class. Covering what people are
discussing is *the mission*, not an edge case. The rubric filters them —
hype confined to a single platform or vertical press does not pass — but
hype that has broken through to general conversation does, for the cycle
or two that conversation lasts.

Signals that boost viral / cultural content zeitgeist scores:
- Cross-platform spread (3+ platforms)
- Mainstream-media crossover (NYT / Guardian / BBC writes about it)
- Sustained attention (Google Trends 14-day tail)
- Derivative production (parodies, remixes, merch — entering vocabulary)

Signals that keep it out:
- `in_circle_hype` — tech / crypto / niche press coverage only
- `manufactured_hype` — PR-driven, no organic discussion
- `controversy_flash` — 48–72 hour outrage cycles with predictable decay

Delivery pattern refuses the engagement trap:

- Embedded player with **autoplay off, muted by default, no recommended
  next video, no loop**.
- Every video has a text caption describing what it shows, so a reader can
  skip the video and still get the reference.
- In email, videos become thumbnail + link + text caption.
- In push notifications, videos are text-only with a "contains video" flag.

The reader "gets" the meme without needing to watch. They aren't lost when
someone references it — which is the whole point.

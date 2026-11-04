# Recognition lane — beating FOMO on the stuff that isn't news

Status: design, not built. This is the answer to "we replaced the feed
for news; how do we replace it for everything else?" It starts from
what FOMO is actually made of, because the pipeline's shape should
follow from that and not the other way round.

## What people get FOMO from

Start from the social situation, since that is where FOMO is felt:
someone says something and you can't follow. The gap comes in a
handful of shapes, and the shape determines what information would
close it. "Did you hear what happened" is the news gap and it needs
context and meaning, which is paragraphs. Every other shape needs
less, usually a sentence.

| Shape of the gap | Class | Examples | What closes it | Lifetime |
|---|---|---|---|---|
| "Did you hear" | Events | an election, a strike, a collapse | what happened and what it means | days to months |
| "Have you seen" | Releases | a Netflix show, an album, a game, a book | that it exists, what it is, that it's big | weeks |
| "What does that mean" | Vocabulary | a meme, a sound, a phrase, a format | meaning, origin, whether it's already over | days to a season |
| "Who is that" | People | a creator, a new pop star, a streamer | who, and why now | weeks, sometimes permanent |
| "Did you see the clip" | Moments | a viral video, a halftime show, a goal, a livestream meltdown | what happened in it, one line | days |
| "Everyone's doing X" | Behaviours and objects | Stanley cups, Labubu, pickleball, a new app | what it is, and that it's a wave | months |
| "What do you think about" | Discourse | the take of the week, the main character | nothing we should supply | 48 hours |

Four things fall out of the table.

The cost structure is inverted. News is the one class that needs
paragraphs, and the feed charges the least for it because newspapers
exist. Vocabulary, people and moments need a sentence each, and the
feed charges the most for them, because the only way to learn a meme
is to be on the platform it lives on for long enough to see it three
times. So the energy a reader spends on the feed goes mostly on the
cheapest information.

Every reference has a lifecycle. It emerges inside a platform or an
age group, breaks out into general conversation, saturates (brands use
it, it becomes cringe), then either fossilises into vocabulary or dies.
FOMO lives in the breakout phase and nowhere else: before it you're
allowed not to know, after it knowing is a liability. So where a thing
sits in its lifecycle is part of the information, and it is data (weeks
on a chart, rising or falling), not a judgement. A weekly cadence
samples at breakout or later, which is the right moment.

Who you get FOMO from determines which classes matter. The lunch table
is events, releases, behaviours and discourse. Kids are vocabulary,
people and moments. The group chat is moments and vocabulary. The
"informed adult" framing in `concept.md` covers the first two classes
well and leaves the rest to the feed, and the rest is exactly where one
sentence closes the gap completely.

Two kinds of FOMO we refuse. Discourse FOMO, the not-having-a-take
kind, is the feed's core product, and serving it is being the feed;
Worth a shrug already names these and dismisses them, which is the
right treatment. Participatory FOMO, the not-having-watched-it kind,
isn't fixable by information at all. "It exists, it's a show about X,
everyone's watching" is the whole deliverable, and socially that is
nearly always enough.

One empirical handle was supposed to exist already. The r/OutOfTheLoop
connector is a weekly sample of exactly these gaps, phrased by the
people who felt them, and what the news rubric does with it would be a
direct measure of the demand the news lane turns away. In production
it holds nine rows, all from May, and Reddit has answered 403 to every
pull since (see the evidence section at the end). What the nine do
show is that the gate, not the early-reject list, is what turns the
FOMO-shaped ones away: none was early-rejected, and the five that
failed all failed on half-life.

## Why the news pipeline can't carry this

The mission in `concept.md` already covers it ("get the meme without
needing to watch"). What doesn't exist is a path through the pipeline
that a reference from classes two to six can survive. Four things stop
it, and they are all correct for news, which is why we shouldn't
loosen them.

The gate formula multiplies by `half_life`, and a reference has a
half-life of hours or days by the rubric's own definitions, so even a
water-cooler item (zeitgeist 5) scores at most 5 − non_obviousness
against a threshold of 5. The multiplier is a durability proxy, and
durability is the property the table says these classes don't have.
The early-reject list names product launches, sports moments, award
outcomes, celebrity moments and single-platform virality, which is
most of releases, people and moments; in practice the scorer scores
those anyway and the half-life multiplier does the refusing, and the
reasons it does write down are mostly opinion columns, local crime and
routine increments (the evidence section has the counts). The
editor's four-quadrant rubric caps "loud but insignificant" at one or
two picks per issue by design. And the sources measure events being
reported: twenty-nine newsroom feeds and Wikipedia, since GDELT has
never produced a row in production and r/OutOfTheLoop stopped in May,
so nothing live measures something being talked about, and the
`viral_signals` fields the scorer could read were never populated
(open question O6).

So the choice is between widening the news gate and adding a second
lane with its own gate. Widening is wrong for a reason the brief
already learned once: the product is the filter, and a gate that
admits a pop song also admits a stock move. The lane shares the
plumbing (connectors, embeddings, themes, mutex, dispatch, memory) and
nothing of the judgement.

## What the reader actually needs

For news the unit is the event and the question is "what does it
mean". For trends the unit is the reference and the question is "would
I be lost if someone said this". Nobody at a dinner party needs you to
have watched the show; they need you to know it is a show, roughly what
it is about, and that everyone is watching it. That is the whole
deliverable, and it maps onto the existing minimum-viable-information
rule unusually well: one line of what it is, half a line of why it is
everywhere, a source, stop.

This gives the section its name and its shape. The existing family is
Worth knowing (quiet, significant), Worth watching (developing) and
Worth a shrug (loud, dismissed). The new one is **Worth recognising**:
loud, not significant, not dismissed either. The difference from shrug
is deliberate. Shrug names hype that stayed in a vertical and tells
the reader they can skip it; recognising names something that broke
out of its vertical and tells the reader only what it is. No verdict,
no observation, no joke. The composer v0.12 flat-report move (state
what happened, stop) is the only move allowed, because any trailing
clause would be a judgement of significance, which is the thing we are
not making.

Register check for the composer: `**KPop Demon Hunters** — Netflix
animated film about a girl group that fights demons between shows; its
soundtrack has topped Spotify for a month. [netflix.com]`. That is the
whole item. Three lines is the hard ceiling, five to eight items the
section cap, and the section is omitted when nothing qualifies, like
every other section.

## The rubric

Three numbers, none of them about importance.

| Axis | Question | Who answers |
|---|---|---|
| `encounter` (0–5) | How likely is an informed adult to meet this reference in the next two weeks? | scorer, from evidence |
| `lostness` (0–5) | Would one factual sentence close the gap, and how badly is it needed? 0 is self-explanatory or no sentence would do, 5 is "no idea what that is" | scorer, from evidence |
| `breadth` | Independent sources that observed it in the compose window: charts, r/all, Wikipedia lookups, a culture desk, a newsroom | data, never the LLM |

`lostness` is the "what does that mean" shape measured directly, and
its definition does the discourse exclusion for free: for a take of
the week no factual sentence closes the gap, since what the reader
lacks is an opinion, so `lostness` is 0 by construction. `encounter`
is the breakout phase. The gate is `encounter × lostness ≥ T` with
`breadth ≥ 2` as the confidence floor: one source is a platform
talking to itself, two independent ones is a thing that moved.

An earlier draft used weeks-on-chart as the floor instead. That was
wrong for the "did you see the clip" class, which lives days: a video
everyone saw on Tuesday has a persistence of one week at the Saturday
compose and would never pass, and it is the single clearest case the
lane exists for. Duration is the wrong proxy for breakout; breadth is
the right one. Weeks-on-chart survives as a lifecycle label on the row
(`new`, `still going`, `fading`, from dwell and direction), the same
way the shrug tag does: it is the one piece of information the table
says belongs with the reference, it comes from data, and giving it to
the composer as a label keeps it out of the prose. Two things are
missing on purpose. There is no
`structural_importance` and no retrodiction field, because the
request is to keep up without having to recognise anything as
significant, and a rubric that asks the question would answer it. And
there is no `non_obviousness` penalty, because it inverts here: the
reader has left the feed, so everything on the feed is non-obvious to
them by construction. The only obviousness left is mainstream news,
and the news lane already handles that.

The scorer keeps the hard rules that matter (point-in-time, reasoning
from evidence, no invented justifications) and drops the early-reject
list entirely, because that list is where releases, people and moments
were being turned away. Discourse stays out through `lostness` rather
than a category rule, and `manufactured_hype` stays as a penalty tag
the scorer can set from evidence (paid placement, no organic
discussion), because a marketing budget can buy breadth for a week and
we are still judging whether people actually met the thing. Sports moments, award outcomes, album drops, celebrity
moments and product launches are all admissible if they broke out. The
breakout test is the same one the news scorer already applies to
internet culture: one platform means `encounter` ≤ 2, three or more
platforms or a mainstream mention lets it reach 4. A second prompt
file, `docs/recognition-prompt.md`, with its own `recognition.
prompt_version`, same version-bump discipline as the other three.

Calibration anchors, point-in-time: Clubhouse at peak (encounter 3,
lostness 4, publishes), a Netflix number one in its third week
(encounter 4, lostness 3, publishes), a song at number one for the
ninth week (already given to the reader, so memory suppresses it), a
forty-eight-hour pile-on (lostness 0, fails), an in-circle crypto
launch (encounter 1, breadth 1, fails), and the Tesla Roadster hover
video (encounter 4, lostness 3, breadth 3 across The Verge, Ars
Technica and Al Jazeera, which is what production actually saw,
publishes as one sentence).

## Sources: charts, not stories

This is the half that is actually new. The news connectors emit
stories, which are things that happened once. A chart emits positions,
which recur weekly, and the signal in a chart is never the absolute
rank but the movement against the entity's own baseline. Taylor Swift
at rank 30 on Wikipedia is Tuesday; an unknown name at rank 30 is a
trend. The architecture doc already describes this as "z-score within
baseline" and never built it; this is where it earns its place.

So the lane needs a `trend_observation` table (entity, source, geo,
rank, metric, week) and a weekly roll-up that turns observations into
one synthetic story per entity, keyed `trend:<entity-slug>:<week>`, with
a summary that lists the evidence across sources. That roll-up is the
O6 collector the scoring doc has been waiting for, generalised: instead
of five hand-picked `viral_signals` fields it produces "on N charts,
best rank R, weeks on chart W, Wikipedia views at K× trailing median,
asked about on r/OutOfTheLoop, mentioned by M mainstream outlets". The
synthetic story then enters the ordinary pipeline with `lane =
'recognition'` on the row, goes through embedding and theme attach like
everything else, and is scored by the recognition prompt.

Candidate sources, by what they measure. None of these were reachable
from the session that wrote this (the network policy blocks every host
outside the repo), so each carries a confidence rather than a check.

| Source | Measures | Access | Confidence |
|---|---|---|---|
| Wikimedia pageviews top-1000 per day, plus per-article daily series for the baseline | what people heard about and looked up — the most direct measure of `lostness` there is | REST API, no auth, generous limits | high |
| Netflix Top 10 weekly TSV (global + per country) | what everyone is watching | public download | high |
| YouTube Data API `mostPopular` chart | what everyone is watching, shorter form | API key, free quota | high |
| Google Trends trending RSS, per geo | breakout searches with traffic estimates | public RSS | medium (Google reshuffles this surface) |
| Reddit r/all weekly top | cross-community discussion | public JSON, same pattern as OOTL | high |
| Apple marketing RSS, top free/paid apps and songs | consumer adoption | public JSON | high |
| Steam most-played web API | games | public API | medium |
| Spotify charts | music | charts download now needs a login and the Web API no longer serves editorial playlists to new apps | low; use Apple songs chart and Wikipedia as proxies |
| Billboard, box office, Know Your Meme | music, film, memes | scrape only | low; skip in v1 |
| Culture desks as RSS (Guardian Culture, NYT Arts, Vulture, Pitchfork, Polygon) | mainstream crossover, which is the breakout signal | RSS, existing connector | high |

The culture feeds matter more than they look. They are what lets the
scorer distinguish "number one on a chart" from "everyone is talking
about it", the same way NYT writing about a meme is the crossover
signal in the news rubric. They go through the existing RSS connector
as plain stories; the roll-up matches them to entities by theme.

Wikipedia carries a second job. The LLM scoring a trend usually does
not know the trend (model cutoff, and memes are born after it), and a
scorer that doesn't know what it is scoring will invent a description.
So every synthetic story must carry a grounded description, and the
lead paragraph of the Wikipedia article is the neutral one that exists
for nearly everything that trends. Where there is no article (a meme
too new, a TikTok sound) the OOTL answer thread's top comment is the
fallback, and with neither the entity is held a week rather than
scored, because the composer's source-fidelity guard has nothing to
hold it to.

## Pipeline shape

Nothing new in the scheduler. The roll-up runs as the last pass of
`ingest` (it needs the week's observations in place), scoring runs in
the `score` stage with the prompt chosen by lane, and everything after
that is a small addition to compose.

The lane does not go through the editor. The editor's job is balancing
two axes across an issue, and this lane has one axis. Selection is a
pure function next to `compose-shrug.ts`: rank by `encounter ×
lostness`, one item per narrative cluster (the same `theme-cluster.ts`
grouping, so a film, its soundtrack and its lead actor are one entry),
cap at `recognition.max_items` (6), and suppress anything whose entity
appears in the last `compose.recent_coverage_issues` issues through
`issue_pick`, which already records every pick. Suppression is the
important half: a reference is given once. A song at number one for
nine weeks is not nine entries, and the memory the brief gained in
mig 075 is exactly the mechanism.

One more dedupe. If an entity's cluster already holds a news-lane pass
this week (GameStop in 2021, a celebrity death), the recognition lane
drops it; the news section is going to explain it properly and the
reader doesn't need it twice. The reverse never happens, since the
news gate can't see recognition rows.

Compose adds `recognising[]` as a fifth server-side partition and the
composer prompt gets a section block with the flat-report rule, three
lines, cite exactly one domain, no label. Invariant 2 holds: the
composer writes prose per section and never decides placement.
Rendering reuses the shrug layout minus the tag. Email and web both
show it; `category_mutes` already exists per subscription, so
`recognition` becomes a mutable category and the one per-user knob
covers the reader who only wants the news.

Config keys: `recognition.enabled` (false until the sources are
tuned), `recognition.prompt_version`, `recognition.gate_threshold`,
`recognition.min_breadth` (2), `recognition.max_items` (6),
`recognition.geos` (`["global"]`, see below), `recognition.model_id`
(the DeepSeek scorer is fine; volume is a few dozen calls a week since
chart sizes bound it).

## What stays hard

TikTok is where most of this starts and it has no API. The honest
answer is that we don't need the origin, we need the breakout, and a
breakout shows up in Wikipedia lookups, r/OutOfTheLoop, Google Trends
and the culture desks within days. The brief's latency promise was
always hours to days, and the weekly cadence turns out to be a filter
rather than a problem: a thing that is gone by Saturday is a thing
nobody will reference next week, so being observed inside the compose
window is doing real work. We will be late on everything and right about
what is still alive, which is the trade the product makes everywhere
else.

Geography bites here in a way it doesn't for news. The rubric is
global and the sources are mostly US, but recognition is local: a
Norwegian lunch table references NRK series and Norwegian artists.
Netflix, Apple and Google Trends are all per country, so the
observation table carries `geo` and the brief takes a geo list. In v1
that list is `["global"]` and the `/no` reader gets the same section
in English, consistent with the brief body not being translated. A
per-locale section is a later decision and the data model should not
make it a migration.

Entity resolution across sources is the part most likely to be fiddly
in practice. The embedding-based theme attach will usually put "Golden"
(song), "KPop Demon Hunters" (film) and the lead actor into one
cluster, and when it doesn't the cost is two entries for one thing,
which the per-cluster cap can't catch. Expect to tune the attach
threshold for this lane separately and to add a small alias table when
the same miss recurs.

## Build order

None of the news rules bend. The Roadster video never enters the news
gate under this design; it enters a second judgement on rows the news
rules have already refused, and that is also what makes a cheap first
phase possible.

Phase zero needs no new source. The news scorer already saw the
Roadster, five times in two days from The Verge, Ars Technica and Al
Jazeera, and it did not early-reject the stunt: it scored it in full
and the gate refused it at composite 2 against a threshold of 5, with
`half_life` at 1 doing the work. The change is that a gate-fail or
early-reject still emits two numbers, `recognition.encounter` and
`recognition.lostness`, in the same call (early-rejected rows already
carry a full set of scores in production, so this costs nothing).
`breadth` has to be computed per theme, not read off the row.
`additional_source_urls` and `source_count` are GDELT-only fields and
are empty on every row the pipeline holds, and `wikipedia_corroborated`
is a per-theme flag compose derives at run time. What a row does carry
is the `crossover_discussion` trigger, and what its theme carries is
the count of distinct source domains inside the compose window, which
for the Roadster was three. So breadth is distinct domains in the
cluster plus the crossover trigger, and the same selector that groups
by cluster for the cap computes it. A pure selector next to
`compose-shrug.ts` then builds Worth recognising from failed-gate rows
the way shrug is built today, with one coexistence rule applied per
cluster, not per row: a cluster with breakout evidence goes to
recognising, one without goes to shrug, and never both. Per row is not
enough, because production already shipped the Roadster as a shrug,
and the row it shipped was a rival's mock video with no evidence on it
while the stunt rows carrying the evidence sat one day outside the
window. The difference between the two sections is exactly that
evidence, which is a nice property, since it means the section split
is a measurement and not a mood.

This catches the Roadster, a halftime show, an album drop and a
Netflix hit, because those reach the newsroom and tech feeds. It does
not catch vocabulary or most people, because a meme does not get an
article until it is already over. That is what the chart sources are
for, and phase zero tells us how much of the demand they are needed
for before any connector is written. Phase one is the
Wikimedia top-pageviews connector with the per-article baseline, the
Netflix TSV, the `trend_observation` table and roll-up, the
recognition prompt, the pure selector and the compose section, shipped
behind `recognition.enabled = false` and read on `/admin/explore` so a
few weeks of what it would have picked can be judged before a reader
sees it. The eval harness in `eval.ts` and the fixture capture in
`fixture.ts` both work per story row, so they cover the lane with no
change. Phase two adds YouTube, Reddit r/all and the culture RSS feeds,
which is when the breakout signal becomes real. Phase three is per-geo
charts, and whether that becomes a per-locale section is the first
decision worth making on evidence rather than now.

## Evidence from production

Read on 4 November 2026 from the production database, read-only, to
check the two claims this doc leans on: that r/OutOfTheLoop measures
the demand the news lane turns away, and that the Roadster row carries
enough breadth for phase zero. Both came back different from what the
doc assumed, and the body above has been corrected rather than
caveated.

Start with what the pipeline actually holds, because two of the four
connectors in the registry turn out to be dead.

| Source | Rows | First | Last | Early-rejected | Passed gate |
|---|---|---|---|---|---|
| rss | 69,431 | 2026-04-24 | 2026-11-04 | 14,664 | 9,791 |
| wikipedia | 1,681 | 2026-04-26 | 2026-11-04 | 601 | 208 |
| reddit_ootl | 9 | 2026-05-07 | 2026-05-16 | 0 | 4 |
| gdelt | 0 | | | | |

GDELT has never written a row: its cursor records "Cannot parse as
CloudRegion" on every tick, which is the BigQuery location left unset,
and it was still failing at the hour of reading. r/OutOfTheLoop ran
for about three weeks in May and has had "403 Blocked" from Reddit on
every pull since. Two things in this doc rested on those connectors
without saying so. `additional_source_urls` and the scorer's
`gdelt_metadata.source_count` are only ever written by GDELT, so the
first is empty on all 16,031 rows of the last six weeks and the second
exists nowhere; as a side effect the `source_count` the shrug selector
ranks on is 1 for every candidate, and the round-robin across penalty
factors is the only ranking shrug has. And the "measures something
being talked about" source has been off for five months.

The nine r/OutOfTheLoop rows are too few to break down by week, but
they are not useless, because they contradict the mechanism the doc
assumed. None was early-rejected. Four passed the gate (REI strikes,
data-centre building, Spirit Airlines, backlash to The Sims) and one of
those was published. The five that failed are the FOMO classes almost
exactly: an Arby's takeover, the Met Gala, a game called Mixtape, the
Kevin Hart roast, and people breaking into malls for Swatch watches.
Each scored a `zeitgeist` of 3 and a `half_life` of 1 or 2, landing at
composite 2 to 4 against the threshold of 5, and each carries a
shrug-eligible penalty tag (`in_circle_hype`, `controversy_flash`,
`narrow_audience`, `single_platform`). So the news lane does not throw
these away before scoring; it scores them, gates them on durability,
and hands them to shrug. Measuring the demand properly needs the
connector unblocked, which is a connector job and not a lane job.

Since that source cannot answer, the nearest substitute is the
early-reject reasons on everything. The cold tier moves `raw_output`
to R2 after fourteen days, so the readable sample is the 1,599
early-rejected rows still inline, roughly the last two weeks, bucketed
by keyword on the scorer's free-text reason. The buckets are
approximate and the first one is a catch-all.

| Reason bucket | Rows |
|---|---|
| routine, incremental, no new event | 456 |
| uncategorised | 281 |
| local crime, accident, casualty | 215 |
| opinion and commentary | 189 |
| lifestyle, explainer, evergreen | 150 |
| product, gadget, deal | 89 |
| release and entertainment | 89 |
| celebrity, viral, clip | 57 |
| routine earnings and markets | 46 |
| sports and awards | 27 |

The class-shaped buckets (releases, products, sport and awards, people,
viral) add up to about one in eight early rejects. The list is not
where the FOMO classes die; most of what it refuses is opinion, local
crime and routine increments nobody has FOMO about. The classes die at
the gate, the way the OOTL five did and the way the Roadster did. One
more thing the prompt says and the data does not: early-rejected rows
are supposed to leave the scores at zero, and all 3,724 of the last six
weeks carry a full set of scores and factors anyway. Phase zero's "emit
two more numbers on a rejected row" is therefore not a change to how
the scorer behaves, only to what it is asked for.

The Roadster arrived as five rows in two days, all RSS, all attached
to one theme.

| Row | Domain | Ingested | Early-rejected | zeitgeist | half_life | composite | Crossover trigger |
|---|---|---|---|---|---|---|---|
| the stunt | theverge.com | 16 Oct 03:34 | no | 3 | 1 | 2 | yes |
| the stunt | aljazeera.com | 16 Oct 09:34 | yes | | | 1 | no |
| the thrusters explained | arstechnica.com | 16 Oct 15:34 | no | 2 | 1 | 0 | yes |
| "just for show" | theverge.com | 16 Oct 15:34 | no | 2 | 1 | 1 | yes |
| rival's mock video | aljazeera.com | 17 Oct 09:34 | yes | 1 | 1 | -1 | no |

The stunt was not early-rejected; the scorer took it seriously enough
to tag `technical_breakthrough` and `crossover_discussion` alongside
`in_circle_hype` and `manufactured_hype`, and the gate refused it on
`half_life`, which is the durability argument from the second section
exactly. On breadth, the row carries one of the four signals the doc
listed: the crossover trigger is set on all three scored rows, while
`additional_source_urls` is empty, there is no GDELT count, and the
theme has no Wikipedia corroboration (no Wikipedia row touching Tesla,
Roadster or Musk was ingested between 10 and 31 October). What the
theme carries is three distinct domains in twenty-four hours, and that
is the breadth signal phase zero has to use.

Then the pipeline shipped it, in the wrong form. The rows were ingested
on 16 October and scored on 18 and 19 October. Issue 26 was drafted on
17 October at 07:36, when they were in the window but unscored, so the
shrug selector could not see them. Issue 27 was drafted on 24 October
at 06:36 with a seven-day window on `ingested_at`, which cut at 17
October 06:36: every stunt row was out by a day, and the only Roadster
row inside was the rival's mock video, ingested three hours after the
cutoff. That row went out in Worth a shrug at rank 2, labelled
in-circle hype: "A flying car company that has been flying cars for
eleven years posted a video of its vehicle hovering over a Tesla
Roadster." The reader was told about the jab and never about the
stunt. Two design consequences follow. The shrug-or-recognising rule
has to be decided per cluster, since the row with no evidence and the
rows with the evidence are one story. And the lane's selector should
window on `scored_at` rather than `ingested_at`, or a reference that
lands on a Friday is invisible on Saturday and expired the Saturday
after, which is what happened here.

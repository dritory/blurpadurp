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

One empirical handle exists already. The r/OutOfTheLoop connector is a
weekly sample of exactly these gaps, phrased by the people who felt
them, scored by a rubric whose early-reject list refuses most of what
it brings. The scorer's `reject_reason` on that source, by week, is a
direct measure of the demand the news lane turns away, and it should
be read before any of the below is built.

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
The early-reject list refuses product launches, sports moments, award
outcomes, celebrity moments and single-platform virality before any
scoring happens, which is most of releases, people and moments. The
editor's four-quadrant rubric caps "loud but insignificant" at one or
two picks per issue by design. And the sources measure events being
reported: sixteen newsroom feeds, GDELT and Wikipedia, with only
r/OutOfTheLoop measuring something being talked about, and the
`viral_signals` fields the scorer could read never populated (open
question O6).

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
| `lostness` (0–5) | How much context does the reader need to not be lost? 0 is self-explanatory, 5 is "no idea what that is" | scorer, from evidence |
| `persistence` | Weeks this has stayed on at least one chart, or whether it is still rising | data, never the LLM |

`lostness` is the "what does that mean" shape measured directly, and
`encounter` is the breakout phase. The gate is `encounter × lostness
≥ T` with `persistence ≥ 2` as the confidence floor. Lifecycle stage
also ships as a pre-computed label on the row (`new`, `still going`,
`fading`, from weeks-on-chart and direction), the same way the shrug
tag does: it is the one piece of information the table says belongs
with the reference, it comes from data, and giving it to the composer
as a label keeps it out of the prose. Two things are missing on purpose. There is no
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
were being turned away. Discourse stays out through the breakout test
and the persistence floor rather than a category rule: a pile-on is
loud on one platform for two days and on no chart the week after. Sports moments, award outcomes, album drops, celebrity
moments and product launches are all admissible if they broke out. The
breakout test is the same one the news scorer already applies to
internet culture: one platform means `encounter` ≤ 2, three or more
platforms or a mainstream mention lets it reach 4. A second prompt
file, `docs/recognition-prompt.md`, with its own `recognition.
prompt_version`, same version-bump discipline as the other three.

Calibration anchors, point-in-time: Clubhouse at peak (encounter 3,
lostness 4, publishes), a Netflix number one in its third week
(encounter 4, lostness 3, publishes), a song at number one for the
ninth week (persistence 9, but it was already given to the reader, so
memory suppresses it), a forty-eight-hour pile-on (persistence 0,
fails), an in-circle crypto launch (encounter 1, fails).

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
`recognition.min_persistence_weeks` (2), `recognition.max_items` (6),
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
nobody will reference next week, so `persistence` measured at compose
time is doing real work. We will be late on everything and right about
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

And a rubric with no significance axis can still be gamed by
manufactured breakouts, since a marketing budget can buy a week on
several charts. The persistence floor is the defence, and the second
one is the same as in the news lane: keep `manufactured_hype` as a
penalty tag the scorer can set from evidence (paid placement, no
organic discussion), and let it block. We are not judging whether the
thing matters; we are still judging whether people actually met it.

## Build order

Two sources, one rule, one section, then widen. Phase one is the
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

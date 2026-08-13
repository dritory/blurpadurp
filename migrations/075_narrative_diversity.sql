-- Narrative diversity + prior-issue memory.
--
-- Two failures the pipeline had no structure against, both reported off
-- the same issue.
--
-- 1. THEME SATURATION. A dominant story does not arrive as one theme.
--    "US–Iran escalation", "Hormuz shipping", "oil price spike" are
--    three themes by every measure the system had — different arcs,
--    different story sets, all legitimately high composite — and the
--    reader experiences them as one piece of news. Nothing capped that,
--    so the whole conversation section could be, and was, one story told
--    four ways. The editor prompt has asked for topic balance since
--    v0.1; a prompt was never going to be enough, for the same reason
--    the composer doesn't choose its own sections.
--
--    The fix is about PLACEMENT, not exclusion. One item in the
--    conversation, one in Worth knowing, one in Worth watching reads as
--    a story the brief is following. Five in the conversation reads as a
--    brief with one subject. Same picks either way.
--
--    So: cluster themes by centroid cosine and cap the clusters.
--    - editor.cluster_threshold (0.72) sits between the story→theme
--      attach bar (0.70) and the theme→theme MERGE bar (0.85). That gap
--      is deliberate. mig 031 describes 0.70 as "semantically adjacent
--      but distinct arcs" and refuses to merge there — correct, they ARE
--      distinct arcs. Clustering does not merge them; it only counts
--      them as one story when measuring crowding.
--    - editor.pool_max_cluster_fraction (0.25) caps how much of the pool
--      one narrative may occupy, before the editor ever sees it. Tighter
--      than the category cap (0.5, mig 033) because "politics" is a
--      filing drawer and a cluster is one running story.
--    - compose.max_per_section_per_cluster (1) is the load-bearing one:
--      one narrative gets one slot per section, and its surplus is
--      pushed DOWN into the next section rather than cut. The story
--      earned its place in the issue; it just shouldn't own the top.
--      The cluster's best-ranked pick still leads, so spreading costs
--      the story nothing but the pile-up behind it.
--    - compose.max_picks_per_cluster (4) is a whole-issue backstop.
--      Surplus is cut, and a short issue is an acceptable outcome
--      (invariant 1, silence is a feature). With the per-section cap
--      doing the real work this rarely binds; it exists so a nine-story
--      cluster can't ride the spread all the way down the issue.
--
--    The synthesis opener is grouped by cluster too. Three themes off
--    one story used to seed three opener entries, so the paragraph the
--    reader always reads named the same news three ways.
--
--    Sections are fixed-size (routing is rank-based), so a section that
--    can't be filled under the cap is filled over it rather than left
--    short. Note this is ROUTINE, not an edge case: two five-wide
--    sections need ten picks before the tail sees anything and the
--    editor targets 10-15, so an issue at the bottom of that range runs
--    out of other-cluster material in section two as a matter of course.
--    diversifyPicks reports those placements as a count for exactly that
--    reason — one or two is a normal week, and only a count approaching
--    the issue size means the week really was one story.
--
-- 2. NO MEMORY. Per theme the pipeline knew a count
--    (n_prior_publications) and, for the composer, a timeline of story
--    one-liners. Neither answers "have we already told the reader this?"
--    — so a running story got re-picked and re-explained week after
--    week, every issue individually defensible and the sequence
--    repetitive. The v0.5 editor prompt notes list prior-issue memory as
--    the next signal to surface; this is it.
--
--    compose.recent_coverage_issues (3) is how many published issues the
--    editor and composer are shown, with what each one actually ran and
--    in which section. Three issues is about a month of a weekly: long
--    enough to catch "we've led with this three weeks running", short
--    enough that the digest stays small. It reads issue_pick, which has
--    recorded (issue, story, section, rank) all along — no new write
--    path, no new table, just a query nobody had written.
INSERT INTO config (key, value) VALUES
  ('editor.cluster_threshold',           '0.72'::jsonb),
  ('editor.pool_max_cluster_fraction',   '0.25'::jsonb),
  ('compose.max_picks_per_cluster',      '4'::jsonb),
  ('compose.max_per_section_per_cluster', '1'::jsonb),
  ('compose.recent_coverage_issues',     '3'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Prompt revisions for both stages. Neither model could act on any of
-- the above until it was told the fields exist and what they mean, so
-- the code change and the prompt bump ship together.
--
-- editor v0.6: narrative_clusters and recent_coverage in the input, the
-- rule that a cluster counts as one story for balance, and the rule that
-- an already-covered theme earns a re-pick only through genuine
-- development. The hard caps land regardless — the prompt exists so the
-- editor makes the choice itself rather than having it made for it.
--
-- composer v0.11: recent_issues in the input, plus the rules that follow
-- from it — don't re-explain background a prior issue already gave,
-- don't recycle the last opener's framing, reference an earlier issue as
-- a callback rather than as news.
--
-- Bumping both version strings invalidates cache-on-hash lookups, so the
-- next run is fresh output against the corrected prompts.
UPDATE config
SET value = '"editor-v0.6"'::jsonb, updated_at = now()
WHERE key = 'editor.prompt_version';

UPDATE config
SET value = '"composer-v0.11"'::jsonb, updated_at = now()
WHERE key = 'composer.prompt_version';

-- No index needed for the prior-issue digest: it selects issue_pick by
-- `issue_id IN (...)`, which is a prefix of the table's primary key
-- (issue_id, story_id) from mig 025. An index on (issue_id, rank) would
-- only serve the ORDER BY over a handful of rows, and on a fixed 500 MB
-- an index that buys nothing is a cost.

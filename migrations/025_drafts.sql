-- Draft → review → publish flow.
--
-- Before: compose() produced an issue row and flipped
-- story.published_to_reader=true in one transaction. Issues were
-- visible to readers instantly.
--
-- After: compose() produces a DRAFT (is_draft=true). Draft picks are
-- stored in issue_pick. Stories stay published_to_reader=false while
-- the draft exists, so re-running compose/editor on the draft doesn't
-- "take" them permanently. The explicit publish action flips is_draft
-- + marks stories, and the next hourly dispatch fires.
--
-- issue_annotation holds review comments slotted by section (opener,
-- conversation, worth_knowing, worth_watching, shrug, summary). No
-- anchor/span tracking — one textarea per slot keeps the UI
-- phone-friendly.
--
-- prompt_draft stages prompt edits for admin replay only. The
-- scheduled pipeline never reads this table; it always loads from
-- docs/*-prompt.md. See src/shared/prompts.ts (live vs replay mode).

ALTER TABLE issue ADD COLUMN is_draft boolean NOT NULL DEFAULT false;
ALTER TABLE issue ALTER COLUMN is_draft SET DEFAULT true;
-- Existing rows backfilled to false by the ADD COLUMN DEFAULT false
-- above; switching the default to true only affects subsequently
-- inserted rows (new compose runs).

CREATE TABLE issue_pick (
  issue_id integer NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
  story_id integer NOT NULL REFERENCES story(id) ON DELETE CASCADE,
  section text NOT NULL,
  rank integer NOT NULL,
  PRIMARY KEY (issue_id, story_id)
);

CREATE INDEX issue_pick_story_idx ON issue_pick (story_id);

CREATE TABLE issue_annotation (
  id serial PRIMARY KEY,
  issue_id integer NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
  slot text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX issue_annotation_issue_idx ON issue_annotation (issue_id);

CREATE TABLE prompt_draft (
  stage text PRIMARY KEY,
  prompt_md text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

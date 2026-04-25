-- Initial schema. Pre-1.0 — no backward compatibility guarantee.
-- See docs/architecture.md and docs/scoring.md for rationale.

CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================
-- Taxonomy
-- ============================================================

CREATE TABLE category (
  id bigserial PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  name text NOT NULL,
  description text
);

INSERT INTO category (slug, name) VALUES
  ('politics',            'Politics'),
  ('science',             'Science'),
  ('technology',          'Technology'),
  ('economy',             'Economy'),
  ('culture',             'Culture'),
  ('internet_culture',    'Internet Culture'),
  ('environment_climate', 'Environment & Climate'),
  ('health',              'Health'),
  ('society',             'Society');

-- ============================================================
-- Themes — narrow story-arcs within a category.
-- Embedding-clustering attaches stories; merges when centroids converge.
-- ============================================================

CREATE TABLE theme (
  id bigserial PRIMARY KEY,
  category_id bigint NOT NULL REFERENCES category(id),
  name text NOT NULL,
  description text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_published_at timestamptz,
  n_stories_published int NOT NULL DEFAULT 0,
  rolling_composite_avg numeric,
  rolling_composite_30d numeric,
  centroid_embedding vector(1024)
);

CREATE INDEX theme_category_idx ON theme(category_id);
CREATE INDEX theme_centroid_idx ON theme USING ivfflat (centroid_embedding vector_cosine_ops);

-- ============================================================
-- Stories — every classified item is persisted. Passers, rejects,
-- early-rejects, all. raw_input and raw_output preserve exact scorer
-- I/O for replay under future prompt versions.
-- ============================================================

CREATE TABLE story (
  id bigserial PRIMARY KEY,

  -- provenance
  source_name text NOT NULL,
  source_event_id text,
  source_url text,
  title text NOT NULL,
  summary text,
  published_at timestamptz,
  ingested_at timestamptz NOT NULL DEFAULT now(),

  -- classification
  category_id bigint REFERENCES category(id),
  theme_id bigint REFERENCES theme(id),
  embedding vector(1024),

  -- scoring I/O (for replay)
  as_of_date date NOT NULL,
  scorer_model_id text,
  scorer_prompt_version text,
  raw_input jsonb,
  raw_output jsonb,

  -- denormalized scores from raw_output
  zeitgeist_score smallint,
  half_life smallint,
  reach smallint,
  non_obviousness smallint,
  structural_importance smallint,
  composite numeric,
  point_in_time_confidence text,
  theme_relationship text,
  base_rate_per_year numeric,

  -- flags
  scored_at timestamptz,
  early_reject boolean NOT NULL DEFAULT false,
  passed_gate boolean NOT NULL DEFAULT false,
  published_to_reader boolean NOT NULL DEFAULT false,
  published_to_reader_at timestamptz,
  backtest_run_id bigint,

  -- video
  has_video boolean NOT NULL DEFAULT false,
  video_url text,
  video_embed_url text,
  video_thumbnail_url text,
  video_duration_sec int,
  video_caption text
);

CREATE INDEX story_theme_idx         ON story(theme_id);
CREATE INDEX story_category_idx      ON story(category_id);
CREATE INDEX story_published_idx     ON story(published_at DESC);
CREATE INDEX story_passed_gate_idx   ON story(passed_gate) WHERE passed_gate;
CREATE INDEX story_embedding_idx     ON story USING ivfflat (embedding vector_cosine_ops);
CREATE UNIQUE INDEX story_source_event_idx
  ON story(source_name, source_event_id)
  WHERE source_event_id IS NOT NULL;

-- ============================================================
-- Story factors — controlled-vocabulary tags (many-to-many).
-- Allowed values enforced by the scorer prompt, not the DB — pre-1.0
-- we extend vocabularies by prompt edits, not migrations.
-- ============================================================

CREATE TABLE story_factor (
  story_id bigint NOT NULL REFERENCES story(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('trigger', 'penalty', 'uncertainty')),
  factor text NOT NULL,
  PRIMARY KEY (story_id, kind, factor)
);

CREATE INDEX story_factor_kind_idx ON story_factor(kind, factor);

-- ============================================================
-- Issues — persisted briefs. Exist only when the gate produces >= 1 item.
-- ============================================================

CREATE TABLE issue (
  id bigserial PRIMARY KEY,
  published_at timestamptz NOT NULL DEFAULT now(),
  is_event_driven boolean NOT NULL DEFAULT false,
  composed_markdown text NOT NULL,
  composed_html text NOT NULL,
  story_ids bigint[] NOT NULL,
  composer_prompt_version text,
  composer_model_id text
);

CREATE INDEX issue_published_idx ON issue(published_at DESC);

-- ============================================================
-- Subscriptions — no accounts. The subscription IS the identity.
-- ============================================================

CREATE TABLE email_subscription (
  id bigserial PRIMARY KEY,
  email text UNIQUE NOT NULL,
  confirmed_at timestamptz,
  unsubscribed_at timestamptz,
  delivery_time_local time NOT NULL DEFAULT '09:00',
  timezone text NOT NULL DEFAULT 'UTC',
  urgent_override boolean NOT NULL DEFAULT false,
  category_mutes text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE push_subscription (
  id bigserial PRIMARY KEY,
  endpoint text UNIQUE NOT NULL,
  p256dh_key text NOT NULL,
  auth_key text NOT NULL,
  user_agent_label text,
  delivery_time_local time NOT NULL DEFAULT '09:00',
  timezone text NOT NULL DEFAULT 'UTC',
  urgent_override boolean NOT NULL DEFAULT false,
  category_mutes text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  unsubscribed_at timestamptz
);

-- ============================================================
-- Dispatch log — prevents double-send; per (issue, subscription) uniqueness.
-- ============================================================

CREATE TABLE dispatch_log (
  id bigserial PRIMARY KEY,
  issue_id bigint NOT NULL REFERENCES issue(id),
  subscription_kind text NOT NULL CHECK (subscription_kind IN ('email', 'push')),
  subscription_id bigint NOT NULL,
  dispatched_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL,
  error text,
  UNIQUE (issue_id, subscription_kind, subscription_id)
);

-- ============================================================
-- AI call log — every LLM call across every stage.
-- Substrate for cost monitoring, drift detection, replay diffs.
-- ============================================================

CREATE TABLE ai_call_log (
  id bigserial PRIMARY KEY,
  stage_name text NOT NULL,
  stage_version text NOT NULL,
  model_id text NOT NULL,
  input_hash text,
  input_jsonb jsonb,
  output_jsonb jsonb,
  tokens_in int,
  tokens_out int,
  cost_estimate_usd numeric,
  latency_ms int,
  error text,
  started_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ai_call_log_stage_idx ON ai_call_log(stage_name, started_at DESC);

-- ============================================================
-- Config — rules as data. Edit a row, no deploy needed.
-- ============================================================

CREATE TABLE config (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO config (key, value) VALUES
  ('scorer.model_id',              '"claude-haiku-4-5-20251001"'::jsonb),
  ('scorer.prompt_version',        '"prompt-v0.2"'::jsonb),
  ('scorer.prompt_path',           '"docs/scoring-prompt.md"'::jsonb),
  ('scorer.max_tokens',            '2000'::jsonb),
  ('scorer.temperature',           '0'::jsonb),
  ('composer.model_id',            '"claude-sonnet-4-6"'::jsonb),
  ('composer.prompt_version',      '"composer-v0.1"'::jsonb),
  ('composer.max_tokens',          '8000'::jsonb),
  ('editor.model_id',              '"claude-sonnet-4-6"'::jsonb),
  ('editor.prompt_version',        '"editor-v0.1"'::jsonb),
  ('editor.max_tokens',            '2000'::jsonb),
  ('editor.pool_size',             '60'::jsonb),
  ('editor.pool_max_category_fraction', '0.5'::jsonb),
  ('gate.x_threshold',             '5'::jsonb),
  ('gate.delta',                   '1'::jsonb),
  ('gate.event_driven_multiplier', '2'::jsonb),
  ('gate.confidence_floor',        '"medium"'::jsonb),
  ('theme.attach_threshold',       '0.70'::jsonb),
  ('theme.create_recheck_threshold','0.88'::jsonb),
  ('theme.merge_threshold',        '0.85'::jsonb),
  ('cadence.interval',             '"weekly"'::jsonb),
  ('cadence.run_at_utc',           '"Sunday 20:00"'::jsonb),
  ('compose.min_publish_gap_hours','144'::jsonb),
  ('budget.daily_usd_cap',         '5'::jsonb);

-- ============================================================
-- Source cursors — per-connector ingestion checkpoints.
-- ============================================================

CREATE TABLE source_cursor (
  connector_name text NOT NULL,
  scope_key text NOT NULL DEFAULT 'global',
  last_seen_at timestamptz,
  last_seen_id text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connector_name, scope_key)
);

-- ============================================================
-- Backtesting (see docs/backtesting.md)
-- ============================================================

CREATE TABLE backtest_run (
  id bigserial PRIMARY KEY,
  mode text NOT NULL CHECK (mode IN ('A', 'B')),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  prompt_version text NOT NULL,
  model_id text NOT NULL,
  story_count int,
  metrics jsonb,
  notes text
);

CREATE TABLE ground_truth (
  id bigserial PRIMARY KEY,
  story_id bigint NOT NULL UNIQUE REFERENCES story(id) ON DELETE CASCADE,
  evaluated_at timestamptz NOT NULL DEFAULT now(),
  proxy_composite numeric,
  llm_judge_score numeric,
  operator_label smallint,
  ground_truth_score numeric,
  evidence jsonb
);

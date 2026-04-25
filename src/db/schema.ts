// Kysely types mirroring migrations/001_init.sql.
// Pre-1.0 — keep in sync with migrations by hand.

import type { ColumnType, Generated } from "kysely";

type Id = Generated<number>;
type Created = Generated<Date>;

// Columns backed by jsonb. The shape varies by column; we select as
// `unknown` and cast at read time against the scorer / composer schemas.
// Kysely's JSONColumnType requires Select to be object|null, but many
// of our jsonb columns are more loosely typed — ColumnType sidesteps
// that constraint.
type Jsonb = ColumnType<unknown, string, string>;

export interface Database {
  category: {
    id: Id;
    slug: string;
    name: string;
    description: string | null;
  };

  theme: {
    id: Id;
    category_id: number;
    name: string;
    description: string | null;
    first_seen_at: Created;
    last_published_at: Date | null;
    n_stories_published: Generated<number>;
    rolling_composite_avg: string | null;
    rolling_composite_30d: string | null;
    centroid_embedding: string | null;
    is_long_running: Generated<boolean>;
  };

  story: {
    id: Id;
    source_name: string;
    source_event_id: string | null;
    source_url: string | null;
    title: string;
    summary: string | null;
    published_at: Date | null;
    ingested_at: Created;
    category_id: number | null;
    theme_id: number | null;
    embedding: string | null;
    as_of_date: ColumnType<Date, string, string>;
    scorer_model_id: string | null;
    scorer_prompt_version: string | null;
    raw_input: Jsonb | null;
    raw_output: Jsonb | null;
    zeitgeist_score: number | null;
    half_life: number | null;
    reach: number | null;
    non_obviousness: number | null;
    structural_importance: number | null;
    composite: string | null;
    point_in_time_confidence: string | null;
    theme_relationship: string | null;
    base_rate_per_year: string | null;
    scored_at: Date | null;
    early_reject: Generated<boolean>;
    passed_gate: Generated<boolean>;
    published_to_reader: Generated<boolean>;
    published_to_reader_at: Date | null;
    backtest_run_id: number | null;
    has_video: Generated<boolean>;
    video_url: string | null;
    video_embed_url: string | null;
    video_thumbnail_url: string | null;
    video_duration_sec: number | null;
    video_caption: string | null;
    additional_source_urls: Generated<string[]>;
    first_pass_composite: string | null;
    first_pass_model_id: string | null;
    first_pass_prompt_version: string | null;
    first_pass_scored_at: Date | null;
    scored_via_story_id: number | null;
  };

  story_factor: {
    story_id: number;
    kind: "trigger" | "penalty" | "uncertainty";
    factor: string;
  };

  issue: {
    id: Id;
    published_at: Created;
    is_event_driven: Generated<boolean>;
    title: string | null;
    composed_markdown: string;
    composed_html: string;
    story_ids: number[];
    composer_prompt_version: string | null;
    composer_model_id: string | null;
    editor_input_jsonb: Jsonb | null;
    editor_output_jsonb: Jsonb | null;
    shrug_candidates_jsonb: Jsonb | null;
    composer_input_jsonb: Jsonb | null;
    is_draft: Generated<boolean>;
  };

  issue_pick: {
    issue_id: number;
    story_id: number;
    section: string;
    rank: number;
  };

  issue_annotation: {
    id: Id;
    issue_id: number;
    slot: string;
    body: string;
    anchor_key: string | null;
    created_at: Created;
  };

  prompt_draft: {
    stage: string;
    prompt_md: string;
    updated_at: Created;
  };

  email_subscription: {
    id: Id;
    email: string;
    confirmed_at: Date | null;
    unsubscribed_at: Date | null;
    delivery_time_local: Generated<string>;
    timezone: Generated<string>;
    urgent_override: Generated<boolean>;
    category_mutes: Generated<string[]>;
    created_at: Created;
  };

  push_subscription: {
    id: Id;
    endpoint: string;
    p256dh_key: string;
    auth_key: string;
    user_agent_label: string | null;
    delivery_time_local: Generated<string>;
    timezone: Generated<string>;
    urgent_override: Generated<boolean>;
    category_mutes: Generated<string[]>;
    created_at: Created;
    unsubscribed_at: Date | null;
  };

  dispatch_log: {
    id: Id;
    issue_id: number;
    subscription_kind: "email" | "push";
    subscription_id: number;
    dispatched_at: Created;
    status: string;
    error: string | null;
    provider_message_id: string | null;
  };

  ai_call_log: {
    id: Id;
    stage_name: string;
    stage_version: string;
    model_id: string;
    input_hash: string | null;
    input_jsonb: Jsonb | null;
    output_jsonb: Jsonb | null;
    tokens_in: number | null;
    tokens_out: number | null;
    cost_estimate_usd: string | null;
    latency_ms: number | null;
    error: string | null;
    started_at: Created;
  };

  config: {
    key: string;
    value: Jsonb;
    updated_at: Created;
  };

  source_cursor: {
    connector_name: string;
    scope_key: Generated<string>;
    last_seen_at: Date | null;
    last_seen_id: string | null;
    updated_at: Created;
  };

  backtest_run: {
    id: Id;
    mode: "A" | "B";
    started_at: Created;
    completed_at: Date | null;
    prompt_version: string;
    model_id: string;
    story_count: number | null;
    metrics: Jsonb | null;
    notes: string | null;
  };

  ground_truth: {
    id: Id;
    story_id: number;
    evaluated_at: Created;
    proxy_composite: string | null;
    llm_judge_score: string | null;
    operator_label: number | null;
    ground_truth_score: string | null;
    evidence: Jsonb | null;
  };

  schema_migration: {
    name: string;
    applied_at: Created;
  };

  eval_label: {
    story_id: number;
    label: "yes" | "maybe" | "no" | "skip";
    notes: string | null;
    labeled_at: Created;
  };

  pipeline_lock: {
    stage_name: string;
    acquired_at: Created;
    expires_at: Date;
  };
}

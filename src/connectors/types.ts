// One interface, N implementations. Add a source = new file + one line
// in registry.ts. Pipeline orchestrator never changes.

export interface Cursor {
  last_seen_at: Date | null;
  last_seen_id: string | null;
}

export interface RawSourceItem {
  source_event_id: string;
  fetched_at: Date;
  raw: unknown; // connector-specific payload; typed internally
}

export interface NormalizedStoryInput {
  source_name: string;
  source_event_id: string;
  source_url: string | null;
  title: string;
  summary: string | null;
  published_at: Date | null;

  // optional video envelope; scorer will treat has_video as a hint
  has_video?: boolean;
  video_url?: string | null;
  video_embed_url?: string | null;
  video_thumbnail_url?: string | null;
  video_duration_sec?: number | null;
  video_caption?: string | null;

  // optional structured extras a connector can surface to the scorer
  gdelt_metadata?: {
    event_id?: string;
    wikipedia_corroborated?: boolean;
    source_count?: number;
    mention_count_48h?: number;
    tone_mean?: number;
  };

  viral_signals?: {
    google_trends_7d_ratio?: number;
    google_trends_14d_tail?: number;
    cross_platform_count?: number;
    mainstream_crossover?: boolean;
    derivative_works_count?: number;
    kym_status?: string | null;
  };
}

export interface Connector {
  name: string;
  fetchSince(cursor: Cursor): Promise<RawSourceItem[]>;
  normalize(raw: RawSourceItem): NormalizedStoryInput;
}

-- Collapse URL-level duplicates and switch GDELT rows' source_event_id
-- from GLOBALEVENTID (event-level) to canonical URL (article-level).
--
-- Rationale: GDELT reprocesses the same article under different
-- GLOBALEVENTIDs over time, so event-level IDs leaked through the
-- ON CONFLICT dedup. Using the URL as the id is stable across runs.
--
-- Deletion priority: keep scored rows over unscored; GDELT over RSS
-- when tied (GDELT carries additional_source_urls from the mentions
-- layer); lowest id otherwise.

WITH ranked AS (
  SELECT id,
    ROW_NUMBER() OVER (
      PARTITION BY source_url
      ORDER BY
        (scored_at IS NOT NULL) DESC,
        (source_name = 'gdelt') DESC,
        id ASC
    ) AS rn
  FROM story
  WHERE source_url IS NOT NULL
)
DELETE FROM story WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- Flip GDELT source_event_id to the canonical URL for the survivors.
UPDATE story
SET source_event_id = source_url
WHERE source_name = 'gdelt'
  AND source_url IS NOT NULL
  AND source_event_id != source_url;

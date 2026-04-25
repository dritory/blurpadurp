-- theme.n_stories_published has been a default-zero column since 001
-- with no code path that increments it, so /admin/themes shows every
-- theme at 0. publishDraft now bumps it (one per distinct theme in
-- the picks); this migration backfills the historical count from the
-- story table where published_to_reader=true.

UPDATE theme t
SET n_stories_published = sub.n
FROM (
  SELECT theme_id, count(*)::int AS n
  FROM story
  WHERE published_to_reader = true
    AND theme_id IS NOT NULL
  GROUP BY theme_id
) sub
WHERE t.id = sub.theme_id;

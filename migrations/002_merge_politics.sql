-- Collapse geopolitics + policy into a single `politics` category.
-- Pre-1.0 taxonomy reshape: the reader is not country-specific, so the
-- distinction between cross-border (geopolitics) and within-jurisdiction
-- (policy) was not adding analytical value.

-- Rename `policy` → `politics` (keeps the existing row + its foreign keys).
UPDATE category
SET slug = 'politics', name = 'Politics'
WHERE slug = 'policy';

-- Move stories and themes that pointed at `geopolitics` to `politics`.
UPDATE story
SET category_id = (SELECT id FROM category WHERE slug = 'politics')
WHERE category_id = (SELECT id FROM category WHERE slug = 'geopolitics');

UPDATE theme
SET category_id = (SELECT id FROM category WHERE slug = 'politics')
WHERE category_id = (SELECT id FROM category WHERE slug = 'geopolitics');

-- Remove the now-unreferenced `geopolitics` row.
DELETE FROM category WHERE slug = 'geopolitics';

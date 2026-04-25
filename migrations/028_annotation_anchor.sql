-- Annotations can now anchor to a specific element in the rendered
-- brief — a section heading or a bullet — instead of only the
-- section-level slot enum. Existing notes carry NULL anchor_key
-- (general / unanchored) and continue to render as before.
--
-- Anchor keys are server-side index identifiers like "h2:0" (first
-- heading) or "li:3" (fourth bullet in document order). The view
-- injects `data-anchor-id` attributes on the corresponding elements
-- when rendering composed_html.
--
-- Brittleness: re-composing changes element ordering, so existing
-- notes may anchor to different content than the operator intended.
-- This is the same trade-off as Google Docs comments after a major
-- edit. Notes whose anchor no longer matches an element are surfaced
-- in an "unresolved" sidebar group rather than dropped.
ALTER TABLE issue_annotation
  ADD COLUMN anchor_key text;

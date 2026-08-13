-- Subscriber language.
--
-- The site now serves its chrome in English and Norwegian (/no/*), but
-- a subscriber's language can't be recovered from a URL once they're in
-- their inbox: the confirmation mail, the issue mail, and the signed
-- preferences link all arrive with no locale context at all. So it has
-- to be stored on the row at signup — the subscribe form carries a
-- hidden locale field, and everything transactional reads it back.
--
-- Text with a CHECK rather than an enum type: the set of locales is
-- expected to move, and adding a value to a Postgres enum is a DDL
-- change on a hot table where widening a CHECK is not.
--
-- Defaults to 'en', which is correct for every existing row — they all
-- signed up on the English-only site.
--
-- Note what this does NOT do: it does not translate the brief. Issue
-- bodies are the composer's output and stay English regardless of this
-- column. A Norwegian brief needs a second composer pass against an
-- nb-NO prompt, which is a separate decision with a real per-issue cost.
ALTER TABLE email_subscription
  ADD COLUMN IF NOT EXISTS locale text NOT NULL DEFAULT 'en';

ALTER TABLE email_subscription
  DROP CONSTRAINT IF EXISTS email_subscription_locale_check;

ALTER TABLE email_subscription
  ADD CONSTRAINT email_subscription_locale_check
  CHECK (locale IN ('en', 'nb'));

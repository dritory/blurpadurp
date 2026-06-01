-- Draft-review dispatch.
--
-- Two reviewers (the operator and his wife) want to read each week's
-- issue *as a draft* — before it ships — and leave notes via the
-- existing reviewer-preview page (kind=draft-preview token, see
-- src/views/draft-preview.tsx). They also want the normal published
-- brief once it goes out.
--
-- Mechanism: a reviewer is just an email_subscription with a flag.
-- - is_reviewer = true  → the dispatch sweep emails them a signed
--   draft-preview link the moment compose persists a new draft.
-- - confirmed_at set / unsubscribed_at null → the same sweep emails
--   them the published brief later, exactly like any other subscriber.
-- So "read the draft" and "notified when a new issue arrives" fall out
-- of one flag plus the subscriber row they already have.
--
-- Default false, so this is a no-op for every existing subscription.
-- Promote a subscriber from /admin/reviewers (or with a one-line
-- UPDATE … SET is_reviewer = true WHERE email = '…').

ALTER TABLE email_subscription
  ADD COLUMN IF NOT EXISTS is_reviewer boolean NOT NULL DEFAULT false;

-- Tiny partial index — the reviewer set is a handful of rows, but the
-- dispatch draft pass scans on this flag every sweep.
CREATE INDEX IF NOT EXISTS email_subscription_reviewer_idx
  ON email_subscription(id) WHERE is_reviewer;

-- dispatch_log needs a third subscription_kind so a draft send is
-- tracked independently of the eventual published-issue send for the
-- same (issue, subscriber) pair. The at-most-once UNIQUE constraint is
-- (issue_id, subscription_kind, subscription_id), so 'draft' and
-- 'email' rows for one issue×subscriber coexist: the reviewer gets the
-- preview once and the published brief once, never a duplicate of
-- either. Drop-then-add so re-runs are safe (same pattern as 043-050).
ALTER TABLE dispatch_log DROP CONSTRAINT IF EXISTS dispatch_log_subscription_kind_check;
ALTER TABLE dispatch_log
  ADD CONSTRAINT dispatch_log_subscription_kind_check
  CHECK (subscription_kind IN ('email', 'push', 'draft'));

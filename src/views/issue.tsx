import type { FC } from "hono/jsx";
import { BriefLanguageNote, Layout } from "./layout.tsx";
import { sanitizeBriefHtml } from "../shared/sanitize-html.ts";
import {
  DATE_LOCALE,
  DEFAULT_LOCALE,
  type Locale,
  localizePath,
  t,
} from "../shared/i18n.ts";

export interface IssueView {
  id: number;
  publishedSeq: number | null;
  publishedAt: Date;
  isEventDriven: boolean;
  title: string | null;
  html: string;
}

// Reader-facing issue label. `published_seq` is gap-free (drafts don't
// burn numbers); fall back to the surrogate id only for issues
// pre-dating migration 041 that somehow weren't backfilled.
export function issueLabel(
  issue: { id: number; publishedSeq: number | null },
  locale: Locale = DEFAULT_LOCALE,
): string {
  return `${t(locale).issue.labelPrefix}${issue.publishedSeq ?? issue.id}`;
}

export function formatIssueDate(
  d: Date,
  locale: Locale = DEFAULT_LOCALE,
): string {
  return d.toLocaleDateString(DATE_LOCALE[locale], {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export const IssueBody: FC<{ issue: IssueView; locale?: Locale }> = ({
  issue,
  locale = DEFAULT_LOCALE,
}) => (
  <article class="issue-body">
    <BriefLanguageNote locale={locale} />
    <div class="issue-meta">
      {issueLabel(issue, locale)} · {formatIssueDate(issue.publishedAt, locale)}
      {issue.isEventDriven ? ` · ${t(locale).issue.eventDriven}` : ""}
    </div>
    {issue.title !== null ? (
      <h1 class="issue-title">{issue.title}</h1>
    ) : null}
    {/* The brief body itself is the composer's output and is not
        translated — see the note above and shared/i18n.ts. */}
    <div dangerouslySetInnerHTML={{ __html: sanitizeBriefHtml(issue.html) }} />
  </article>
);

export const IssuePage: FC<{ issue: IssueView; locale?: Locale }> = ({
  issue,
  locale = DEFAULT_LOCALE,
}) => (
  <Layout
    title={`${issue.title ?? issueLabel(issue, locale)} — Blurpadurp`}
    nav="archive"
    locale={locale}
    altPath={localizePath(DEFAULT_LOCALE, `/issue/${issue.id}`)}
  >
    <IssueBody issue={issue} locale={locale} />
  </Layout>
);

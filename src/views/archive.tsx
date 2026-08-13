import type { FC } from "hono/jsx";
import { BriefLanguageNote, Layout } from "./layout.tsx";
import { formatIssueDate, issueLabel } from "./issue.tsx";
import { DEFAULT_LOCALE, type Locale, localizePath, t } from "../shared/i18n.ts";

export interface ArchiveEntry {
  id: number;
  publishedSeq: number | null;
  publishedAt: Date;
  isEventDriven: boolean;
  title: string | null;
}

export const Archive: FC<{ issues: ArchiveEntry[]; locale?: Locale }> = ({
  issues,
  locale = DEFAULT_LOCALE,
}) => {
  const s = t(locale);
  return (
    <Layout
      title={s.archive.pageTitle}
      nav="archive"
      locale={locale}
      altPath="/archive"
    >
      <h2>{s.archive.title}</h2>
      <BriefLanguageNote locale={locale} />
      {issues.length === 0 ? (
        <p>
          <em>{s.archive.empty}</em>
        </p>
      ) : (
        <ul class="archive-list">
          {issues.map((iss) => (
            <li>
              <a href={localizePath(locale, `/issue/${iss.id}`)}>
                <span class="date">
                  {formatIssueDate(iss.publishedAt, locale)}
                  {iss.isEventDriven ? ` · ${s.issue.eventDriven}` : ""}
                </span>
                <span class="title">
                  {iss.title ?? issueLabel(iss, locale)}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </Layout>
  );
};

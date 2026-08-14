import type { FC } from "hono/jsx";
import { Layout } from "./layout.tsx";
import { IssueBody, type IssueView, formatIssueDate, issueLabel } from "./issue.tsx";
import {
  DEFAULT_LOCALE,
  fill,
  type Locale,
  localizePath,
  t,
} from "../shared/i18n.ts";

export type Flash = { kind: "ok" | "error"; msg: string } | null;

// Three home-page states: the latest issue is fresh, the latest issue
// is older than home.staleness_threshold_days (silence), or no issue
// has ever published. The silence panel deep-links the most recent
// back issue so the page isn't a dead end.
export type HomeViewData =
  | { kind: "issue"; issue: IssueView }
  | {
      kind: "silent";
      lastIssue: {
        id: number;
        publishedSeq: number | null;
        publishedAt: Date;
        title: string | null;
      };
    }
  | { kind: "empty" };

export const Home: FC<{
  home: HomeViewData;
  flash: Flash;
  locale?: Locale;
}> = ({ home, flash, locale = DEFAULT_LOCALE }) => (
  <Layout title="Blurpadurp" nav="home" locale={locale} altPath="/">
    {flash !== null ? (
      <div class={`flash ${flash.kind === "error" ? "error" : ""}`}>
        {flash.msg}
      </div>
    ) : null}
    {home.kind === "issue" ? (
      <IssueBody issue={home.issue} locale={locale} />
    ) : home.kind === "silent" ? (
      <SilencePanel last={home.lastIssue} locale={locale} />
    ) : (
      <p>
        <em>{t(locale).home.empty}</em>
      </p>
    )}
  </Layout>
);

const SilencePanel: FC<{
  last: {
    id: number;
    publishedSeq: number | null;
    publishedAt: Date;
    title: string | null;
  };
  locale: Locale;
}> = ({ last, locale }) => {
  const s = t(locale);
  return (
    <article class="issue-body">
      <div class="issue-meta">{formatIssueDate(new Date(), locale)}</div>
      <h1 class="issue-title">{s.home.quietTitle}</h1>
      <p>
        <em>{s.home.quietBody}</em>
      </p>
      <div style="margin-top: 3em;">
        <p style="margin: 0; color: var(--ink-soft); font-family: var(--sans); font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em;">
          {s.home.lastBrief}
        </p>
        <p style="margin: 6px 0 0;">
          <a href={localizePath(locale, `/issue/${last.id}`)}>
            {last.title ?? issueLabel(last, locale)}
          </a>
        </p>
        <p style="margin: 2px 0 0; color: var(--ink-soft); font-size: 14px;">
          {formatIssueDate(last.publishedAt, locale)}
        </p>
      </div>
      <p
        style="margin-top: 1.5em;"
        dangerouslySetInnerHTML={{
          __html: fill(s.home.olderIssuesHtml, {
            archive: localizePath(locale, "/archive"),
          }),
        }}
      />
    </article>
  );
};

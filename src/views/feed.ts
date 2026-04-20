// Atom feed rendering. Anti-algorithm product, pro-RSS by principle —
// readers who quit social media should still be able to follow this
// through their own reader. Plain string templates, no dep.

interface FeedEntry {
  id: number;
  publishedAt: Date;
  html: string;
  isEventDriven: boolean;
}

function xmlEscape(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function entry(e: FeedEntry, baseUrl: string): string {
  const url = `${baseUrl}/issue/${e.id}`;
  const title = e.isEventDriven
    ? `Issue #${e.id} — event-driven`
    : `Issue #${e.id}`;
  return `  <entry>
    <id>${xmlEscape(url)}</id>
    <title>${xmlEscape(title)}</title>
    <link rel="alternate" type="text/html" href="${xmlEscape(url)}"/>
    <updated>${e.publishedAt.toISOString()}</updated>
    <published>${e.publishedAt.toISOString()}</published>
    <content type="html">${xmlEscape(e.html)}</content>
  </entry>`;
}

export function renderAtomFeed(params: {
  baseUrl: string;
  entries: FeedEntry[];
  updated: Date;
}): string {
  const { baseUrl, entries, updated } = params;
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${xmlEscape(baseUrl)}/</id>
  <title>Blurpadurp</title>
  <subtitle>The anti-social-media zeitgeist brief.</subtitle>
  <link rel="alternate" type="text/html" href="${xmlEscape(baseUrl)}/"/>
  <link rel="self" type="application/atom+xml" href="${xmlEscape(baseUrl)}/feed.xml"/>
  <updated>${updated.toISOString()}</updated>
${entries.map((e) => entry(e, baseUrl)).join("\n")}
</feed>
`;
}

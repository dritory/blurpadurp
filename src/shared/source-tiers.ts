// Domains considered reliable enough to weight higher in story selection
// and canonical-URL preference. GDELT's NumMentions over-weights regional
// aggregators that wire-redistribute viral content; re-ranking by tier-1
// citation count biases toward events that professional newsrooms vetted.
// Non-exhaustive; add legitimate outlets as they show up in the data.

export const TIER1_DOMAINS = new Set<string>([
  "reuters.com",
  "apnews.com",
  "ap.org",
  "bbc.com",
  "bbc.co.uk",
  "ft.com",
  "nytimes.com",
  "wsj.com",
  "washingtonpost.com",
  "bloomberg.com",
  "economist.com",
  "theguardian.com",
  "aljazeera.com",
  "france24.com",
  "dw.com",
  "japantimes.co.jp",
  "scmp.com",
  "theatlantic.com",
  "newyorker.com",
  "politico.com",
  "semafor.com",
  "axios.com",
  "propublica.org",
  "npr.org",
  "cbsnews.com",
  "nbcnews.com",
  "abcnews.go.com",
  "cnn.com",
  "lemonde.fr",
  "spiegel.de",
  "elpais.com",
  "nature.com",
  "science.org",
]);

export function domainOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

export function isTier1(url: string): boolean {
  const d = domainOf(url);
  return d !== null && TIER1_DOMAINS.has(d);
}

export function countTier1(urls: Iterable<string>): number {
  let n = 0;
  for (const u of urls) if (isTier1(u)) n++;
  return n;
}

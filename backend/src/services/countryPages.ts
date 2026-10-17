import { config } from '../config.js';
import { findCountryReference, type CountryReference } from '../data/countryReferences.js';
import { fetchJson, qs } from '../lib/http.js';
import type { ExtraSourceDoc } from './extraSources.js';

/**
 * The country's Wikivoyage guide and Wikipedia article, from the sources sheet
 * (data/countryReferences.ts), as source documents for the write-ups.
 *
 * They go through the same passage mining as the official tourism site and the
 * operator's own links (excerptsForPlace): a write-up only ever receives the
 * few hundred characters around a mention of its own place, never the country
 * article as a whole. A country guide names its best-known sights, so this
 * mostly helps the famous places; a place it does not name gets nothing.
 */

/** Same ceiling as a pasted source page. */
const MAX_DOC_CHARS = 60_000;

export interface CountryPagesResult {
  reference?: CountryReference;
  docs: ExtraSourceDoc[];
  warnings: string[];
}

/** One read per country per process: a batch sheet lists many cities per country. */
const cache = new Map<string, Promise<CountryPagesResult>>();

/** "https://en.wikivoyage.org/wiki/Sri_Lanka" -> host and "Sri Lanka". */
export function pageOf(url: string): { host: string; title: string } | undefined {
  try {
    const parsed = new URL(url);
    const match = /^\/wiki\/(.+)$/.exec(parsed.pathname);
    if (!match) return undefined;
    return { host: parsed.hostname, title: decodeURIComponent(match[1]!).replace(/_/g, ' ') };
  } catch {
    return undefined;
  }
}

async function readPage(url: string, site: string): Promise<ExtraSourceDoc | undefined> {
  const page = pageOf(url);
  if (!page) return undefined;
  const payload = await fetchJson<{
    query?: { pages?: Array<{ title?: string; extract?: string; missing?: boolean }> };
  }>(
    `https://${page.host}/w/api.php?${qs({
      action: 'query',
      format: 'json',
      formatversion: 2,
      prop: 'extracts',
      explaintext: 1,
      exsectionformat: 'plain',
      redirects: 1,
      titles: page.title,
      origin: '*',
    })}`,
    { timeoutMs: 30_000, retries: 1 },
  );
  const found = payload.query?.pages?.[0];
  const text = found?.extract?.trim();
  if (!text) return undefined;
  return { url, label: `${site} — ${found?.title ?? page.title}`, text: text.slice(0, MAX_DOC_CHARS) };
}

/** Reads the country's pages, or returns none when the sheet has no row for it. */
export function countryPages(countryCode: string | undefined, country?: string): Promise<CountryPagesResult> {
  if (!config.content.countryPages) return Promise.resolve({ docs: [], warnings: [] });
  const reference = findCountryReference(countryCode, country);
  if (!reference) return Promise.resolve({ docs: [], warnings: [] });

  const key = reference.country.toLowerCase();
  const cached = cache.get(key);
  if (cached) return cached;

  const pending = (async (): Promise<CountryPagesResult> => {
    const docs: ExtraSourceDoc[] = [];
    const warnings: string[] = [];
    const pages: Array<[string | undefined, string]> = [
      [reference.wikivoyage, 'Wikivoyage'],
      [reference.wikipedia, 'Wikipedia'],
    ];
    for (const [url, site] of pages) {
      if (!url) continue;
      try {
        const doc = await readPage(url, site);
        if (doc) docs.push(doc);
        else warnings.push(`${site} page for ${reference.country} had no readable text.`);
      } catch (error) {
        warnings.push(
          `${site} page for ${reference.country} could not be read (${error instanceof Error ? error.message : String(error)}).`,
        );
      }
    }
    return { reference, docs, warnings };
  })();

  cache.set(key, pending);
  // A failed read should be retried by the next search, not remembered.
  void pending.then((result) => {
    if (result.docs.length === 0) cache.delete(key);
  });
  return pending;
}

/** Test seam. */
export function resetCountryPagesCache(): void {
  cache.clear();
}

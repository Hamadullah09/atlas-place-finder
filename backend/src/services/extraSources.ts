import { fetchWithPolicy } from '../lib/http.js';
import { cleanText } from '../lib/sanitize.js';

/**
 * User-supplied "additional source" pages (tourism portals, official guides).
 * Each is fetched once per batch, reduced to plain text, and mined for
 * passages that mention a specific place so the write-up model only ever sees
 * text that is actually about that place.
 */

export interface ExtraSourceDoc {
  url: string;
  label: string;
  text: string;
}

const MAX_DOC_CHARS = 60_000;
const EXCERPT_WINDOW = 700;
const MAX_EXCERPTS_PER_DOC = 3;

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|p|div|li|h[1-6]|tr|section|article)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function titleOf(html: string, url: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = match ? cleanText(match[1], 120) : '';
  if (title) return title;
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Fetches every reachable source once. Unreachable ones become warnings. */
export async function fetchExtraSources(
  urls: string[],
): Promise<{ docs: ExtraSourceDoc[]; warnings: string[] }> {
  const docs: ExtraSourceDoc[] = [];
  const warnings: string[] = [];

  for (const url of urls) {
    try {
      const response = await fetchWithPolicy(url, { timeoutMs: 30_000, retries: 1 });
      const html = await response.text();
      const text = stripHtml(html).slice(0, MAX_DOC_CHARS);
      if (text.length < 200) {
        warnings.push(`Source ${url} returned too little readable text to use.`);
        continue;
      }
      docs.push({ url, label: titleOf(html, url), text });
    } catch (error) {
      warnings.push(
        `Source ${url} could not be fetched (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
  }

  return { docs, warnings };
}

/**
 * Passages from the fetched sources that mention the place by name. Returns at
 * most a few windows per document — enough to ground a paragraph, small enough
 * not to drown the model's context.
 */
export function excerptsForPlace(
  docs: ExtraSourceDoc[],
  placeName: string,
): Array<{ label: string; url: string; text: string }> {
  const name = placeName.trim();
  if (name.length < 3) return [];

  const needle = name.toLowerCase();
  const results: Array<{ label: string; url: string; text: string }> = [];

  for (const doc of docs) {
    const haystack = doc.text.toLowerCase();
    const windows: string[] = [];
    let from = 0;

    while (windows.length < MAX_EXCERPTS_PER_DOC) {
      const at = haystack.indexOf(needle, from);
      if (at === -1) break;
      const start = Math.max(0, at - Math.floor(EXCERPT_WINDOW / 2));
      const end = Math.min(doc.text.length, at + name.length + Math.floor(EXCERPT_WINDOW / 2));
      windows.push(doc.text.slice(start, end).replace(/\s+/g, ' ').trim());
      // Jump past this window so overlapping mentions collapse into one excerpt.
      from = end;
    }

    if (windows.length > 0) {
      results.push({ label: doc.label, url: doc.url, text: windows.join(' […] ') });
    }
  }

  return results;
}

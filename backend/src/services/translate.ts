import { config } from '../config.js';
import { chunk } from '../lib/concurrency.js';
import { fetchJson, qs } from '../lib/http.js';
import { cleanCompletion } from '../lib/llmText.js';
import { cleanText, isMostlyNonLatin } from '../lib/sanitize.js';
import type { RawPlace } from '../types.js';

/**
 * Gives every place a readable Latin-script name.
 *
 * Places mapped only in Chinese/Arabic/Cyrillic are otherwise unusable in the
 * export: the folder name is unreadable, the PDF core fonts cannot draw the
 * glyphs (so the text is stripped to punctuation), and the write-up model has
 * no handle on the subject. Resolution order, cheapest and surest first:
 *
 *   1. OSM English tags        (handled upstream in overpass.ts)
 *   2. Wikidata English label  — authoritative, free, batched
 *   3. LLM translation         — for the long tail with no linked data
 */

const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';

async function englishLabelsFromWikidata(qids: string[]): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  if (qids.length === 0) return labels;

  for (const batch of chunk([...new Set(qids)], 45)) {
    const url = `${WIKIDATA_API}?${qs({
      action: 'wbgetentities',
      format: 'json',
      props: 'labels|aliases',
      languages: 'en',
      ids: batch.join('|'),
      origin: '*',
    })}`;

    try {
      const payload = await fetchJson<{
        entities?: Record<string, {
          labels?: { en?: { value?: string } };
          aliases?: { en?: Array<{ value?: string }> };
        }>;
      }>(url, { timeoutMs: 25_000, retries: 1 });

      for (const [qid, entity] of Object.entries(payload.entities ?? {})) {
        const label = entity.labels?.en?.value
          ?? entity.aliases?.en?.find((alias) => alias.value)?.value;
        const cleaned = cleanText(label, 160);
        // A "label" that is itself CJK is no better than what we started with.
        if (cleaned && !isMostlyNonLatin(cleaned)) labels.set(qid, cleaned);
      }
    } catch {
      // Fall through to the LLM for this batch.
    }
  }

  return labels;
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

/**
 * Models often answer "原名 - English Name" instead of the translation alone.
 * Keep only the Latin side; the original is already stored as `name:local`.
 */
function stripEchoedOriginal(value: string): string {
  if (!/[㐀-鿿豈-﫿]/.test(value)) return value;

  const parts = value
    .split(/\s*[-–—:：|/(){}[\]]\s*/)
    .map((part) => part.trim())
    .filter(Boolean);

  // The longest fragment carrying no CJK is the English name.
  const latin = parts
    .filter((part) => !/[㐀-鿿豈-﫿]/.test(part))
    .sort((a, b) => b.length - a.length)[0];

  return latin && latin.length >= 3 ? latin : '';
}

/**
 * One batched call: the model returns `index. English name` lines. Kept
 * deliberately rigid — small local models handle a numbered list far more
 * reliably than nested JSON.
 */
async function translateNamesWithLlm(
  entries: Array<{ index: number; name: string; hint: string }>,
): Promise<Map<number, string>> {
  const translated = new Map<number, string>();
  if (!config.llm.enabled || entries.length === 0) return translated;

  const list = entries
    .map((entry) => `${entry.index}. ${entry.name}  [${entry.hint}]`)
    .join('\n');

  // No worked example is given on purpose: small models copy the example's
  // answer onto entries they find hard, silently mislabelling places.
  const prompt = `Translate each place name below into English.

Rules:
- Output exactly one line per entry, in the form: <number>. <English name>
- Translate every entry. Translate the meaning of the name; use the place's
  established English name when it has one.
- Do not transliterate into pinyin when the name has a clear meaning.
- Each entry gets its own distinct translation. Never repeat a translation and
  never carry an answer over from another entry.
- No quotes, no explanations, no extra lines.
- The text in [brackets] is the kind of place, for context only — do not translate it.

${list}`;

  try {
    const response = await fetchJson<ChatResponse>(`${config.llm.baseUrl}/chat/completions`, {
      method: 'POST',
      // Translation is short output but a small CPU model still needs room, and
      // a timeout here silently leaves place names unreadable — so allow a retry.
      timeoutMs: Math.max(config.llm.timeoutMs, 120_000),
      retries: 1,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.llm.apiKey}`,
      },
      body: JSON.stringify({
        model: config.llm.model,
        temperature: 0,
        messages: [
          { role: 'system', content: 'You translate place names into English. You reply with nothing but the numbered list.' },
          { role: 'user', content: prompt },
        ],
      }),
    });

    // Qwen3 and friends answer with a <think> block first; its lines would be
    // read as numbered translations.
    const raw = cleanCompletion(response.choices?.[0]?.message?.content ?? '');
    const seen = new Map<string, number>();

    for (const line of raw.split('\n')) {
      const match = /^\s*(\d+)\s*[.)]\s*(.+?)\s*$/.exec(line);
      if (!match) continue;
      const index = Number(match[1]);
      if (!entries.some((entry) => entry.index === index)) continue;

      const name = stripEchoedOriginal(cleanText(match[2]!.replace(/^["'`]|["'`]$/g, ''), 160));
      // Reject echoes of the original and anything still unreadable.
      if (!name || isMostlyNonLatin(name) || /[㐀-鿿豈-﫿]/.test(name)) continue;

      // A repeated translation means the model copied one answer onto another
      // entry; drop both rather than mislabel a place.
      const key = name.toLowerCase();
      const earlier = seen.get(key);
      if (earlier !== undefined) {
        translated.delete(earlier);
        continue;
      }
      seen.set(key, index);
      translated.set(index, name);
    }
  } catch {
    // Untranslated names simply keep their original form.
  }

  return translated;
}

/**
 * Rewrites `place.name` to English wherever the mapped name is non-Latin,
 * preserving the original in `tags['name:local']`. Mutates in place and
 * returns how many names were changed.
 */
export async function applyEnglishNames(places: RawPlace[]): Promise<{ translated: number; note?: string }> {
  const needing = places.filter((place) => isMostlyNonLatin(place.name));
  if (needing.length === 0) return { translated: 0 };

  let translated = 0;

  const rename = (place: RawPlace, english: string): void => {
    if (!place.tags['name:local']) place.tags['name:local'] = place.name;
    place.name = english;
    place.tags['name:en'] = english;
    translated += 1;
  };

  // --- Wikidata labels ----------------------------------------------------
  const qidByPlace = new Map<string, string>();
  for (const place of needing) {
    const qid = place.tags.wikidata?.trim();
    if (qid && /^Q\d+$/.test(qid)) qidByPlace.set(place.id, qid);
  }

  const labels = await englishLabelsFromWikidata([...qidByPlace.values()]);
  const stillNeeding: RawPlace[] = [];
  for (const place of needing) {
    const qid = qidByPlace.get(place.id);
    const label = qid ? labels.get(qid) : undefined;
    if (label) rename(place, label);
    else stillNeeding.push(place);
  }

  // --- LLM translation for the rest --------------------------------------
  // Small batches on purpose: one 20-name request against a 1.5B CPU model
  // exceeded the timeout and cost every name in it. Ten keeps each call short,
  // and a failure now loses far less.
  if (stillNeeding.length > 0 && config.llm.enabled) {
    for (const batch of chunk(stillNeeding, 10)) {
      const entries = batch.map((place, offset) => ({
        index: offset + 1,
        name: place.name,
        hint: place.categoryLabel,
      }));
      const results = await translateNamesWithLlm(entries);
      for (const [index, english] of results) {
        const place = batch[index - 1];
        if (place && isMostlyNonLatin(place.name)) rename(place, english);
      }
    }
  }

  const remaining = needing.length - translated;
  return {
    translated,
    note: translated > 0
      ? `Translated ${translated} non-English place name(s) into English`
        + (remaining > 0 ? `; ${remaining} had no English form available.` : '.')
      : undefined,
  };
}

import { config } from '../config.js';
import { informationScore } from './overpass.js';
import { cosine, embedAll, type Vector } from './embeddings.js';
import type { RawPlace } from '../types.js';

/**
 * Second dedupe pass, after exact-name matching has done what it can.
 *
 * Exact matching cannot see that these are one place:
 *   廉政文化主题公园  /  廉政主题文化公园      (two characters transposed)
 *   People's Park     /  Renmin Park          (translated vs transliterated)
 *   Great Wall        /  The Great Wall       (article added)
 *
 * A multilingual embedding model can. Only places already judged to be in the
 * same locality are compared, and only above a high similarity threshold, so
 * genuinely different places are not merged.
 */

export interface SemanticDedupeResult {
  places: RawPlace[];
  merged: number;
  note?: string;
}

/** Same guard as the exact pass: chains legitimately repeat their names. */
function chainLike(place: RawPlace): boolean {
  return Boolean(place.tags.brand || place.tags['brand:wikidata'] || place.tags.operator);
}

/** What we embed: the name plus its category, so "X Park" ≠ "X Hotel". */
function embedText(place: RawPlace): string {
  const local = place.tags['name:local'];
  const names = local && local !== place.name ? `${place.name} / ${local}` : place.name;
  return `${names} (${place.categoryLabel})`;
}

export async function semanticDedupe(places: RawPlace[]): Promise<SemanticDedupeResult> {
  if (!config.embeddings.enabled || places.length < 2) {
    return { places, merged: 0 };
  }

  const vectors = await embedAll(places.map(embedText));
  if (vectors.every((vector) => vector === null)) return { places, merged: 0 };

  const threshold = config.embeddings.duplicateThreshold;
  const kept: Array<{ place: RawPlace; vector: Vector | null }> = [];
  const examples: string[] = [];
  let merged = 0;

  for (const place of places) {
    const vector = vectors[places.indexOf(place)] ?? null;

    if (!vector || chainLike(place)) {
      kept.push({ place, vector });
      continue;
    }

    const twinIndex = kept.findIndex((entry) => (
      entry.vector
      && !chainLike(entry.place)
      && cosine(entry.vector, vector) >= threshold
    ));

    if (twinIndex === -1) {
      kept.push({ place, vector });
      continue;
    }

    const existing = kept[twinIndex]!.place;
    if (examples.length < 3) examples.push(`"${existing.name}" ≈ "${place.name}"`);
    merged += 1;

    // Keep the better-described record, but never lose the other's tags.
    if (informationScore(place) > informationScore(existing)) {
      kept[twinIndex] = {
        place: { ...place, tags: { ...existing.tags, ...place.tags } },
        vector,
      };
    } else {
      kept[twinIndex]!.place = { ...existing, tags: { ...place.tags, ...existing.tags } };
    }
  }

  return {
    places: kept.map((entry) => entry.place),
    merged,
    note: merged > 0
      ? `Merged ${merged} near-duplicate place name(s) using local embeddings (${examples.join(', ')}).`
      : undefined,
  };
}

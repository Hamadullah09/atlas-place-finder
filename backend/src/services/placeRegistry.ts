import type { RawPlace } from '../types.js';
import { distanceMeters } from './overpass.js';

/**
 * The places a batch has already exported, and the test for whether a new
 * search result is one of them.
 *
 * A batch searches overlapping areas -- a province and the cities in it -- and
 * the same output folder is often run again with another term. Comparing ids
 * alone missed a place found through another source: OpenStreetMap calls a
 * museum node/123, Wikidata calls it wikidata/Q456, and both were exported. So
 * a place repeats an earlier one when any of these agree:
 *
 *   - the same id;
 *   - the same Wikidata item;
 *   - the same name, in any language the map gives, within SAME_PLACE_METRES.
 *
 * A shared name alone is not enough: every town has a "Town Hall".
 */

/** Further apart than this, two places with one name are two places. */
export const SAME_PLACE_METRES = 300;

export interface RegistryEntry {
  id: string;
  wikidata?: string;
  /** Normalised names, see nameKey. */
  names: string[];
  lat?: number;
  lon?: number;
  /** Folder the place was exported to, for the note that skips it later. */
  where?: string;
}

/** Lowercased, accents and punctuation gone: "Raekoja plats" = "RAEKOJA-PLATS". */
export function nameKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

const NAME_TAGS = ['name', 'name:en', 'name:local', 'int_name', 'official_name', 'alt_name', 'old_name'];

/** Every name the place is known by, normalised. */
function namesOf(place: RawPlace): string[] {
  const raw = [place.name, ...NAME_TAGS.flatMap((tag) => (place.tags[tag] ?? '').split(';'))];
  // Very short keys ("A", "13") say nothing about which place it is.
  return [...new Set(raw.map(nameKey).filter((key) => key.length >= 3))];
}

function wikidataOf(place: RawPlace): string | undefined {
  const qid = place.tags.wikidata?.trim();
  return qid && /^Q\d+$/.test(qid) ? qid : undefined;
}

export function entryFor(place: RawPlace, where?: string): RegistryEntry {
  return {
    id: place.id,
    wikidata: wikidataOf(place),
    names: namesOf(place),
    lat: Number.isFinite(place.lat) ? place.lat : undefined,
    lon: Number.isFinite(place.lon) ? place.lon : undefined,
    where,
  };
}

export class PlaceRegistry {
  private readonly entries: RegistryEntry[] = [];
  private readonly byId = new Map<string, RegistryEntry>();
  private readonly byWikidata = new Map<string, RegistryEntry>();
  private readonly byName = new Map<string, RegistryEntry[]>();

  static from(entries: RegistryEntry[]): PlaceRegistry {
    const registry = new PlaceRegistry();
    for (const entry of entries) registry.addEntry(entry);
    return registry;
  }

  get size(): number {
    return this.entries.length;
  }

  add(place: RawPlace, where?: string): void {
    this.addEntry(entryFor(place, where));
  }

  addEntry(entry: RegistryEntry): void {
    if (!entry?.id || this.byId.has(entry.id)) return;
    const clean: RegistryEntry = { ...entry, names: Array.isArray(entry.names) ? entry.names : [] };
    this.entries.push(clean);
    this.byId.set(clean.id, clean);
    if (clean.wikidata) this.byWikidata.set(clean.wikidata, clean);
    for (const name of clean.names) {
      const bucket = this.byName.get(name);
      if (bucket) bucket.push(clean);
      else this.byName.set(name, [clean]);
    }
  }

  /** The earlier entry this place repeats, or undefined when it is new. */
  match(place: RawPlace): RegistryEntry | undefined {
    const byId = this.byId.get(place.id);
    if (byId) return byId;

    const qid = wikidataOf(place);
    if (qid) {
      const byWikidata = this.byWikidata.get(qid);
      if (byWikidata) return byWikidata;
    }

    if (!Number.isFinite(place.lat) || !Number.isFinite(place.lon)) return undefined;
    for (const name of namesOf(place)) {
      for (const entry of this.byName.get(name) ?? []) {
        // Two items that are known to be different stay different.
        if (qid && entry.wikidata && entry.wikidata !== qid) continue;
        if (entry.lat === undefined || entry.lon === undefined) continue;
        if (distanceMeters(place, { lat: entry.lat, lon: entry.lon }) <= SAME_PLACE_METRES) return entry;
      }
    }
    return undefined;
  }

  toJSON(): RegistryEntry[] {
    return this.entries;
  }
}

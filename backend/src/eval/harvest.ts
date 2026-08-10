import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveKeyword } from '../lib/taxonomy.js';
import { discoverViaNominatim, discoverViaWikidata } from '../services/discovery.js';
import { geocodeCity } from '../services/geocode.js';
import { dedupePlaces, informationScore, searchOverpass } from '../services/overpass.js';
import type { RawPlace } from '../types.js';

/**
 * Builds the fixture corpus the eval harness runs against.
 *
 * Records are captured BEFORE any LLM stage touches them, so prompt changes can
 * be compared against byte-identical input as many times as needed without
 * re-hitting Overpass (which is a shared community service, and slow).
 *
 *   npm run eval:harvest -- --out src/eval/fixtures/corpus.jsonl --target 800
 */

interface Target {
  city: string;
  country: string;
  /** Script family, so the report can break results down by writing system. */
  script: 'cjk' | 'arabic' | 'cyrillic' | 'latin' | 'indic';
}

/**
 * Deliberately weighted towards non-Latin scripts: that is where translation,
 * transliteration and PDF rendering actually break.
 */
const TARGETS: Target[] = [
  { city: 'Anshan', country: 'China', script: 'cjk' },
  { city: 'Baoding', country: 'China', script: 'cjk' },
  { city: 'Hefei', country: 'China', script: 'cjk' },
  { city: 'Kunming', country: 'China', script: 'cjk' },
  { city: 'Suzhou', country: 'China', script: 'cjk' },
  { city: 'Kyoto', country: 'Japan', script: 'cjk' },
  { city: 'Busan', country: 'South Korea', script: 'cjk' },
  { city: 'Cairo', country: 'Egypt', script: 'arabic' },
  { city: 'Isfahan', country: 'Iran', script: 'arabic' },
  { city: 'Lahore', country: 'Pakistan', script: 'arabic' },
  { city: 'Kazan', country: 'Russia', script: 'cyrillic' },
  { city: 'Belgrade', country: 'Serbia', script: 'cyrillic' },
  { city: 'Jaipur', country: 'India', script: 'indic' },
  { city: 'Chiang Mai', country: 'Thailand', script: 'indic' },
  { city: 'Porto', country: 'Portugal', script: 'latin' },
  { city: 'Krakow', country: 'Poland', script: 'latin' },
];

const KEYWORDS = ['tourist places', 'museums', 'historical sites'];

export interface CorpusRecord {
  city: string;
  country: string;
  script: Target['script'];
  keyword: string;
  place: RawPlace;
}

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

async function harvestOne(target: Target, keyword: string, perSearch: number): Promise<CorpusRecord[]> {
  const resolved = resolveKeyword(keyword);
  const area = await geocodeCity(target.city, target.country);

  const [overpass, wikidata, nominatim] = await Promise.all([
    searchOverpass(resolved, area, perSearch).then((r) => r.places).catch(() => [] as RawPlace[]),
    discoverViaWikidata(resolved, area, perSearch).catch(() => [] as RawPlace[]),
    discoverViaNominatim(keyword, area, perSearch).catch(() => [] as RawPlace[]),
  ]);

  // Exact dedupe only — the semantic pass is one of the things under test.
  const places = dedupePlaces([...overpass, ...wikidata, ...nominatim])
    .sort((a, b) => informationScore(b) - informationScore(a))
    .slice(0, perSearch);

  return places.map((place) => ({ ...target, keyword, place }));
}

async function main(): Promise<void> {
  const outPath = path.resolve(arg('out', 'src/eval/fixtures/corpus.jsonl'));
  const targetCount = Number(arg('target', '800'));
  const perSearch = Number(arg('per-search', '25'));

  const records: CorpusRecord[] = [];
  const failures: string[] = [];

  outer: for (const keyword of KEYWORDS) {
    for (const target of TARGETS) {
      if (records.length >= targetCount) break outer;
      try {
        const batch = await harvestOne(target, keyword, perSearch);
        records.push(...batch);
        console.log(
          `  ${target.city}/${keyword}: +${batch.length}  (total ${records.length}/${targetCount})`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${target.city}/${keyword}: ${message}`);
        console.log(`  ${target.city}/${keyword}: FAILED (${message})`);
      }
    }
  }

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

  const byScript = new Map<string, number>();
  for (const record of records) byScript.set(record.script, (byScript.get(record.script) ?? 0) + 1);

  console.log(`\nWrote ${records.length} records to ${outPath}`);
  console.log('by script:', [...byScript].map(([k, v]) => `${k}=${v}`).join(' '));
  if (failures.length > 0) console.log(`${failures.length} search(es) failed:\n  ${failures.join('\n  ')}`);
}

await main();

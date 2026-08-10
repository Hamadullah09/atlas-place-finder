import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { chunk } from '../lib/concurrency.js';
import { isMostlyNonLatin } from '../lib/sanitize.js';
import { embeddingsAvailable } from '../services/embeddings.js';
import { enrichPlaces } from '../services/llm.js';
import { semanticDedupe } from '../services/semanticDedupe.js';
import { applyEnglishNames } from '../services/translate.js';
import { generateWriteups } from '../services/writeup.js';
import type { Place, PlaceContent, RawPlace } from '../types.js';
import type { CorpusRecord } from './harvest.js';

/**
 * Scores each LLM stage against the fixture corpus with deterministic checks,
 * so prompt and schema changes can be judged on numbers instead of anecdotes.
 *
 *   npm run eval -- --limit 500
 *   npm run eval -- --stage translate --limit 1000
 *
 * Everything is measured without a human in the loop: no rubric model, no
 * subjective grading — only properties that are objectively right or wrong
 * (residual CJK in a name that was supposed to be translated, a write-up whose
 * JSON does not parse, an opening-hours claim with no source, and so on).
 */

const CJK = /[㐀-鿿豈-﫿]/;
const NON_LATIN_SCRIPT = /[Ѐ-ӿ؀-ۿऀ-ॿ฀-๿぀-ヿ가-힯]/;

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

function pct(part: number, whole: number): string {
  if (whole === 0) return '   n/a';
  return `${((part / whole) * 100).toFixed(1).padStart(5)}%`;
}

async function loadCorpus(file: string, limit: number): Promise<CorpusRecord[]> {
  const raw = await readFile(file, 'utf8');
  const records = raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as CorpusRecord);
  return records.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Stage 1 — name translation
// ---------------------------------------------------------------------------

interface TranslateReport {
  needing: number;
  translated: number;
  residualScript: number;
  echoedOriginal: number;
  suspiciouslyShort: number;
  collisions: number;
  elapsedMs: number;
  samples: string[];
}

async function evalTranslate(records: CorpusRecord[]): Promise<TranslateReport> {
  // Work on copies: applyEnglishNames mutates.
  const places: RawPlace[] = records.map((r) => ({ ...r.place, tags: { ...r.place.tags } }));
  const before = new Map(places.map((p) => [p.id, p.name]));
  const needing = places.filter((p) => isMostlyNonLatin(p.name)).length;

  const started = Date.now();
  await applyEnglishNames(places);
  const elapsedMs = Date.now() - started;

  let translated = 0;
  let residualScript = 0;
  let echoedOriginal = 0;
  let suspiciouslyShort = 0;
  const samples: string[] = [];
  const seen = new Map<string, string>();
  let collisions = 0;

  for (const place of places) {
    const original = before.get(place.id)!;
    if (!isMostlyNonLatin(original)) continue;

    if (place.name !== original) {
      translated += 1;
      if (samples.length < 6) samples.push(`${original} -> ${place.name}`);
      // The translation must not still carry the source script.
      if (CJK.test(place.name) || NON_LATIN_SCRIPT.test(place.name)) residualScript += 1;
      if (place.name.includes(original)) echoedOriginal += 1;
      if (place.name.replace(/[^A-Za-z]/g, '').length < 3) suspiciouslyShort += 1;

      const key = place.name.toLowerCase();
      const prior = seen.get(key);
      if (prior && prior !== original) collisions += 1;
      seen.set(key, original);
    }
  }

  return { needing, translated, residualScript, echoedOriginal, suspiciouslyShort, collisions, elapsedMs, samples };
}

// ---------------------------------------------------------------------------
// Stage 2 — filter / extraction schema
// ---------------------------------------------------------------------------

interface FilterReport {
  input: number;
  scored: number;
  dropped: number;
  llmProcessed: number;
  renamedToNonLatin: number;
  emptySummary: number;
  hoursInvented: number;
  elapsedMs: number;
  warnings: string[];
}

async function evalFilter(records: CorpusRecord[]): Promise<FilterReport> {
  const byCity = new Map<string, CorpusRecord[]>();
  for (const record of records) {
    const key = `${record.city}|${record.keyword}`;
    if (!byCity.has(key)) byCity.set(key, []);
    byCity.get(key)!.push(record);
  }

  let scored = 0;
  let dropped = 0;
  let llmProcessed = 0;
  let renamedToNonLatin = 0;
  let emptySummary = 0;
  let hoursInvented = 0;
  const warnings: string[] = [];
  const started = Date.now();

  for (const [key, group] of byCity) {
    const [city, keyword] = key.split('|');
    const places = group.map((r) => ({ ...r.place, tags: { ...r.place.tags } }));
    const outcome = await enrichPlaces(places, {
      keyword: keyword!,
      city: city!,
      country: group[0]!.country,
      useLlm: true,
    });
    warnings.push(...outcome.warnings);

    for (const entry of outcome.places) {
      scored += 1;
      if (!entry.keep) dropped += 1;
      if (entry.llmProcessed) llmProcessed += 1;
      if (!entry.summary.trim()) emptySummary += 1;

      const source = places.find((p) => p.id === entry.placeId);
      if (source && !isMostlyNonLatin(source.name) && isMostlyNonLatin(entry.name)) {
        renamedToNonLatin += 1;
      }
      // An opening-hours claim is only legitimate if the place has the tag.
      if (!source?.tags.opening_hours && /\b\d{1,2}[:.]\d{2}\b|\bopen(?:s|ing)?\b.*\b\d/i.test(entry.summary)) {
        hoursInvented += 1;
      }
    }
  }

  return {
    input: records.length,
    scored,
    dropped,
    llmProcessed,
    renamedToNonLatin,
    emptySummary,
    hoursInvented,
    elapsedMs: Date.now() - started,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Stage 3 — write-up schema and depth
// ---------------------------------------------------------------------------

interface WriteupReport {
  attempted: number;
  llmGenerated: number;
  fellBack: number;
  medianChars: number;
  sectionFill: Record<string, string>;
  emptyOverview: number;
  residualScript: number;
  redactions: number;
  elapsedMs: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

async function evalWriteup(records: CorpusRecord[], sampleSize: number): Promise<WriteupReport> {
  const sample = records.slice(0, sampleSize);
  const places: Place[] = sample.map((r) => ({
    ...r.place,
    tags: { ...r.place.tags },
    summary: '',
    contact: {},
    images: [],
    travelLinks: [],
    qualityScore: 50,
    llmProcessed: false,
    googleMapsUrl: 'https://maps.google.com/',
    osmUrl: `https://www.openstreetmap.org/${r.place.osmType}/${r.place.osmId}`,
  }));

  // Research is evaluated separately; here the model gets only OSM tags, which
  // is the hardest and most common case.
  const content = new Map<string, PlaceContent>();

  const started = Date.now();
  const outcome = await generateWriteups(places, content);
  const elapsedMs = Date.now() - started;

  const sections = ['history', 'architecture', 'context', 'visiting', 'practical'] as const;
  const filled: Record<string, number> = Object.fromEntries(sections.map((s) => [s, 0]));
  filled.highlights = 0;

  let llmGenerated = 0;
  let emptyOverview = 0;
  let residualScript = 0;
  let redactions = 0;
  const lengths: number[] = [];

  for (const place of places) {
    const writeup = outcome.writeups.get(place.id);
    if (!writeup) continue;
    if (writeup.llmGenerated) llmGenerated += 1;
    redactions += writeup.redactions.length;

    const all = [
      writeup.overview,
      writeup.history ?? '',
      writeup.architecture ?? '',
      writeup.context ?? '',
      writeup.visiting ?? '',
      writeup.practical ?? '',
      writeup.highlights.join(' '),
    ].join(' ');
    lengths.push(all.length);

    if (writeup.overview.trim().length < 40) emptyOverview += 1;
    if (CJK.test(all) || NON_LATIN_SCRIPT.test(all)) residualScript += 1;

    for (const section of sections) {
      if ((writeup[section] ?? '').trim().length > 20) filled[section] += 1;
    }
    if (writeup.highlights.length >= 3) filled.highlights += 1;
  }

  return {
    attempted: places.length,
    llmGenerated,
    fellBack: places.length - llmGenerated,
    medianChars: median(lengths),
    sectionFill: Object.fromEntries(
      Object.entries(filled).map(([key, value]) => [key, pct(value, places.length)]),
    ),
    emptyOverview,
    residualScript,
    redactions,
    elapsedMs,
  };
}

// ---------------------------------------------------------------------------
// Stage 4 — semantic dedupe
// ---------------------------------------------------------------------------

async function evalDedupe(records: CorpusRecord[]): Promise<{ groups: number; merged: number; notes: string[] }> {
  const byCity = new Map<string, RawPlace[]>();
  for (const record of records) {
    const key = `${record.city}|${record.keyword}`;
    if (!byCity.has(key)) byCity.set(key, []);
    byCity.get(key)!.push({ ...record.place, tags: { ...record.place.tags } });
  }

  let merged = 0;
  const notes: string[] = [];
  for (const places of byCity.values()) {
    const result = await semanticDedupe(places);
    merged += result.merged;
    if (result.note && notes.length < 5) notes.push(result.note);
  }
  return { groups: byCity.size, merged, notes };
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const file = path.resolve(arg('corpus', 'src/eval/fixtures/corpus.jsonl'));
  const limit = Number(arg('limit', '500'));
  const writeupSample = Number(arg('writeup-sample', '40'));
  const stage = arg('stage', 'all');
  const outPath = arg('report', '');

  const records = await loadCorpus(file, limit);
  const embeddings = await embeddingsAvailable();

  const header = [
    '='.repeat(72),
    'Place Finder — LLM evaluation',
    '='.repeat(72),
    `corpus      : ${file}`,
    `records     : ${records.length}`,
    `chat model  : ${config.llm.enabled ? config.llm.model : '(none)'} @ ${config.llm.baseUrl}`,
    `embeddings  : ${embeddings ? config.embeddings.model : '(unavailable)'}`,
    `batch size  : ${config.llm.batchSize}   timeout: ${config.llm.timeoutMs}ms`,
    '',
  ];
  const lines: string[] = [...header];
  const say = (line: string) => { lines.push(line); console.log(line); };
  header.forEach((line) => console.log(line));

  if (stage === 'all' || stage === 'translate') {
    const report = await evalTranslate(records);
    say('-- name translation ---------------------------------------------------');
    say(`needing translation : ${report.needing}`);
    say(`translated          : ${report.translated}  (${pct(report.translated, report.needing)} coverage)`);
    say(`residual script     : ${report.residualScript}  <- must be 0`);
    say(`echoed original     : ${report.echoedOriginal}  <- must be 0`);
    say(`too short / garbage : ${report.suspiciouslyShort}`);
    say(`name collisions     : ${report.collisions}`);
    say(`elapsed             : ${(report.elapsedMs / 1000).toFixed(1)}s`);
    report.samples.forEach((sample) => say(`   e.g. ${sample}`));
    say('');
  }

  if (stage === 'all' || stage === 'filter') {
    const report = await evalFilter(records);
    say('-- filter / extraction ------------------------------------------------');
    say(`scored              : ${report.scored} of ${report.input}`);
    say(`dropped by filter   : ${report.dropped}  (${pct(report.dropped, report.scored)})`);
    say(`handled by LLM      : ${report.llmProcessed}  (${pct(report.llmProcessed, report.scored)})`);
    say(`empty summary       : ${report.emptySummary}  (${pct(report.emptySummary, report.scored)})`);
    say(`renamed to non-Latin: ${report.renamedToNonLatin}  <- must be 0`);
    say(`hours w/o source    : ${report.hoursInvented}  <- must be 0`);
    say(`elapsed             : ${(report.elapsedMs / 1000).toFixed(1)}s`);
    const unique = [...new Set(report.warnings)].slice(0, 5);
    unique.forEach((warning) => say(`   warn: ${warning}`));
    say('');
  }

  if (stage === 'all' || stage === 'writeup') {
    const report = await evalWriteup(records, writeupSample);
    say('-- write-up schema & depth --------------------------------------------');
    say(`sampled             : ${report.attempted}`);
    say(`model produced JSON : ${report.llmGenerated}  (${pct(report.llmGenerated, report.attempted)})`);
    say(`fell back to sources: ${report.fellBack}`);
    say(`median article chars: ${report.medianChars}`);
    say(`thin overview       : ${report.emptyOverview}`);
    say(`residual script     : ${report.residualScript}  <- must be 0 (English only)`);
    say(`hours redacted      : ${report.redactions}`);
    say(`elapsed             : ${(report.elapsedMs / 1000).toFixed(1)}s`);
    say('section fill rate:');
    for (const [section, rate] of Object.entries(report.sectionFill)) say(`   ${section.padEnd(14)}${rate}`);
    say('');
  }

  if ((stage === 'all' || stage === 'dedupe') && embeddings) {
    const report = await evalDedupe(records);
    say('-- semantic dedupe ----------------------------------------------------');
    say(`groups              : ${report.groups}`);
    say(`near-duplicates hit : ${report.merged}`);
    report.notes.forEach((note) => say(`   ${note}`));
    say('');
  }

  if (outPath) {
    await mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
    await writeFile(path.resolve(outPath), lines.join('\n'), 'utf8');
    console.log(`report written to ${outPath}`);
  }
}

await main();

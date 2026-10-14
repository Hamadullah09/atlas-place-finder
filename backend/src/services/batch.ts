import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { isCancellation, runCancellable } from '../lib/cancel.js';
import { confirmConnectivity, isOffline } from '../lib/connectivity.js';
import type { BatchTarget } from '../lib/csv.js';
import { sanitizePathSegment } from '../lib/sanitize.js';
import { writePlacesFolder } from './archive.js';
import { fetchExtraSources, type ExtraSourceDoc } from './extraSources.js';
import { crawlTourismSource } from './siteCrawl.js';
import { PlaceRegistry, type RegistryEntry } from './placeRegistry.js';
import { createProgress, type SearchProgress } from './progress.js';
import { runSearch } from './search.js';

/**
 * Sequential batch runner: one CSV upload becomes one job that works through
 * every city/province, searching and writing each region's places as plain
 * folders into the user-chosen folder. Regions run strictly one at a time — Overpass, Nominatim
 * and a local LLM all punish parallelism.
 */

export type BatchRowStatus = 'pending' | 'searching' | 'exporting' | 'done' | 'skipped' | 'failed';

export interface BatchRow {
  country: string;
  region: string;
  kind: 'city' | 'province';
  status: BatchRowStatus;
  /** Per-row cap from the CSV, when the sheet supplied one. */
  limit?: number;
  placeCount?: number;
  /** Matches left out because they were already exported, in this run or an earlier one. */
  duplicatesSkipped?: number;
  /** Folder the region's places were written into. */
  outputPath?: string;
  error?: string;
  /** Live stage while this row is in flight; cleared once it settles. */
  progress?: SearchProgress;
}

export type BatchJobStatus = 'running' | 'completed' | 'cancelled' | 'failed';

export interface BatchJob {
  id: string;
  status: BatchJobStatus;
  attribute: string;
  source: 'osm' | 'google';
  outputPath: string;
  extraSources: string[];
  rows: BatchRow[];
  /** Index of the row currently being processed. */
  currentIndex: number;
  /** Place ids already written in this run, so regions never duplicate work. */
  exportedPlaceIds: string[];
  notes: string[];
  /** True while the runner is parked waiting for the internet to return. */
  networkDown?: boolean;
  startedAt: string;
  finishedAt?: string;
}

export interface BatchJobInput {
  targets: BatchTarget[];
  attribute: string;
  outputPath: string;
  extraSources: string[];
  includeImages?: boolean;
  detailedWriteups?: boolean;
  /** Cap results per region; defaults to the server MAX_RESULTS. */
  limit?: number;
  /** Re-export regions whose folder is already finished instead of skipping them. */
  overwrite?: boolean;
  /** Fallback cap from a "Maximum search" column, for rows without one. */
  sheetMaxSearch?: number;
  /**
   * Allow a place to be exported again: under several regions, or when an
   * earlier run into the same folder already has it.
   */
  allowDuplicates?: boolean;
  /** Which engine runs the searches: open-source stack (default) or Google. */
  source?: 'osm' | 'google';
}

interface ActiveJob {
  job: BatchJob;
  /** Every place exported into this output folder, by this run or before it. */
  registry: PlaceRegistry;
  cancelRequested: boolean;
  /** Aborted by cancelBatchJob so the current row stops mid-flight. */
  controller: AbortController;
}

/** What each job was started with, so a retry can resume it. */
const lastInput = new Map<string, BatchJobInput>();

/** Single-user tool — one live job, and the last few kept for the UI. */
const jobs = new Map<string, ActiveJob>();
let runningJobId: string | null = null;

export function getBatchJob(id: string): BatchJob | null {
  return jobs.get(id)?.job ?? null;
}

export function getRunningBatchJob(): BatchJob | null {
  return runningJobId ? (jobs.get(runningJobId)?.job ?? null) : null;
}

/**
 * Puts failed regions back in the queue.
 *
 * Restarts the runner when the job has already finished, so a retry works
 * the same whether the run is still going or long since over.
 */
export function retryBatchRows(id: string, index?: number): number {
  const active = jobs.get(id);
  if (!active) return 0;

  const { job } = active;
  const targets = job.rows.filter((row, position) => (
    row.status === 'failed' && (index === undefined || position === index)
  ));
  if (targets.length === 0) return 0;

  for (const row of targets) {
    row.status = 'pending';
    row.error = undefined;
    row.progress = undefined;
  }
  job.notes.push(`Re-queued ${targets.length} region(s) for another attempt.`);

  if (job.status !== 'running') {
    const input = lastInput.get(id);
    if (input) {
      job.status = 'running';
      job.finishedAt = undefined;
      active.cancelRequested = false;
      active.controller = new AbortController();
      runningJobId = job.id;
      void runJob(active, input).catch(() => undefined);
    }
  }

  return targets.length;
}

export function cancelBatchJob(id: string): boolean {
  const active = jobs.get(id);
  if (!active || active.job.status !== 'running') return false;
  active.cancelRequested = true;
  // Without this the flag is only read between rows, so a cancel during a
  // large export waited for the whole city to finish.
  active.controller.abort();
  return true;
}

async function ensureWritableDirectory(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const info = await stat(dir);
  if (!info.isDirectory()) throw new Error(`${dir} exists but is not a directory`);
}

export async function startBatchJob(input: BatchJobInput): Promise<BatchJob> {
  if (runningJobId && jobs.get(runningJobId)?.job.status === 'running') {
    throw new Error('A batch job is already running. Cancel it or wait for it to finish.');
  }

  if (!path.isAbsolute(input.outputPath)) {
    throw new Error(`Save path must be absolute (got "${input.outputPath}").`);
  }
  await ensureWritableDirectory(input.outputPath);

  const job: BatchJob = {
    id: randomUUID(),
    status: 'running',
    attribute: input.attribute,
    source: input.source ?? 'osm',
    outputPath: input.outputPath,
    extraSources: input.extraSources,
    rows: input.targets.map((target) => ({ ...target, status: 'pending' as const })),
    currentIndex: -1,
    exportedPlaceIds: [],
    notes: [],
    startedAt: new Date().toISOString(),
  };

  // Everything already exported into this folder -- by an interrupted run of
  // this job, or by earlier runs with other search terms -- is skipped.
  const registry = await loadRegistry(input.outputPath);
  const previous = await loadState(input.outputPath);
  if (previous && previous.attribute === job.attribute) job.exportedPlaceIds = previous.exportedPlaceIds;
  // Folders written before the registry existed carry only ids; still worth matching on.
  for (const id of previous?.exportedPlaceIds ?? []) registry.addEntry({ id, names: [] });
  if (registry.size > 0 && !input.allowDuplicates) {
    job.notes.push(
      `${registry.size} place(s) are already exported in this folder and will not be searched for again.`,
    );
  }

  const active: ActiveJob = { job, registry, cancelRequested: false, controller: new AbortController() };
  jobs.set(job.id, active);
  lastInput.set(job.id, input);
  runningJobId = job.id;

  // Keep memory bounded: drop finished jobs beyond the last five.
  const finished = [...jobs.entries()].filter(([, a]) => a.job.status !== 'running');
  for (const [id] of finished.slice(0, Math.max(0, finished.length - 5))) jobs.delete(id);

  void runJob(active, input).catch((error) => {
    job.status = isCancellation(error) ? 'cancelled' : 'failed';
    job.finishedAt = new Date().toISOString();
    job.currentIndex = -1;
    if (!isCancellation(error)) {
      job.notes.push(`Job crashed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (runningJobId === job.id) runningJobId = null;
  });

  return job;
}

async function runJob(active: ActiveJob, input: BatchJobInput): Promise<void> {
  const { job } = active;

  let extraDocs: ExtraSourceDoc[] = [];
  if (input.extraSources.length > 0) {
    job.notes.push(`Fetching ${input.extraSources.length} additional source page(s)…`);
    const { docs, warnings } = await fetchExtraSources(input.extraSources);
    extraDocs = docs;
    job.notes.push(...warnings);
    if (docs.length > 0) {
      job.notes.push(`Using ${docs.length} additional source(s): ${docs.map((d) => d.label).join('; ')}`);
    }
  }

  const attributeSegment = sanitizePathSegment(job.attribute, 'places')
    .replace(/\s+/g, '-')
    .toLowerCase();

  // Attempts spent on a region because the link dropped, so a flapping
  // connection cannot keep one region in the queue for ever.
  const networkAttempts = new Map<number, number>();
  const MAX_NETWORK_ATTEMPTS = 3;

  for (let index = 0; index < job.rows.length; index += 1) {
    if (active.cancelRequested) {
      job.status = 'cancelled';
      break;
    }

    const row = job.rows[index]!;
    // Later passes only revisit what is still queued.
    if (row.status !== 'pending') continue;
    job.currentIndex = index;

    // Wait out an outage rather than failing every remaining region.
    if (isOffline()) {
      job.networkDown = true;
      while (isOffline() && !active.cancelRequested) {
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        await confirmConnectivity(true);
      }
      job.networkDown = false;
      if (active.cancelRequested) {
        job.status = 'cancelled';
        break;
      }
      job.notes.push(`Connection restored — resuming at ${row.region}.`);
    }

    const countryDir = sanitizePathSegment(row.country, 'Unknown Country');
    const regionDir = sanitizePathSegment(row.region, 'Unknown Region');
    const targetDir = path.join(job.outputPath, countryDir, regionDir);
    const placesDir = path.join(targetDir, attributeSegment);
    // README.txt is written last, so a folder that has one is a region that
    // finished. A crash or a power cut leaves a folder without it, and the
    // next pass rebuilds that region rather than mistaking it for done.
    if (!input.overwrite) {
      const finished = await stat(path.join(placesDir, 'README.txt')).catch(() => null);
      if (finished?.isFile()) {
        row.status = 'skipped';
        row.outputPath = placesDir;
        continue;
      }
    }

    try {
      row.status = 'searching';
      row.progress = createProgress();
      // Most specific wins: the CSV row, then the sheet, then the job, then
      // the server ceiling.
      const rowLimit = row.limit ?? input.sheetMaxSearch ?? input.limit ?? config.maxResults;
      const result = await runCancellable(active.controller.signal, () => runSearch(
        {
          keyword: job.attribute,
          city: row.region,
          country: row.country,
          limit: rowLimit,
          includeImages: input.includeImages !== false,
          source: input.source ?? 'osm',
        },
        {
          signal: active.controller.signal,
          progress: row.progress,
          // Province rows overlap the city rows beneath them, and a folder is
          // often run again with another term. Places already exported are
          // dropped inside the search, before their photos are looked up, so
          // new places fill this region's limit instead.
          exclude: input.allowDuplicates ? undefined : (place) => Boolean(active.registry.match(place)),
        },
      ));

      // The Google engine does not take the exclusion, and two results of one
      // search can still be one place under two ids; catch both here.
      const seenHere = new PlaceRegistry();
      const repeats: RegistryEntry[] = [];
      const fresh = input.allowDuplicates
        ? result.places
        : result.places.filter((place) => {
          const earlier = active.registry.match(place) ?? seenHere.match(place);
          if (earlier) {
            repeats.push(earlier);
            return false;
          }
          seenHere.add(place);
          return true;
        });
      const duplicates = (result.stats.alreadyExported ?? 0) + repeats.length;
      if (duplicates > 0) {
        row.duplicatesSkipped = duplicates;
        const where = repeats.find((entry) => entry.where)?.where;
        job.notes.push(
          `${row.region}: skipped ${duplicates} place(s) already exported${where ? ` (for example in ${where})` : ''}.`,
        );
      }

      row.placeCount = fresh.length;
      if (fresh.length === 0) {
        row.status = 'done';
        job.notes.push(
          duplicates > 0
            ? `${row.region}: every match was already exported elsewhere; nothing new to write.`
            : `${row.region}: no matching places found; nothing exported.`,
        );
        await saveState(job);
        continue;
      }

      if (active.cancelRequested) {
        job.status = 'cancelled';
        break;
      }

      // The country's own tourism site, read a few pages deep for this region.
      // It is the one source that knows the official name and the local detail
      // Wikipedia often lacks, so it is worth a handful of requests per region.
      let regionDocs = extraDocs;
      if (config.crawl.tourismSources) {
        const official = await runCancellable(active.controller.signal, () =>
          crawlTourismSource(result.area.countryCode, row.region),
        );
        if (official.docs.length > 0) {
          regionDocs = [...extraDocs, ...official.docs];
          job.notes.push(
            `${row.region}: read ${official.docs.length} page(s) from ${official.source?.organisation ?? 'the official tourism site'}.`,
          );
        } else if (official.source && official.warnings.length > 0) {
          job.notes.push(`${row.region}: ${official.warnings[0]}`);
        }
      }

      row.status = 'exporting';
      await ensureWritableDirectory(targetDir);

      const written = await runCancellable(active.controller.signal, () => writePlacesFolder(placesDir, {
        country: row.country,
        city: row.region,
        keyword: job.attribute,
        places: fresh,
        summarySource: { ...result, places: fresh },
        options: {
          includeImages: input.includeImages !== false,
          includeSummary: true,
          detailedWriteups: input.detailedWriteups !== false,
          extraDocs: regionDocs,
          signal: active.controller.signal,
          progress: row.progress,
        },
      // The Country/Region folders are already in this path.
      }, { nest: false }));

      // Only what reached the folder: a place left out for want of a photo was
      // not exported, and must not be skipped as if it had been.
      const exported = new Set(written.exportedIds);
      const where = path.relative(job.outputPath, placesDir) || '.';
      for (const place of fresh) {
        if (!exported.has(place.id)) continue;
        active.registry.add(place, where);
        job.exportedPlaceIds.push(place.id);
      }
      row.status = 'done';
      row.outputPath = written.path;
      row.progress = undefined;
      await saveState(job);
      await saveRegistry(job.outputPath, active.registry);
    } catch (error) {
      if (active.cancelRequested || isCancellation(error)) {
        row.status = 'pending';
        job.status = 'cancelled';
        job.notes.push(`${row.region}, ${row.country}: stopped part-way; nothing was written.`);
        break;
      }

      // Lost the link part-way: leave the region queued and try it again
      // on the next pass rather than recording a failure that never was.
      if (isOffline()) {
        const spent = (networkAttempts.get(index) ?? 0) + 1;
        networkAttempts.set(index, spent);

        if (spent <= MAX_NETWORK_ATTEMPTS) {
          row.status = 'pending';
          row.progress = undefined;
          job.notes.push(
            `${row.region}, ${row.country}: interrupted by the connection dropping; still queued.`,
          );
          index -= 1;
          continue;
        }

        job.notes.push(
          `${row.region}, ${row.country}: gave up after ${MAX_NETWORK_ATTEMPTS} attempts on an unstable connection.`,
        );
      }

      row.status = 'failed';
      row.error = error instanceof Error ? error.message : String(error);
      job.notes.push(`${row.region}, ${row.country}: ${row.error}`);
    }
  }

  // A retry pressed while this pass was running leaves rows queued behind
  // the cursor; sweep again rather than making the operator start a job.
  if (job.status === 'running' && job.rows.some((entry) => entry.status === 'pending')) {
    return runJob(active, input);
  }

  if (job.status === 'running') job.status = 'completed';
  job.finishedAt = new Date().toISOString();
  job.currentIndex = -1;
  if (runningJobId === job.id) runningJobId = null;

  await saveState(job).catch(() => undefined);
  await writeReport(job).catch(() => undefined);
}

const STATE_FILE = '_batch-state.json';

/**
 * Every place exported into this folder, with enough to recognise it again
 * under another id or name. Kept beside the exports so it travels with them,
 * and read by every batch that writes into the same folder.
 */
const REGISTRY_FILE = '_batch-places.json';

interface PersistedRegistry {
  version: 1;
  updatedAt: string;
  places: RegistryEntry[];
}

async function loadRegistry(outputPath: string): Promise<PlaceRegistry> {
  try {
    const parsed = JSON.parse(await readFile(path.join(outputPath, REGISTRY_FILE), 'utf8')) as PersistedRegistry;
    return PlaceRegistry.from(Array.isArray(parsed.places) ? parsed.places : []);
  } catch {
    return new PlaceRegistry();
  }
}

/** Written to a temporary name and renamed, so a crash never leaves half a file. */
async function saveRegistry(outputPath: string, registry: PlaceRegistry): Promise<void> {
  const state: PersistedRegistry = { version: 1, updatedAt: new Date().toISOString(), places: registry.toJSON() };
  const target = path.join(outputPath, REGISTRY_FILE);
  const temporary = `${target}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(state), 'utf8');
    await rename(temporary, target);
  } catch {
    // Losing the registry costs a duplicate later, never an export now.
  }
}

interface PersistedState {
  attribute: string;
  exportedPlaceIds: string[];
  updatedAt: string;
}

/**
 * Progress is flushed to disk after every region so that closing the app,
 * a crash, or a power cut costs at most the region in flight.
 */
async function saveState(job: BatchJob): Promise<void> {
  const state: PersistedState = {
    attribute: job.attribute,
    exportedPlaceIds: job.exportedPlaceIds,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(path.join(job.outputPath, STATE_FILE), JSON.stringify(state), 'utf8')
    .catch(() => undefined);
}

async function loadState(outputPath: string): Promise<PersistedState | null> {
  try {
    const raw = await readFile(path.join(outputPath, STATE_FILE), 'utf8');
    const parsed = JSON.parse(raw) as PersistedState;
    if (!Array.isArray(parsed.exportedPlaceIds)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Plain-text run report dropped next to the exports for later reference. */
async function writeReport(job: BatchJob): Promise<void> {
  const lines = [
    'SMA Place Finder batch report',
    '=========================',
    '',
    `Attribute   : ${job.attribute}`,
    `Engine      : ${job.source === 'google' ? 'Google Maps' : 'Open source (OSM/Wikimedia)'}`,
    `Started     : ${job.startedAt}`,
    `Finished    : ${job.finishedAt ?? ''}`,
    `Status      : ${job.status}`,
    '',
    ...job.rows.map((row) => {
      const detail = row.error
        ?? (row.status === 'skipped'
          ? 'already exported'
          : `${row.placeCount ?? 0} place(s)`
            + (row.duplicatesSkipped ? `, ${row.duplicatesSkipped} duplicate(s) skipped` : ''));
      return `${row.status.padEnd(9)} ${row.region}, ${row.country} — ${detail}`;
    }),
    '',
    `Unique places exported: ${job.exportedPlaceIds.length}`,
  ];
  if (job.notes.length > 0) lines.push('', 'Notes', '-----', ...job.notes.map((note) => `- ${note}`));
  lines.push('');

  await writeFile(path.join(job.outputPath, '_batch-report.txt'), lines.join('\n'), 'utf8');
}

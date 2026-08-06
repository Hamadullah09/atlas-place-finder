import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import type { BatchTarget } from '../lib/csv.js';
import { sanitizePathSegment } from '../lib/sanitize.js';
import { streamPlacesArchive } from './archive.js';
import { fetchExtraSources, type ExtraSourceDoc } from './extraSources.js';
import { runSearch } from './search.js';

/**
 * Sequential batch runner: one CSV upload becomes one job that works through
 * every city/province, searching and exporting a ZIP per region into the
 * user-chosen folder. Regions run strictly one at a time — Overpass, Nominatim
 * and a local LLM all punish parallelism.
 */

export type BatchRowStatus = 'pending' | 'searching' | 'exporting' | 'done' | 'skipped' | 'failed';

export interface BatchRow {
  country: string;
  region: string;
  kind: 'city' | 'province';
  status: BatchRowStatus;
  placeCount?: number;
  /** Matches dropped because another region in this run already exported them. */
  duplicatesSkipped?: number;
  zipPath?: string;
  error?: string;
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
  /** Re-export regions whose ZIP already exists instead of skipping them. */
  overwrite?: boolean;
  /** Allow the same place to be exported under several regions. */
  allowDuplicates?: boolean;
  /** Which engine runs the searches: open-source stack (default) or Google. */
  source?: 'osm' | 'google';
}

interface ActiveJob {
  job: BatchJob;
  cancelRequested: boolean;
}

/** Single-user tool — one live job, and the last few kept for the UI. */
const jobs = new Map<string, ActiveJob>();
let runningJobId: string | null = null;

export function getBatchJob(id: string): BatchJob | null {
  return jobs.get(id)?.job ?? null;
}

export function getRunningBatchJob(): BatchJob | null {
  return runningJobId ? (jobs.get(runningJobId)?.job ?? null) : null;
}

export function cancelBatchJob(id: string): boolean {
  const active = jobs.get(id);
  if (!active || active.job.status !== 'running') return false;
  active.cancelRequested = true;
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

  // Pick up where an interrupted run left off: the place ids it had already
  // written stay claimed, so resuming does not re-export them.
  const previous = await loadState(input.outputPath);
  if (previous && previous.attribute === job.attribute) {
    job.exportedPlaceIds = previous.exportedPlaceIds;
    if (previous.exportedPlaceIds.length > 0) {
      job.notes.push(
        `Resuming: ${previous.exportedPlaceIds.length} place(s) from an earlier run are already exported and will be skipped.`,
      );
    }
  }

  const active: ActiveJob = { job, cancelRequested: false };
  jobs.set(job.id, active);
  runningJobId = job.id;

  // Keep memory bounded: drop finished jobs beyond the last five.
  const finished = [...jobs.entries()].filter(([, a]) => a.job.status !== 'running');
  for (const [id] of finished.slice(0, Math.max(0, finished.length - 5))) jobs.delete(id);

  void runJob(active, input).catch((error) => {
    job.status = 'failed';
    job.finishedAt = new Date().toISOString();
    job.notes.push(`Job crashed: ${error instanceof Error ? error.message : String(error)}`);
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

  for (let index = 0; index < job.rows.length; index += 1) {
    if (active.cancelRequested) {
      job.status = 'cancelled';
      break;
    }

    const row = job.rows[index]!;
    job.currentIndex = index;

    const countryDir = sanitizePathSegment(row.country, 'Unknown Country');
    const regionDir = sanitizePathSegment(row.region, 'Unknown Region');
    const targetDir = path.join(job.outputPath, countryDir, regionDir);
    const zipPath = path.join(targetDir, `${attributeSegment}.zip`);
    // Built under a temporary name so a half-written archive left by a crash
    // or a power cut can never be mistaken for a finished one on resume.
    const partPath = `${zipPath}.part`;

    if (!input.overwrite) {
      const existing = await stat(zipPath).catch(() => null);
      if (existing?.isFile() && existing.size > 0) {
        row.status = 'skipped';
        row.zipPath = zipPath;
        continue;
      }
    }

    // Discard any leftover partial archive for this region before rebuilding.
    await rm(partPath, { force: true }).catch(() => undefined);

    try {
      row.status = 'searching';
      const result = await runSearch({
        keyword: job.attribute,
        city: row.region,
        country: row.country,
        limit: input.limit ?? config.maxResults,
        includeImages: input.includeImages !== false,
        source: input.source ?? 'osm',
      });

      // Province rows overlap the city rows beneath them, so the same place is
      // otherwise exported (and researched, and photographed) several times.
      const fresh = input.allowDuplicates
        ? result.places
        : result.places.filter((place) => !job.exportedPlaceIds.includes(place.id));
      const duplicates = result.places.length - fresh.length;
      if (duplicates > 0) {
        row.duplicatesSkipped = duplicates;
        job.notes.push(
          `${row.region}: skipped ${duplicates} place(s) already exported for another region in this run.`,
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

      row.status = 'exporting';
      await ensureWritableDirectory(targetDir);

      const out = createWriteStream(partPath);
      await streamPlacesArchive(out, {
        country: row.country,
        city: row.region,
        keyword: job.attribute,
        places: fresh,
        summarySource: { ...result, places: fresh },
        options: {
          includeImages: input.includeImages !== false,
          includeSummary: true,
          detailedWriteups: input.detailedWriteups !== false,
          extraDocs,
        },
      });

      // Only now is the archive complete — publish it under its real name.
      await rm(zipPath, { force: true }).catch(() => undefined);
      await rename(partPath, zipPath);

      job.exportedPlaceIds.push(...fresh.map((place) => place.id));
      row.status = 'done';
      row.zipPath = zipPath;
      await saveState(job);
    } catch (error) {
      await rm(partPath, { force: true }).catch(() => undefined);
      row.status = 'failed';
      row.error = error instanceof Error ? error.message : String(error);
      job.notes.push(`${row.region}, ${row.country}: ${row.error}`);
    }
  }

  if (job.status === 'running') job.status = 'completed';
  job.finishedAt = new Date().toISOString();
  job.currentIndex = -1;
  if (runningJobId === job.id) runningJobId = null;

  await saveState(job).catch(() => undefined);
  await writeReport(job).catch(() => undefined);
}

const STATE_FILE = '_batch-state.json';

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
    'Place Finder batch report',
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

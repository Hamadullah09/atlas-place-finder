import { randomUUID } from 'node:crypto';

/**
 * Live progress for an in-flight search.
 *
 * A search over a whole city now runs for minutes — translating names, filtering
 * every candidate and fetching imagery — and an indeterminate spinner for that
 * long is indistinguishable from a hang. Each stage reports itself here and the
 * UI polls, so the user can see what is happening and that it is still moving.
 */

export type SearchStage =
  | 'starting'
  | 'geocoding'
  | 'discovering'
  | 'naming'
  | 'filtering'
  | 'imagery'
  | 'done'
  | 'failed';

export interface SearchProgress {
  id: string;
  stage: SearchStage;
  /** Human-readable line for the current stage. */
  message: string;
  /** Completed units within the stage, when the stage has countable work. */
  done?: number;
  total?: number;
  startedAt: number;
  updatedAt: number;
  error?: string;
}

const STAGE_LABEL: Record<SearchStage, string> = {
  starting: 'Starting…',
  geocoding: 'Locating the city',
  discovering: 'Searching OpenStreetMap, Wikidata and Nominatim',
  naming: 'Translating place names into English',
  filtering: 'Checking each place is relevant',
  imagery: 'Finding photographs',
  done: 'Done',
  failed: 'Failed',
};

/** Only a handful are ever live; finished entries are reaped after a minute. */
const active = new Map<string, SearchProgress>();
const REAP_AFTER_MS = 60_000;

function reap(): void {
  const now = Date.now();
  for (const [id, entry] of active) {
    const finished = entry.stage === 'done' || entry.stage === 'failed';
    if (finished && now - entry.updatedAt > REAP_AFTER_MS) active.delete(id);
  }
}

/**
 * The client supplies the id so it can start polling immediately. Waiting for
 * the server to hand one back is not an option: Express does not flush headers
 * until the response ends, so the id would only arrive once the search was
 * already over.
 */
export function createProgress(id?: string): SearchProgress {
  reap();
  const now = Date.now();
  const entry: SearchProgress = {
    id: id && /^[A-Za-z0-9_-]{8,80}$/.test(id) ? id : randomUUID(),
    stage: 'starting',
    message: STAGE_LABEL.starting,
    startedAt: now,
    updatedAt: now,
  };
  active.set(entry.id, entry);
  return entry;
}

export function setStage(
  progress: SearchProgress | undefined,
  stage: SearchStage,
  detail?: { done?: number; total?: number; message?: string },
): void {
  if (!progress) return;
  progress.stage = stage;
  progress.message = detail?.message ?? STAGE_LABEL[stage];
  progress.done = detail?.done;
  progress.total = detail?.total;
  progress.updatedAt = Date.now();
}

export function failProgress(progress: SearchProgress | undefined, error: string): void {
  if (!progress) return;
  progress.stage = 'failed';
  progress.message = STAGE_LABEL.failed;
  progress.error = error;
  progress.updatedAt = Date.now();
}

export function getProgress(id: string): SearchProgress | null {
  return active.get(id) ?? null;
}

import type { CategorySuggestion, Place, SearchQuery, SearchResult } from './types';

export const API_BASE_URL = (
  process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000'
).replace(/\/+$/, '');

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function readError(response: Response): Promise<never> {
  let message = `${response.status} ${response.statusText}`;
  let details: unknown;
  try {
    const payload = (await response.json()) as { error?: string; details?: unknown };
    if (payload.error) message = payload.error;
    details = payload.details;
  } catch {
    // Non-JSON error body — keep the status line.
  }
  throw new ApiError(response.status, message, details);
}

export type SearchStage =
  | 'starting' | 'geocoding' | 'discovering' | 'naming'
  | 'filtering' | 'imagery' | 'done' | 'failed';

export interface SearchProgress {
  id: string;
  stage: SearchStage;
  message: string;
  done?: number;
  total?: number;
  startedAt: number;
  updatedAt: number;
  error?: string;
}

/**
 * Runs a search and reports progress while it is in flight.
 *
 * A whole-city search takes minutes, so the request returns a progress id in a
 * header and this polls it until the body arrives. `onProgress` is called with
 * each stage so the UI can show what the server is actually doing.
 */
export async function searchPlaces(
  query: SearchQuery & { refresh?: boolean },
  signal?: AbortSignal,
  onProgress?: (progress: SearchProgress) => void,
): Promise<SearchResult> {
  // Our own id, sent with the request, so polling can begin immediately.
  const progressId =
    globalThis.crypto?.randomUUID?.() ?? `s${Date.now()}${Math.floor(Math.random() * 1e6)}`;

  let poller: ReturnType<typeof setInterval> | undefined;
  if (onProgress) {
    poller = setInterval(() => {
      void fetch(`${API_BASE_URL}/api/search/progress/${progressId}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((p) => { if (p) onProgress(p as SearchProgress); })
        .catch(() => undefined);
    }, 1_200);
  }

  try {
    const response = await fetch(`${API_BASE_URL}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...query, progressId }),
      signal,
    });
    if (!response.ok) await readError(response);
    return (await response.json()) as SearchResult;
  } finally {
    if (poller) clearInterval(poller);
  }
}

export async function fetchCategories(signal?: AbortSignal): Promise<CategorySuggestion[]> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/categories`, { signal });
    if (!response.ok) return [];
    const payload = (await response.json()) as { categories?: CategorySuggestion[] };
    return payload.categories ?? [];
  } catch {
    return [];
  }
}

export interface DownloadRequest {
  searchId: string;
  /** Omit to download every place in the search. */
  placeIds?: string[];
  includeImages?: boolean;
  includeSummary?: boolean;
}

function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (utf8?.[1]) return decodeURIComponent(utf8[1]);
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain?.[1] ?? fallback;
}

/**
 * Streams the ZIP from the backend and hands it to the browser's downloader.
 * The whole archive is buffered in memory as a Blob — fine for the ~100-place
 * cap the API enforces.
 */
export async function downloadArchive(
  request: DownloadRequest,
  fallbackName = 'places.zip',
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(`${API_BASE_URL}/api/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  });

  if (!response.ok) await readError(response);

  const blob = await response.blob();
  const filename = filenameFromDisposition(
    response.headers.get('content-disposition'),
    fallbackName,
  );

  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoke on the next tick so Safari has time to start the download.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 2_000);

  return filename;
}

// ---------------------------------------------------------------------------
// Batch (CSV) automation
// ---------------------------------------------------------------------------

export interface BatchPreview {
  targets: Array<{ country: string; region: string; kind: 'city' | 'province' }>;
  attribute?: string;
  outputPath?: string;
  sourceLinks: string[];
  warnings: string[];
}

export type BatchRowStatus = 'pending' | 'searching' | 'exporting' | 'done' | 'skipped' | 'failed';

export interface BatchRow {
  country: string;
  region: string;
  kind: 'city' | 'province';
  status: BatchRowStatus;
  placeCount?: number;
  /** Matches dropped because another region already exported them. */
  duplicatesSkipped?: number;
  zipPath?: string;
  error?: string;
}

export interface BatchJob {
  id: string;
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  attribute: string;
  outputPath: string;
  extraSources: string[];
  rows: BatchRow[];
  currentIndex: number;
  exportedPlaceIds: string[];
  notes: string[];
  startedAt: string;
  finishedAt?: string;
}

export interface StartBatchRequest {
  csv: string;
  attribute: string;
  outputPath: string;
  extraSources?: string;
  includeImages?: boolean;
  detailedWriteups?: boolean;
  limit?: number;
  overwrite?: boolean;
  allowDuplicates?: boolean;
  source?: 'osm' | 'google';
}

export interface EngineInfo {
  /** Which engines this install offers. */
  mode: 'both' | 'osm' | 'google';
  googleConfigured: boolean;
  /** Maps JS key served at runtime by Google-enabled installs, else null. */
  mapsBrowserKey?: string | null;
}

const DEFAULT_ENGINE_INFO: EngineInfo = { mode: 'both', googleConfigured: false, mapsBrowserKey: null };

export async function fetchEngineInfo(signal?: AbortSignal): Promise<EngineInfo> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/health`, { signal });
    if (!response.ok) return DEFAULT_ENGINE_INFO;
    const payload = (await response.json()) as { engines?: EngineInfo };
    return payload.engines ?? DEFAULT_ENGINE_INFO;
  } catch {
    return DEFAULT_ENGINE_INFO;
  }
}

export async function previewBatchCsv(csv: string, signal?: AbortSignal): Promise<BatchPreview> {
  const response = await fetch(`${API_BASE_URL}/api/batch/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ csv }),
    signal,
  });
  if (!response.ok) await readError(response);
  return (await response.json()) as BatchPreview;
}

export async function startBatch(request: StartBatchRequest, signal?: AbortSignal): Promise<BatchJob> {
  const response = await fetch(`${API_BASE_URL}/api/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  });
  if (!response.ok) await readError(response);
  const payload = (await response.json()) as { job: BatchJob };
  return payload.job;
}

export async function fetchBatchJob(jobId: string, signal?: AbortSignal): Promise<BatchJob | null> {
  const response = await fetch(`${API_BASE_URL}/api/batch/${encodeURIComponent(jobId)}`, { signal });
  if (response.status === 404) return null;
  if (!response.ok) await readError(response);
  const payload = (await response.json()) as { job: BatchJob };
  return payload.job;
}

export async function fetchRunningBatchJob(signal?: AbortSignal): Promise<BatchJob | null> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/batch/current`, { signal });
    if (!response.ok) return null;
    const payload = (await response.json()) as { job: BatchJob | null };
    return payload.job;
  } catch {
    return null;
  }
}

/**
 * Opens a native folder-picker on the machine running the backend (the same
 * computer as the browser, since this app is self-hosted). The dialog can sit
 * open for minutes, so the request starts it and then polls for the result.
 * Resolves to null when the user cancels.
 */
export async function browseFolder(signal?: AbortSignal): Promise<string | null> {
  const start = await fetch(`${API_BASE_URL}/api/browse-folder`, { method: 'POST', signal });
  if (!start.ok) await readError(start);

  while (!signal?.aborted) {
    await new Promise((resolve) => setTimeout(resolve, 700));

    const poll = await fetch(`${API_BASE_URL}/api/browse-folder`, { signal });
    if (!poll.ok) await readError(poll);

    const outcome = (await poll.json()) as
      | { status: 'pending' }
      | { status: 'done'; path: string }
      | { status: 'cancelled' }
      | { status: 'error'; message: string };

    if (outcome.status === 'done') return outcome.path;
    if (outcome.status === 'cancelled') return null;
    if (outcome.status === 'error') throw new ApiError(500, outcome.message);
  }

  return null;
}

export async function cancelBatch(jobId: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/api/batch/${encodeURIComponent(jobId)}/cancel`, {
    method: 'POST',
  });
  if (!response.ok) await readError(response);
}

export function placeSlug(place: Place): string {
  return place.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || place.id.replace('/', '-');
}

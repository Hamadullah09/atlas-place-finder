import { config } from '../config.js';
import { createLimiter } from './concurrency.js';
import { cancelSignal } from './cancel.js';
import { isOffline, noteUpstreamFailure, noteUpstreamSuccess, OfflineError } from './connectivity.js';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    message: string,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Per-host rate limiting. Nominatim's usage policy is a hard 1 req/s and
 * Overpass will happily 429 you, so we reserve time slots up front rather than
 * checking "time since last call" (which races under concurrency).
 */
const nextSlotAt = new Map<string, number>();

const HOST_MIN_INTERVAL_MS: Array<[RegExp, number]> = [
  [/nominatim/i, 1100],
  [/overpass/i, 1500],
  [/wikimedia|wikipedia|wikidata/i, 120],
  [/api\.unsplash\.com/i, 250],
];

function minIntervalFor(host: string): number {
  for (const [pattern, ms] of HOST_MIN_INTERVAL_MS) {
    if (pattern.test(host)) return ms;
  }
  return 0;
}

function reserveSlot(host: string): number {
  const interval = minIntervalFor(host);
  if (interval === 0) return 0;
  const now = Date.now();
  const at = Math.max(now, nextSlotAt.get(host) ?? 0);
  nextSlotAt.set(host, at + interval);
  return at - now;
}

/**
 * When a host answered 429 or 503, and so how long everything bound for it
 * must wait. Shared across requests: each one used to sleep and retry on its
 * own, at roughly the same moment as the rest, which rebuilt the very burst
 * the server had just refused. The robot policy asks clients to honour
 * Retry-After; this honours it for the whole host.
 */
const hostCooldownUntil = new Map<string, number>();

function noteBackoff(host: string, delayMs: number): void {
  const until = Date.now() + delayMs;
  if (until > (hostCooldownUntil.get(host) ?? 0)) hostCooldownUntil.set(host, until);
}

async function waitOutCooldown(host: string): Promise<void> {
  const wait = (hostCooldownUntil.get(host) ?? 0) - Date.now();
  if (wait > 0) await sleep(wait);
}

/** Which part of Wikimedia's robot policy a request falls under, if any. */
type WikimediaLane = 'media' | 'action' | 'rest';

const WIKIMEDIA_HOST = /(^|\.)(wikipedia|wikimedia|wikidata|wikivoyage|wiktionary|wikibooks|wikiquote|wikisource|wikiversity|wikinews|mediawiki)\.org$/;

export function wikimediaLane(url: string): WikimediaLane | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const host = parsed.hostname;
  if (host === 'upload.wikimedia.org' || host === 'thumb.wikimedia.org') return 'media';
  if (!WIKIMEDIA_HOST.test(host)) return undefined;
  if (host === 'api.wikimedia.org' || parsed.pathname.startsWith('/api/rest_v1') || parsed.pathname.startsWith('/w/rest.php')) {
    return 'rest';
  }
  if (parsed.pathname === '/w/api.php') return 'action';
  // SPARQL, page HTML and anything else are governed elsewhere.
  return undefined;
}

interface LaneState {
  run: <T>(task: () => Promise<T>) => Promise<T>;
  nextStart: number;
  /** [time, bytes] of recent media downloads, for the bandwidth budget. */
  recent: Array<[number, number]>;
}

const laneStates = new Map<WikimediaLane, LaneState>();

function laneState(lane: WikimediaLane): LaneState {
  let state = laneStates.get(lane);
  if (!state) {
    const limit = () => {
      const w = config.wikimedia;
      return lane === 'media' ? w.mediaConcurrency : lane === 'action' ? w.actionConcurrency : w.restConcurrency;
    };
    state = { run: createLimiter(limit), nextStart: 0, recent: [] };
    laneStates.set(lane, state);
  }
  return state;
}

const BUDGET_WINDOW_MS = 10_000;

/** Bytes the media lane may move per window: Mbps x 10s / 8 bits. */
function mediaBudgetBytes(): number {
  return (config.wikimedia.mediaMbps * 1_000_000 * BUDGET_WINDOW_MS) / 1000 / 8;
}

/**
 * Runs `task` -- a whole request, body included -- within the limits the
 * robot policy sets for its part of Wikimedia. Anything that is not Wikimedia
 * runs immediately. The slot is held until the body is read, because that is
 * when the transfer actually happens.
 */
async function underWikimediaPolicy<T>(url: string, task: () => Promise<T>, bytesOf?: (result: T) => number): Promise<T> {
  const lane = wikimediaLane(url);
  if (!lane) return task();
  const state = laneState(lane);

  return state.run(async () => {
    if (lane !== 'media') {
      // Under 5 requests a second, counted across the whole API.
      const spacing = 1000 / Math.max(1, config.wikimedia.requestsPerSecond);
      const now = Date.now();
      const at = Math.max(now, state.nextStart);
      state.nextStart = at + spacing;
      if (at > now) await sleep(at - now);
    } else {
      // Stay inside the bandwidth allowance, measured over 10-second windows.
      for (;;) {
        const cutoff = Date.now() - BUDGET_WINDOW_MS;
        state.recent = state.recent.filter(([time]) => time > cutoff);
        const used = state.recent.reduce((sum, [, bytes]) => sum + bytes, 0);
        if (used < mediaBudgetBytes() || state.recent.length === 0) break;
        await sleep(Math.max(50, state.recent[0]![0] - cutoff));
      }
    }

    const result = await task();
    if (lane === 'media' && bytesOf) state.recent.push([Date.now(), bytesOf(result)]);
    return result;
  });
}

export interface FetchOptions extends Omit<RequestInit, 'signal'> {
  timeoutMs?: number;
  retries?: number;
  /** Skip the per-host throttle (used for image downloads on CDN hosts). */
  skipThrottle?: boolean;
  /**
   * Abort just this request. Combined with the ambient cancel and the timeout,
   * never replacing them -- it lets a caller racing several mirrors drop the
   * losers as soon as one answers.
   */
  signal?: AbortSignal;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export async function fetchWithPolicy(url: string, options: FetchOptions = {}): Promise<Response> {
  const { timeoutMs = 30_000, retries = 2, skipThrottle = false, headers, signal: caller, ...rest } = options;
  const host = new URL(url).host;

  // Cancelling a batch has to reach the request in flight, not just the gap
  // between requests: an image download has a 45s timeout and an LLM call
  // three minutes.
  const ambient = cancelSignal();
  const cancel = ambient && caller
    ? AbortSignal.any([ambient, caller])
    : (ambient ?? caller);

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    cancel?.throwIfAborted();
    if (isOffline() && attempt > 0) throw new OfflineError();

    await waitOutCooldown(host);
    cancel?.throwIfAborted();

    if (!skipThrottle) {
      const wait = reserveSlot(host);
      if (wait > 0) await sleep(wait);
      cancel?.throwIfAborted();
    }

    try {
      const response = await fetch(url, {
        ...rest,
        headers: {
          'User-Agent': config.userAgent,
          'Accept-Language': 'en',
          ...(headers ?? {}),
        },
        signal: cancel
          ? AbortSignal.any([AbortSignal.timeout(timeoutMs), cancel])
          : AbortSignal.timeout(timeoutMs),
      });

      if (RETRYABLE_STATUS.has(response.status)) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const backoff = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 15_000)
          : 800 * 2 ** attempt;
        // "Too many" and "unavailable" are about the host, not this request:
        // hold everything bound for it, even when this request is out of retries.
        if (response.status === 429 || response.status === 503) noteBackoff(host, backoff);
        if (attempt < retries) {
          await sleep(backoff);
          continue;
        }
      }

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new HttpError(
          response.status,
          url,
          `${response.status} ${response.statusText} from ${host}`,
          body.slice(0, 500),
        );
      }

      noteUpstreamSuccess();
      return response;
    } catch (error) {
      lastError = error;
      noteUpstreamFailure(error);
      if (cancel?.aborted) throw cancel.reason;
      // A non-retryable HTTP error should surface immediately.
      if (error instanceof HttpError && !RETRYABLE_STATUS.has(error.status)) throw error;
      if (attempt === retries) break;
      await sleep(800 * 2 ** attempt);
    }
  }

  if (isOffline()) throw new OfflineError();

  throw lastError instanceof Error
    ? lastError
    : new Error(`Request to ${url} failed`);
}

export async function fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
  return underWikimediaPolicy(url, async () => {
    const response = await fetchWithPolicy(url, {
      ...options,
      headers: { Accept: 'application/json', ...(options.headers ?? {}) },
    });
    return (await response.json()) as T;
  });
}

export async function fetchBuffer(
  url: string,
  options: FetchOptions & { maxBytes?: number } = {},
): Promise<{ buffer: Buffer; contentType: string }> {
  const { maxBytes = config.limits.maxImageBytes, ...rest } = options;
  return underWikimediaPolicy(url, () => downloadBuffer(url, maxBytes, rest), (result) => result.buffer.length);
}

async function downloadBuffer(
  url: string,
  maxBytes: number,
  rest: FetchOptions,
): Promise<{ buffer: Buffer; contentType: string }> {
  const response = await fetchWithPolicy(url, { skipThrottle: true, ...rest });

  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`Refusing to download ${declared} bytes from ${url} (limit ${maxBytes})`);
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > maxBytes) {
    throw new Error(`Downloaded payload from ${url} exceeded ${maxBytes} bytes`);
  }

  return {
    buffer: Buffer.from(arrayBuffer),
    contentType: response.headers.get('content-type') ?? 'application/octet-stream',
  };
}

/** Test seam -- forgets cooldowns and lane state between tests. */
export function resetHttpPolicy(): void {
  hostCooldownUntil.clear();
  laneStates.clear();
}

export function qs(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  return search.toString();
}

import { config } from '../config.js';

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

export interface FetchOptions extends Omit<RequestInit, 'signal'> {
  timeoutMs?: number;
  retries?: number;
  /** Skip the per-host throttle (used for image downloads on CDN hosts). */
  skipThrottle?: boolean;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export async function fetchWithPolicy(url: string, options: FetchOptions = {}): Promise<Response> {
  const { timeoutMs = 30_000, retries = 2, skipThrottle = false, headers, ...rest } = options;
  const host = new URL(url).host;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (!skipThrottle) {
      const wait = reserveSlot(host);
      if (wait > 0) await sleep(wait);
    }

    try {
      const response = await fetch(url, {
        ...rest,
        headers: {
          'User-Agent': config.userAgent,
          'Accept-Language': 'en',
          ...(headers ?? {}),
        },
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (RETRYABLE_STATUS.has(response.status) && attempt < retries) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const backoff = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 15_000)
          : 800 * 2 ** attempt;
        await sleep(backoff);
        continue;
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

      return response;
    } catch (error) {
      lastError = error;
      // A non-retryable HTTP error should surface immediately.
      if (error instanceof HttpError && !RETRYABLE_STATUS.has(error.status)) throw error;
      if (attempt === retries) break;
      await sleep(800 * 2 ** attempt);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Request to ${url} failed`);
}

export async function fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const response = await fetchWithPolicy(url, {
    ...options,
    headers: { Accept: 'application/json', ...(options.headers ?? {}) },
  });
  return (await response.json()) as T;
}

export async function fetchBuffer(
  url: string,
  options: FetchOptions & { maxBytes?: number } = {},
): Promise<{ buffer: Buffer; contentType: string }> {
  const { maxBytes = config.limits.maxImageBytes, ...rest } = options;
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

export function qs(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  return search.toString();
}

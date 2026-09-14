/**
 * Whether this machine can still reach the outside world.
 *
 * The app serves its own UI, so the browser cannot answer this: localhost keeps
 * answering perfectly while every upstream call fails, and `navigator.onLine`
 * only reports whether a network adapter is up -- a router with no route to the
 * internet still reads as online. The result was a batch that ground on for
 * hours behind a "Searching..." label with nothing able to say why.
 *
 * Only the code making the upstream calls knows, so the HTTP layer reports
 * outcomes here and everything else asks this module.
 */

/** Failures that mean "the network is gone", not "that server said no". */
function looksLikeConnectivityLoss(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const code = (error as NodeJS.ErrnoException).code ?? '';
  if (
    code === 'ENOTFOUND'      // DNS is unreachable
    || code === 'EAI_AGAIN'   // DNS lookup timed out
    || code === 'ENETUNREACH'
    || code === 'EHOSTUNREACH'
    || code === 'ECONNREFUSED'
    || code === 'ECONNRESET'
    || code === 'EPIPE'
  ) {
    return true;
  }

  // undici wraps the real cause; a bare "fetch failed" is almost always one of
  // the above, and a timeout on a dead link looks the same from here.
  const message = `${error.message} ${String((error as { cause?: unknown }).cause ?? '')}`;
  return /fetch failed|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|socket hang up|network|timeout|aborted/i
    .test(message);
}

/** Cheap, well-known endpoints that should answer whenever the internet does. */
const PROBE_URLS = [
  'https://nominatim.openstreetmap.org/status.php',
  'https://www.wikipedia.org/',
];

const FAILURES_BEFORE_PROBE = 3;
const PROBE_TIMEOUT_MS = 6_000;
/** Long enough not to hammer a dead link, short enough to notice a fix. */
const RECHECK_INTERVAL_MS = 5_000;

let consecutiveFailures = 0;
let offlineSince: number | null = null;
let lastProbeAt = 0;
let probeInFlight: Promise<boolean> | null = null;

export interface ConnectivityState {
  online: boolean;
  /** ISO timestamp of when the outage was first confirmed. */
  offlineSince?: string;
}

export function connectivityState(): ConnectivityState {
  return offlineSince === null
    ? { online: true }
    : { online: false, offlineSince: new Date(offlineSince).toISOString() };
}

export function isOffline(): boolean {
  return offlineSince !== null;
}

/** Any upstream response -- even a 500 -- proves the link is alive. */
export function noteUpstreamSuccess(): void {
  consecutiveFailures = 0;
  if (offlineSince !== null) {
    offlineSince = null;
    console.log('[place-finder] internet connection is back');
  }
}

export function noteUpstreamFailure(error: unknown): void {
  if (!looksLikeConnectivityLoss(error)) return;

  consecutiveFailures += 1;
  if (consecutiveFailures >= FAILURES_BEFORE_PROBE) void confirmConnectivity();
}

/**
 * Confirms an outage before declaring one.
 *
 * A single unreachable host is common -- Overpass rate-limits, Flickr has a bad
 * day -- and calling that "no internet" would be worse than saying nothing.
 */
export async function confirmConnectivity(force = false): Promise<boolean> {
  const now = Date.now();
  // One probe at a time, however many callers ask.
  if (probeInFlight) return probeInFlight;
  // Background callers are throttled; anyone waiting on the answer is not.
  if (!force && now - lastProbeAt < RECHECK_INTERVAL_MS && offlineSince !== null) {
    return false;
  }

  lastProbeAt = now;
  probeInFlight = (async () => {
    for (const url of PROBE_URLS) {
      try {
        await fetch(url, {
          method: 'HEAD',
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        noteUpstreamSuccess();
        return true;
      } catch {
        // Try the next probe before concluding anything.
      }
    }

    if (offlineSince === null) {
      offlineSince = Date.now();
      console.log('[place-finder] no internet connection — upstream services are unreachable');
    }
    return false;
  })();

  try {
    return await probeInFlight;
  } finally {
    probeInFlight = null;
  }
}

/** Thrown instead of grinding through retries that cannot succeed. */
export class OfflineError extends Error {
  readonly kind = 'offline' as const;

  constructor() {
    super('No internet connection. The search needs access to OpenStreetMap and Wikipedia.');
    this.name = 'OfflineError';
  }
}

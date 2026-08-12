import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { rateLimit } from '../lib/rateLimit.js';
import { categorySuggestions } from '../lib/taxonomy.js';
import { knownTravelProviders } from '../lib/travelLinks.js';
import { getStore } from '../services/cache.js';
import { GeocodeError } from '../services/geocode.js';
import { googleConfigured, GoogleSearchError } from '../services/googleSearch.js';
import { OverpassError } from '../services/overpass.js';
import { createProgress, failProgress, getProgress } from '../services/progress.js';
import { runSearch } from '../services/search.js';
import { fetchWithPolicy } from '../lib/http.js';

export const searchRouter = Router();

const searchBodySchema = z.object({
  keyword: z.string().trim().min(2, 'keyword must be at least 2 characters').max(80),
  city: z.string().trim().min(1, 'city is required').max(120),
  country: z.string().trim().min(1, 'country is required').max(120),
  // 0 is accepted as "no limit" and resolves to the server ceiling.
  limit: z.number().int().min(0).max(config.maxResults).optional()
    .transform((value) => (value === 0 ? undefined : value)),
  useLlm: z.boolean().optional(),
  includeImages: z.boolean().optional(),
  refresh: z.boolean().optional(),
  source: z.enum(['osm', 'google']).optional(),
  /** Client-generated id it polls for live stage updates. */
  progressId: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/).optional(),
});

/** An install pinned to one engine ignores whatever the client asked for. */
function resolveSource(requested: 'osm' | 'google' | undefined): 'osm' | 'google' {
  if (config.placeSource === 'osm') return 'osm';
  if (config.placeSource === 'google') return 'google';
  return requested ?? 'osm';
}

// Public geocoding/Overpass instances are shared goods — be a good citizen.
const searchLimiter = rateLimit({
  max: 12,
  windowMs: 60_000,
  message: 'Search rate limit reached. Wait a minute before trying again.',
});

searchRouter.get('/categories', (_req, res) => {
  res.json({
    categories: categorySuggestions(),
    travelProviders: knownTravelProviders().map((provider) => ({
      ...provider,
      enabled: config.travel.providers.includes(provider.id),
    })),
  });
});

searchRouter.get('/history', async (_req, res, next) => {
  try {
    const store = await getStore();
    res.json({ history: await store.history(25), store: store.kind });
  } catch (error) {
    next(error);
  }
});

searchRouter.get('/searches/:searchId', async (req, res, next) => {
  try {
    const store = await getStore();
    const result = await store.getById(req.params.searchId);
    if (!result) {
      res.status(404).json({ error: 'That search has expired or was never run on this server.' });
      return;
    }
    res.json(result);
  } catch (error) {
    next(error);
  }
});

searchRouter.post('/search', searchLimiter, async (req, res, next) => {
  const parsed = searchBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'Invalid search request.',
      details: parsed.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      })),
    });
    return;
  }

  const { refresh, progressId, ...query } = parsed.data;
  query.source = resolveSource(query.source);

  // Registered under the client's own id so it can poll from the moment it
  // sends the request, rather than waiting for a response that is minutes away.
  const progress = createProgress(progressId);

  try {
    const result = await runSearch(query, { refresh, progress });
    res.json(result);
  } catch (error) {
    failProgress(progress, error instanceof Error ? error.message : String(error));
    // These are user-facing input/configuration problems, not server faults.
    if (error instanceof GeocodeError) {
      res.status(404).json({ error: error.message });
      return;
    }
    if (error instanceof GoogleSearchError) {
      res.status(error.status === 'ZERO_RESULTS' ? 404 : 502).json({ error: error.message });
      return;
    }
    if (error instanceof OverpassError) {
      res.status(502).json({
        error: 'OpenStreetMap’s Overpass service is unavailable or overloaded. Try again shortly.',
        details: error.message,
      });
      return;
    }
    next(error);
  }
});

/** Polled by the UI while a search request is still open. */
searchRouter.get('/search/progress/:id', (req, res) => {
  const progress = getProgress(req.params.id);
  if (!progress) {
    res.status(404).json({ error: 'Unknown or expired search.' });
    return;
  }
  res.json(progress);
});

/**
 * Streams a Google Place Photo without ever exposing the API key: the browser
 * and the archive builder both fetch photos through here.
 */
searchRouter.get('/google-photo', async (req, res) => {
  const ref = String(req.query.ref ?? '');
  const width = Math.min(Math.max(Number(req.query.w) || 1200, 100), 4000);

  if (!/^[A-Za-z0-9_-]{10,800}$/.test(ref)) {
    res.status(400).json({ error: 'Invalid photo reference.' });
    return;
  }
  if (!googleConfigured()) {
    res.status(503).json({ error: 'GOOGLE_MAPS_API_KEY is not configured.' });
    return;
  }

  try {
    const upstream = await fetchWithPolicy(
      `https://maps.googleapis.com/maps/api/place/photo?maxwidth=${width}&photo_reference=${encodeURIComponent(ref)}&key=${config.googleMapsApiKey}`,
      { timeoutMs: 30_000, retries: 1, skipThrottle: true },
    );

    res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    const body = Buffer.from(await upstream.arrayBuffer());
    res.end(body);
  } catch {
    res.status(502).json({ error: 'Google photo fetch failed.' });
  }
});

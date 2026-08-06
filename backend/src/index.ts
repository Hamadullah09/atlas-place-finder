import { exec } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { config, isPackaged } from './config.js';
import { setPublicBaseUrl } from './services/googleSearch.js';
import { batchRouter } from './routes/batch.js';
import { downloadRouter } from './routes/download.js';
import { searchRouter } from './routes/search.js';
import { getStore } from './services/cache.js';

const app = express();

app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(
  cors({
    origin(origin, callback) {
      // Same-origin/curl requests have no Origin header.
      if (!origin) return callback(null, true);
      if (config.corsOrigins.includes('*') || config.corsOrigins.includes(origin)) {
        return callback(null, true);
      }
      // Dev servers hop ports; any loopback origin is the same operator.
      if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`Origin ${origin} is not allowed by CORS_ORIGINS`));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    exposedHeaders: ['Content-Disposition'],
  }),
);

app.use(express.json({ limit: config.limits.maxRequestBodyBytes }));

// Whether this process also serves the web UI (packaged exe) or is API-only (dev).
const hasWebBundle = existsSync(path.join(config.webDir, 'index.html'));

app.get('/api/health', async (_req, res) => {
  const store = await getStore().catch(() => null);
  res.json({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    ui: hasWebBundle,
    engines: {
      /** Which engines this install offers ('both' | 'osm' | 'google'). */
      mode: config.placeSource,
      googleConfigured: config.googleMapsApiKey.length > 0,
      /**
       * Maps JS key for the interactive map, served at runtime so the packaged
       * Google edition can use the key from its .env. Never sent by the
       * open-source edition. (Browser map keys are public by design — restrict
       * it to your domains in the Google console.)
       */
      mapsBrowserKey: config.placeSource !== 'osm' && config.googleMapsBrowserKey
        ? config.googleMapsBrowserKey
        : null,
    },
    llm: {
      enabled: config.llm.enabled,
      model: config.llm.enabled ? config.llm.model : null,
      baseUrl: config.llm.baseUrl,
    },
    images: {
      unsplashEnabled: Boolean(config.unsplashAccessKey),
      perPlace: config.imagesPerPlace,
    },
    cache: store?.kind ?? 'unavailable',
    maxResults: config.maxResults,
  });
});

app.use('/api', searchRouter);
app.use('/api', downloadRouter);
app.use('/api', batchRouter);

// Packaged editions bundle the frontend as static files and serve everything
// from this one process; in development, Next.js runs its own dev server.
if (hasWebBundle) {
  app.use(express.static(config.webDir));
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(config.webDir, 'index.html'));
  });
}

app.use((req, res) => {
  res.status(404).json({ error: `No route for ${req.method} ${req.path}` });
});

app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[error]', error);
  if (res.headersSent) {
    res.destroy(error);
    return;
  }
  if (/CORS_ORIGINS/.test(error.message)) {
    res.status(403).json({ error: error.message });
    return;
  }
  if (error instanceof SyntaxError && 'body' in error) {
    res.status(400).json({ error: 'Request body is not valid JSON.' });
    return;
  }
  res.status(500).json({ error: 'Internal server error.' });
});

function openBrowser(port: number): void {
  if (isPackaged && hasWebBundle && process.platform === 'win32') {
    exec(`start "" "http://localhost:${port}"`, { shell: 'cmd.exe' });
  }
}

/**
 * True when another Place Finder instance WITH a web UI answers on this port.
 * A development API server (no UI) does not count — opening the browser on it
 * would just show a JSON 404, so we fall through to the next port instead.
 */
async function isPlaceFinderRunning(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://localhost:${port}/api/health`, {
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { status?: string; ui?: boolean };
    return body.status === 'ok' && body.ui === true;
  } catch {
    return false;
  }
}

function tryListen(port: number): Promise<Server | null> {
  return new Promise((resolve, reject) => {
    const candidate = app.listen(port);
    candidate.once('listening', () => resolve(candidate));
    candidate.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') resolve(null);
      else reject(error);
    });
  });
}

const PORT_ATTEMPTS = 10;

async function start(): Promise<void> {
  // Double-clicking the exe twice should focus the running app, not crash.
  if (isPackaged && (await isPlaceFinderRunning(config.port))) {
    console.log(`[place-finder] already running at http://localhost:${config.port} — opening it`);
    openBrowser(config.port);
    return;
  }

  let server: Server | null = null;
  let port = config.port;
  for (let attempt = 0; attempt < PORT_ATTEMPTS && !server; attempt += 1) {
    port = config.port + attempt;
    server = await tryListen(port);
    if (!server) console.log(`[place-finder] port ${port} is busy, trying ${port + 1}…`);
  }

  if (!server) {
    throw new Error(
      `Ports ${config.port}-${config.port + PORT_ATTEMPTS - 1} are all in use. `
        + 'Close whatever occupies them or set PORT in .env.',
    );
  }

  // The Google photo proxy builds absolute URLs — teach it the real port.
  if (!process.env.PUBLIC_BASE_URL && port !== config.port) {
    setPublicBaseUrl(`http://localhost:${port}`);
  }

  console.log(`[place-finder] API listening on http://localhost:${port}`);
  console.log(`[place-finder] CORS origins: ${config.corsOrigins.join(', ')}`);
  console.log(`[place-finder] engines: ${config.placeSource}`);
  console.log(
    config.llm.enabled
      ? `[place-finder] LLM filtering: ${config.llm.model} via ${config.llm.baseUrl}`
      : '[place-finder] LLM filtering: disabled (no LLM_API_KEY) — using the rule-based cleaner',
  );

  openBrowser(port);

  // Archive responses can legitimately take minutes.
  server.requestTimeout = 10 * 60 * 1000;
  server.headersTimeout = 65_000;

  const active = server;
  function shutdown(signal: string): void {
    console.log(`[place-finder] ${signal} received, shutting down`);
    active.close(() => {
      void getStore()
        .then((store) => store.close())
        .catch(() => undefined)
        .finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((error: unknown) => {
  console.error(`\n[place-finder] failed to start: ${error instanceof Error ? error.message : String(error)}`);
  if (isPackaged) {
    // A double-clicked exe's console vanishes on exit — give the user time to read.
    console.error('\nThis window closes in 30 seconds.');
    setTimeout(() => process.exit(1), 30_000);
  } else {
    process.exitCode = 1;
  }
});

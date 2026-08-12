import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

/** Directory of this module — works both as ESM (dev) and bundled CJS (exe). */
const moduleDir =
  typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));

/**
 * Packaged builds (pkg) run from a read-only snapshot; the editable .env lives
 * next to the executable, not in the snapshot cwd. Development keeps the
 * plain `.env` in the backend folder.
 */
export const isPackaged = Boolean((process as { pkg?: unknown }).pkg);
const envDir = isPackaged ? path.dirname(process.execPath) : process.cwd();
dotenv.config({ path: path.join(envDir, '.env') });

/**
 * Each packaged edition ships an `edition.json` inside its snapshot that pins
 * the engine ('osm' or 'google'). Environment variables still win.
 */
function editionDefault(): string {
  try {
    const raw = readFileSync(path.join(moduleDir, 'edition.json'), 'utf8');
    const parsed = JSON.parse(raw) as { placeSource?: string };
    return typeof parsed.placeSource === 'string' ? parsed.placeSource : 'both';
  } catch {
    return 'both';
  }
}

function str(value: string | undefined, fallback: string): string {
  const v = (value ?? '').trim();
  return v.length > 0 ? v : fallback;
}

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  const v = (value ?? '').trim().toLowerCase();
  if (v === '') return fallback;
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function list(value: string | undefined, fallback: string[]): string[] {
  const parts = (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : fallback;
}

const SAFE_DEFAULT_USER_AGENT = 'PlaceFinder/1.0 (self-hosted; set HTTP_USER_AGENT to your contact URL)';

/**
 * Filled in at startup by `autodetectOllama()` when the operator left the
 * LLM_* settings blank but is running Ollama locally. Without this the
 * packaged app silently falls back to one-line PDFs on a machine that has a
 * perfectly good model installed.
 */
let detectedLlm: { baseUrl: string; model: string } | null = null;

/**
 * Best first. Qwen3 4B leads: it is the smallest model measured to hold the
 * write-up JSON schema and translate CJK place names reliably, while still
 * running on a CPU-only machine. Larger models win if the operator has them.
 */
const MODEL_PREFERENCE = [
  /^qwen3:(8|14|30|32)b/i,
  /^llama3\.[13]:(8|70)b/i,
  /^qwen3:4b/i,
  /^qwen2\.5:(7|14|32)b/i,
  /^qwen3/i,
  /^mistral/i,
  /^gemma[23]?:(9|12|27)b/i,
  /^llama3/i,
  /^qwen2\.5/i,
];

/** Embedding models, best first. BGE-M3 is multilingual and CPU-friendly. */
const EMBED_PREFERENCE = [/^bge-m3/i, /^mxbai-embed/i, /^nomic-embed/i, /^all-minilm/i];

let detectedEmbedModel: string | null = null;

export async function autodetectOllama(): Promise<string | null> {
  // An explicit key always wins; never override what the operator configured.
  if (str(process.env.LLM_API_KEY, '').length > 0) return null;

  const host = str(process.env.OLLAMA_HOST, 'http://localhost:11434').replace(/\/+$/, '');
  try {
    const response = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(2_500) });
    if (!response.ok) return null;

    const payload = (await response.json()) as { models?: Array<{ name?: string }> };
    const names = (payload.models ?? [])
      .map((entry) => entry.name)
      .filter((name): name is string => Boolean(name));
    if (names.length === 0) return null;

    // Embedding models cannot answer chat requests — never pick one as the LLM.
    const chatNames = names.filter((name) => !EMBED_PREFERENCE.some((p) => p.test(name)));

    const model = MODEL_PREFERENCE.map((pattern) => chatNames.find((name) => pattern.test(name)))
      .find(Boolean) ?? chatNames[0];
    if (!model) return null;

    detectedEmbedModel = EMBED_PREFERENCE.map((pattern) => names.find((name) => pattern.test(name)))
      .find(Boolean) ?? null;

    detectedLlm = { baseUrl: `${host}/v1`, model };
    return model;
  } catch {
    return null; // Ollama not installed or not running — stay disabled.
  }
}

/**
 * Nominatim hard-blocks (HTTP 403) any User-Agent containing a placeholder
 * domain such as example.com — a copy-pasted `.env` would otherwise fail every
 * geocode with a confusing "city not found". Catch it here instead.
 */
function resolveUserAgent(): string {
  const configured = str(process.env.HTTP_USER_AGENT, '');
  if (!configured) return SAFE_DEFAULT_USER_AGENT;

  if (/example\.(com|org|net)/i.test(configured)) {
    console.warn(
      '[config] HTTP_USER_AGENT contains a placeholder domain, which Nominatim rejects with 403. '
        + 'Falling back to a safe default — set it to your real contact URL.',
    );
    return SAFE_DEFAULT_USER_AGENT;
  }

  return configured;
}

export const config = {
  port: num(process.env.PORT, 4000),
  corsOrigins: list(process.env.CORS_ORIGINS, ['http://localhost:3000']),

  /** Nominatim and Overpass both reject anonymous traffic — identify yourself. */
  userAgent: resolveUserAgent(),

  nominatimUrl: str(process.env.NOMINATIM_URL, 'https://nominatim.openstreetmap.org').replace(/\/+$/, ''),
  overpassEndpoints: list(process.env.OVERPASS_ENDPOINTS, [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.osm.ch/api/interpreter',
  ]),
  overpassTimeoutMs: num(process.env.OVERPASS_TIMEOUT_MS, 90_000),
  /**
   * Ceiling on results per search. Raised well above the old 60 so a city can
   * be exported exhaustively; the cost is time, not correctness — every place
   * kept is filtered and written up individually, so a 300-place city is
   * hours of local inference. Lower it if you want quick sampling instead.
   */
  maxResults: num(process.env.MAX_RESULTS, 300),

  /**
   * Which place-search engines this installation offers:
   *   'both'   — user picks Open Source or Google per search (default)
   *   'osm'    — open-source-only build (Overpass/Wikidata/Nominatim)
   *   'google' — Google-Maps-only build (requires GOOGLE_MAPS_API_KEY)
   * Pin one to ship the app as two separate products from the same codebase.
   */
  placeSource: (['both', 'osm', 'google'].includes(str(process.env.PLACE_SOURCE, editionDefault()))
    ? str(process.env.PLACE_SOURCE, editionDefault())
    : 'both') as 'both' | 'osm' | 'google',

  /** Static frontend bundle served by this process in packaged builds. */
  webDir: str(process.env.WEB_DIR, path.join(moduleDir, 'web')),

  /** Server-side key for Geocoding + Places (search, details, photos). */
  googleMapsApiKey: str(process.env.GOOGLE_MAPS_API_KEY, ''),

  /**
   * Key handed to the browser for the interactive map (Maps JavaScript API).
   * Falls back to GOOGLE_MAPS_API_KEY; use a separate referrer-restricted key
   * in production since browser keys are visible to users.
   */
  googleMapsBrowserKey: str(process.env.GOOGLE_MAPS_BROWSER_KEY, str(process.env.GOOGLE_MAPS_API_KEY, '')),

  /** Where the browser can reach this API — used to build photo-proxy URLs. */
  publicBaseUrl: str(process.env.PUBLIC_BASE_URL, `http://localhost:${num(process.env.PORT, 4000)}`).replace(/\/+$/, ''),

  unsplashAccessKey: str(process.env.UNSPLASH_ACCESS_KEY, ''),

  /**
   * Extra image sources. All free, all licensed for redistribution — which
   * matters because imagery is embedded in PDFs the user keeps. Search-engine
   * image results are deliberately not an option here: they are mostly
   * all-rights-reserved and cannot lawfully be shipped inside an export.
   */
  images: {
    /** flickr.com/services/apps/create/apply — CC-licensed, geotagged, huge. */
    flickrApiKey: str(process.env.FLICKR_API_KEY, ''),
    /** pro.europeana.eu/pages/get-api — museums, monuments, archives. */
    europeanaApiKey: str(process.env.EUROPEANA_API_KEY, ''),
    /** Radius for coordinate-based photo search. Small keeps it on-subject. */
    geoRadiusKm: Number(process.env.IMAGE_GEO_RADIUS_KM ?? 1),
  },
  imagesPerPlace: num(process.env.IMAGES_PER_PLACE, 10),
  minImageWidth: num(process.env.MIN_IMAGE_WIDTH, 1600),
  /** Openverse aggregates ~700M CC-licensed images and needs no API key. */
  openverseEnabled: bool(process.env.OPENVERSE_ENABLED, true),

  /**
   * commons.wikimedia.org is filtered on some networks (it shares an IP with
   * Wikipedia, so the block is by SNI and DNS looks fine). These hosts are
   * tried in order; the first that answers is remembered for the process.
   * The mobile domain usually survives filtering that catches the main one.
   */
  commonsHosts: list(process.env.COMMONS_HOSTS, [
    'commons.wikimedia.org',
    'commons.m.wikimedia.org',
  ]),

  /** Long-form research content pulled per place for the PDF write-up. */
  content: {
    enabled: bool(process.env.CONTENT_ENABLED, true),
    maxExtractChars: num(process.env.CONTENT_MAX_EXTRACT_CHARS, 9000),
    wikivoyage: bool(process.env.CONTENT_WIKIVOYAGE, true),
  },

  /** Extra place-discovery sources layered on top of Overpass. */
  discovery: {
    wikidata: bool(process.env.DISCOVERY_WIKIDATA, true),
    nominatim: bool(process.env.DISCOVERY_NOMINATIM, true),
  },

  /**
   * Outbound deep links into travel marketplaces. These are constructed search
   * URLs, not API integrations — see lib/travelLinks.ts for why an API is not
   * possible for any of them without a partner agreement.
   */
  travel: {
    providers: list(process.env.TRAVEL_PROVIDERS, [
      'tripadvisor',
      'viator',
      'getyourguide',
      'tripcom',
    ]),
    /** Trip.com country storefront: www. / my. (Malaysia) / sg. / uk. / us. */
    tripcomDomain: str(process.env.TRIPCOM_DOMAIN, 'www.trip.com'),
    /**
     * Optional affiliate parameters, as `provider=param=value` pairs, e.g.
     * TRAVEL_AFFILIATE_TAGS=viator=pid=P00012345,getyourguide=partner_id=ABC
     */
    affiliateTags: Object.fromEntries(
      list(process.env.TRAVEL_AFFILIATE_TAGS, [])
        .map((entry) => {
          const [provider, ...rest] = entry.split('=');
          return provider && rest.length > 0
            ? ([provider.trim(), rest.join('=').trim()] as const)
            : null;
        })
        .filter((entry): entry is readonly [string, string] => entry !== null),
    ) as Record<string, string | undefined>,
  },

  llm: {
    get baseUrl(): string {
      return str(process.env.LLM_BASE_URL, detectedLlm?.baseUrl ?? 'https://router.huggingface.co/v1')
        .replace(/\/+$/, '');
    },
    get apiKey(): string {
      return str(process.env.LLM_API_KEY, detectedLlm ? 'ollama' : '');
    },
    get model(): string {
      return str(process.env.LLM_MODEL, detectedLlm?.model ?? 'meta-llama/Llama-3.3-70B-Instruct');
    },
    /** Small by default: a big batch against a local CPU model times out and
     *  costs every place in it. */
    batchSize: num(process.env.LLM_BATCH_SIZE, 5),
    /** Local CPU models are slow; the packaged app cannot assume a fast host. */
    timeoutMs: num(process.env.LLM_TIMEOUT_MS, 180_000),
    get enabled(): boolean {
      return str(process.env.LLM_API_KEY, '').length > 0 || detectedLlm !== null;
    },
    /** True when the LLM came from auto-detection rather than the .env file. */
    get autodetected(): boolean {
      return detectedLlm !== null && str(process.env.LLM_API_KEY, '').length === 0;
    },
    /**
     * Long-form PDF write-ups. Generated at DOWNLOAD time, not search time —
     * one multi-section article per place is far too slow to block a search on,
     * especially against a local CPU model.
     */
    longform: {
      enabled: bool(process.env.LLM_LONGFORM, true),
      timeoutMs: num(process.env.LLM_LONGFORM_TIMEOUT_MS, 240_000),
      /** Headroom matters: a truncated response fails to parse and the place
       *  drops to raw source extracts instead of a written article. */
      maxTokens: num(process.env.LLM_LONGFORM_MAX_TOKENS, 4000),
      /** Places written up in parallel. Keep low for local models. */
      concurrency: num(process.env.LLM_LONGFORM_CONCURRENCY, 2),
    },
  },

  /**
   * Local embeddings, used to recognise that two records describe the same
   * place when the strings differ — transposed characters, a Chinese name
   * beside its English translation, punctuation variants. Exact matching
   * cannot see any of those.
   */
  embeddings: {
    get model(): string {
      return str(process.env.EMBED_MODEL, detectedEmbedModel ?? '');
    },
    get baseUrl(): string {
      // Ollama's native embed endpoint lives beside the OpenAI-compatible one.
      const configured = str(process.env.EMBED_BASE_URL, '');
      if (configured) return configured.replace(/\/+$/, '');
      return str(process.env.OLLAMA_HOST, 'http://localhost:11434').replace(/\/+$/, '');
    },
    get enabled(): boolean {
      return bool(process.env.EMBED_ENABLED, true) && this.model.length > 0;
    },
    /** Cosine similarity above which two place names are treated as one place. */
    duplicateThreshold: Number(process.env.EMBED_DUPLICATE_THRESHOLD ?? 0.92),
    timeoutMs: num(process.env.EMBED_TIMEOUT_MS, 60_000),
    batchSize: num(process.env.EMBED_BATCH_SIZE, 16),
  },

  databaseUrl: str(process.env.DATABASE_URL, ''),
  cacheTtlMs: num(process.env.CACHE_TTL_MS, 6 * 60 * 60 * 1000),

  pdfFontPath: str(process.env.PDF_FONT_PATH, ''),
  pdfFontBoldPath: str(process.env.PDF_FONT_BOLD_PATH, ''),
  /** How many images get embedded inside each place PDF (the rest ship as JPEGs). */
  pdfEmbedImages: num(process.env.PDF_EMBED_IMAGES, 6),

  /** Hard ceilings so a hostile payload can't make us zip 10k files. */
  limits: {
    /** Kept in step with MAX_RESULTS so a full search can be fully exported. */
    maxPlacesPerArchive: num(process.env.MAX_PLACES_PER_ARCHIVE, Math.max(300, num(process.env.MAX_RESULTS, 300))),
    maxImagesPerPlace: 24,
    maxImageBytes: 25 * 1024 * 1024,
    maxRequestBodyBytes: 8 * 1024 * 1024,
  },
} as const;

export type Config = typeof config;

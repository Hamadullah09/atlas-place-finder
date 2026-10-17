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
interface EditionFile {
  placeSource?: string;
  builtAt?: string;
  commit?: string;
}

function readEdition(): EditionFile {
  try {
    return JSON.parse(readFileSync(path.join(moduleDir, 'edition.json'), 'utf8')) as EditionFile;
  } catch {
    return {};
  }
}

const edition = readEdition();

function editionDefault(): string {
  return typeof edition.placeSource === 'string' ? edition.placeSource : 'both';
}

/**
 * When this exe was built. Development runs report "dev", which is itself
 * the answer to "am I looking at the packaged app or the source?".
 */
export const buildStamp = edition.builtAt ?? 'dev';
export const buildCommit = edition.commit ?? '';

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

/**
 * Wikimedia's User-Agent policy asks for "<client>/<version> (<contact>)", the
 * contact being a website, an email address or a wiki user. Its rate limits
 * then give a client with a compliant User-Agent 200 requests a minute, and
 * one identified by nothing but its IP address 10. The old default carried no
 * contact at all: a 6-place photo lookup took 136s, nearly all of it waiting
 * out 429s, against 24s with a compliant one.
 *   https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_User-Agent_Policy
 *   https://www.mediawiki.org/wiki/Wikimedia_APIs/Rate_limits
 */
export const SAFE_DEFAULT_USER_AGENT =
  `AtlasPlaceFinder/1.0 (https://github.com/Hamadullah09/atlas-place-finder) node/${process.versions.node}`;

/** A website, an email address or a wiki user -- what the policy accepts as contact. */
export function hasContactInfo(userAgent: string): boolean {
  return /https?:\/\/[^\s)]+|[^\s@();]+@[^\s@();]+\.[a-z]{2,}|\bUser:\S+/i.test(userAgent);
}

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

  if (!hasContactInfo(configured)) {
    console.warn(
      '[config] HTTP_USER_AGENT has no contact URL or email, so Wikimedia rate-limits it as an anonymous '
        + 'client and lookups stall on 429s. Using the default instead — add your URL or email to it.',
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
   * Extra image sources. The free ones are all licensed for redistribution,
   * which matters because imagery is embedded in PDFs the user keeps.
   *
   * Web image search is the exception and is off unless a key is supplied.
   * Its results are mostly all-rights-reserved, so each is labelled with an
   * unknown licence and a link to its page, and it only runs for places the
   * licensed sources could not illustrate. Enabling it is the operator's
   * decision about what their exports may contain. Scraping search engines
   * is still not an option: it breaches their terms and is blocked quickly.
   */
  images: {
    /** flickr.com/services/apps/create/apply — CC-licensed, geotagged, huge. */
    flickrApiKey: str(process.env.FLICKR_API_KEY, ''),
    /** pro.europeana.eu/pages/get-api — museums, monuments, archives. */
    europeanaApiKey: str(process.env.EUROPEANA_API_KEY, ''),
    /** api-dashboard.search.brave.com — paid per query; see the note above. */
    braveApiKey: str(process.env.BRAVE_SEARCH_API_KEY, ''),
    /** Radius for coordinate-based photo search. Small keeps it on-subject. */
    geoRadiusKm: Number(process.env.IMAGE_GEO_RADIUS_KM ?? 1),
  },
  imagesPerPlace: num(process.env.IMAGES_PER_PLACE, 10),
  /**
   * Places whose photos are looked up at once.
   *
   * Photo lookup is the slowest stage of a search: each place asks several
   * archives at once, and nearly all of that time is spent waiting. The
   * per-host throttle in lib/http.ts still paces the requests, so this governs
   * how many places are in flight, not how hard any one archive is hit.
   *
   * Twelve places took about 67s at 8 and about 55s at 16, so the waiting is
   * worth overlapping; 12 is the middle of that rather than the most this
   * network happened to tolerate.
   */
  imageLookupConcurrency: num(process.env.IMAGE_LOOKUP_CONCURRENCY, 12),
  /**
   * Wikimedia's robot policy, which governs most of what this app fetches:
   * https://wikitech.wikimedia.org/wiki/Robot_policy
   *
   * Unauthenticated clients may run 1 Action API request at a time, 3 REST
   * requests, and 2 media downloads totalling no more than 25 Mbps, with every
   * API kept under 5 requests a second. The app used to run up to 24 image
   * downloads and a dozen API lookups at once, and the 429s that drew cost each
   * place about 16 seconds and, often, its photos. Clients that keep exceeding
   * the limits "may be blocked".
   *
   * These cap the traffic to Wikimedia only; how many places are worked on at
   * once is set separately, by the concurrency settings above.
   */
  wikimedia: {
    mediaConcurrency: num(process.env.WIKIMEDIA_MEDIA_CONCURRENCY, 2),
    mediaMbps: num(process.env.WIKIMEDIA_MEDIA_MBPS, 25),
    actionConcurrency: num(process.env.WIKIMEDIA_API_CONCURRENCY, 1),
    restConcurrency: num(process.env.WIKIMEDIA_REST_CONCURRENCY, 3),
    requestsPerSecond: num(process.env.WIKIMEDIA_REQUESTS_PER_SECOND, 5),
  },
  /**
   * Photos downloaded at once while building the archive.
   *
   * Measured: an export is almost entirely image bytes -- 84s of a 84s build,
   * against 0.13s spent rendering the PDFs. The photos come from Wikimedia's
   * CDN, which is built for parallel reads, so this is the single biggest
   * lever on how long a folder takes to appear.
   */
  archiveDownloadConcurrency: num(process.env.ARCHIVE_DOWNLOAD_CONCURRENCY, 6),
  /**
   * Places prepared at once while writing the output.
   *
   * Each place's photos are fetched and its PDF rendered independently, but the
   * files are still written in order. Without this a place waited for the one
   * before it, so the link never carried more than one place's photos at a
   * time. Measured on a fixed set of 4 places and 16.2MB of photos: 48.9s at
   * one place in flight, 32.3s at two, 16.3s at four.
   *
   * Raising it costs memory, because a place in flight holds its photos in
   * hand -- four places of ten photos is roughly 100MB -- which is why it is a
   * small number rather than "all of them".
   */
  archivePlaceConcurrency: num(process.env.ARCHIVE_PLACE_CONCURRENCY, 4),
  /** HD threshold, applied to the long edge so tall photos qualify too. */
  minImageWidth: num(process.env.MIN_IMAGE_WIDTH, 1600),
  /**
   * Leave out any place without at least one HD photo. A write-up with no
   * picture is not what the export is for, so this is on by default.
   */
  requireImages: bool(process.env.REQUIRE_IMAGES, true),
  /** Openverse aggregates ~700M CC-licensed images and needs no API key. */
  openverseEnabled: bool(process.env.OPENVERSE_ENABLED, true),

  /**
   * commons.wikimedia.org is filtered on some networks (it shares an IP with
   * Wikipedia, so the block is by SNI and DNS looks fine). These hosts are
   * tried in order; the first that answers is remembered for the process.
   * The mobile domain usually survives filtering that catches the main one.
   */
  // commons.m.wikimedia.org is gone from the defaults: Wikimedia now
  // redirects it to commons.wikimedia.org, so on a network blocking that host
  // it only added a slow failure. The Wikimedia API gateway is the fallback.
  commonsHosts: list(process.env.COMMONS_HOSTS, [
    'commons.wikimedia.org',
  ]),

  /** Long-form research content pulled per place for the PDF write-up. */
  content: {
    enabled: bool(process.env.CONTENT_ENABLED, true),
    maxExtractChars: num(process.env.CONTENT_MAX_EXTRACT_CHARS, 9000),
    wikivoyage: bool(process.env.CONTENT_WIKIVOYAGE, true),
    /**
     * Read the country's own Wikivoyage guide and Wikipedia article (from the
     * sources sheet, data/countryReferences.ts) and give each write-up the
     * passages that name its place. One read per country.
     */
    countryPages: bool(process.env.CONTENT_COUNTRY_PAGES, true),
  },

  /**
   * Shallow crawling of official tourism sites for write-up material.
   *
   * data/tourismSources.ts maps each country to its government tourism site;
   * a batch run reads a few pages of the site for the region it is on and
   * feeds the matching passages to the write-up, exactly as a pasted
   * "additional source" already does.
   *
   * robots.txt is honoured for every page a link leads to, any Crawl-delay is
   * obeyed, and the per-host throttle in lib/http.ts still applies.
   *
   * The same sites also supply photographs, for places the openly licensed
   * sources left short (services/tourismImages.ts). Those photographs are
   * all rights reserved: each is credited to the site, with its page, and
   * every export that includes one says so in its README.
   */
  crawl: {
    /** Attach the country's own tourism site to every batch run. */
    tourismSources: bool(process.env.CRAWL_TOURISM_SOURCES, true),
    /** Pages read per site per region, entry page included. */
    maxPagesPerSite: num(process.env.CRAWL_MAX_PAGES, 5),
    /** Wall-clock ceiling for one site's crawl, so a slow host cannot stall a job. */
    budgetMs: num(process.env.CRAWL_BUDGET_MS, 60_000),
    /**
     * Also take photographs from the official tourism site, for places the
     * open sources left short. Those photos are the site's own -- all rights
     * reserved -- and are credited to it and marked so in every export.
     */
    tourismImages: bool(process.env.CRAWL_TOURISM_IMAGES, true),
    /** Pages read on the site per place when looking for its photos, entry page included. */
    tourismImagePages: num(process.env.CRAWL_TOURISM_IMAGE_PAGES, 3),
    /** Wall-clock ceiling for one place's photo crawl. */
    tourismImageBudgetMs: num(process.env.CRAWL_TOURISM_IMAGE_BUDGET_MS, 20_000),
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
    /**
     * Requests in flight at once.
     *
     * A local Ollama answers one at a time, so anything above 1 just fills
     * its queue while each request burns its own timeout waiting -- slower
     * than serial, and it loses batches. A hosted endpoint has no such
     * problem, so it keeps the wider pipe.
     */
    get concurrency(): number {
      const configured = num(process.env.LLM_CONCURRENCY, 0);
      if (configured > 0) return configured;
      return /localhost|127\.0\.0\.1|\[::1\]/.test(this.baseUrl) ? 1 : 3;
    },
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

/**
 * Builds the standalone Windows executables:
 *
 *   dist-exe/SMA-Place-Finder/SMA-Place-Finder.exe                (PLACE_SOURCE=osm)
 *   dist-exe/SMA-Place-Finder-Google/SMA-Place-Finder-Google.exe  (PLACE_SOURCE=google)
 *
 * Each exe embeds Node, the API server, the static frontend and sharp, so the
 * folder can be copied to another PC and run with no install step. Next to it
 * sit an editable .env and a README.
 *
 * Run from the place-finder folder:
 *   node build-exe.mjs [--skip-frontend] [--edition=osm|google]
 */

import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const backend = path.join(root, 'backend');
const frontend = path.join(root, 'frontend');
const stage = path.join(root, 'pkg-stage');
const distRoot = path.join(root, 'dist-exe');

const skipFrontend = process.argv.includes('--skip-frontend');
const onlyEdition = process.argv.find((arg) => arg.startsWith('--edition='))?.split('=')[1];

/**
 * Copies sharp and its dependency closure next to the exe.
 *
 * sharp is a native module, so pkg cannot embed it (--external:sharp). Without
 * it the app still runs but skips every non-JPEG source image, which is most
 * of Wikimedia. Shipping it means the target PC needs no npm install.
 */
function bundleSharp(outDir) {
  const modules = path.join(backend, "node_modules");
  const target = path.join(outDir, "node_modules");
  const copied = new Set();

  function copyPackage(name) {
    if (copied.has(name)) return;
    const source = path.join(modules, name);
    if (!existsSync(source)) return; // optional platform build for another OS
    copied.add(name);

    cpSync(source, path.join(target, name), { recursive: true });

    const manifest = path.join(source, "package.json");
    if (!existsSync(manifest)) return;
    const pkg = JSON.parse(readFileSync(manifest, "utf8"));
    for (const dep of Object.keys(pkg.dependencies ?? {})) copyPackage(dep);
    // Only the current platform's binary is installed; the rest are skipped
    // above, so this stays a Windows-sized copy.
    for (const dep of Object.keys(pkg.optionalDependencies ?? {})) copyPackage(dep);
  }

  copyPackage("sharp");
  console.log(`  bundled sharp + ${copied.size - 1} dependencies`);
}

/** Short commit of the tree being packaged; empty outside a git checkout. */
function gitCommit() {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim();
  } catch {
    return '';
  }
}

function run(command, cwd, env = {}) {
  console.log(`\n> ${command}`);
  execSync(command, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
}

// ---------------------------------------------------------------------------
// 1. Static frontend export (served by the backend inside the exe).
// ---------------------------------------------------------------------------
if (!skipFrontend || !existsSync(path.join(frontend, 'out', 'index.html'))) {
  run('npm run build', frontend, {
    NEXT_EXPORT: '1',
    // Same-origin API: the exe serves both the UI and /api on one port.
    NEXT_PUBLIC_API_BASE_URL: '',
  });
}

// ---------------------------------------------------------------------------
// 2. Bundle the backend to a single CommonJS file.
// ---------------------------------------------------------------------------
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

run(
  'npx esbuild src/index.ts --bundle --platform=node --format=cjs '
    + `--outfile="${path.join(stage, 'server.cjs')}" `
    + '--external:sharp --external:pg-native --log-level=warning',
  backend,
);

// pdfkit reads its font metrics from __dirname/data at runtime.
cpSync(path.join(backend, 'node_modules', 'pdfkit', 'js', 'data'), path.join(stage, 'data'), {
  recursive: true,
});
cpSync(path.join(frontend, 'out'), path.join(stage, 'web'), { recursive: true });

// ---------------------------------------------------------------------------
// 3. One exe per edition.
// ---------------------------------------------------------------------------
const EDITIONS = [
  {
    name: 'SMA-Place-Finder',
    placeSource: 'osm',
    title: 'SMA Place Finder',
    envExtra: [
      '# This edition searches OpenStreetMap / Wikidata / Wikipedia / Wikivoyage.',
      '# No API key is required.',
    ],
  },
  {
    name: 'SMA-Place-Finder-Google',
    placeSource: 'google',
    title: 'SMA Place Finder — Google Maps edition',
    envExtra: [
      '# This edition searches with the Google Maps Platform. REQUIRED:',
      '# a key with the Places API and Geocoding API enabled.',
      'GOOGLE_MAPS_API_KEY=',
      '',
      '# Optional separate key for the interactive browser map (Maps JavaScript',
      '# API). Leave empty to reuse GOOGLE_MAPS_API_KEY for the map as well.',
      'GOOGLE_MAPS_BROWSER_KEY=',
    ],
  },
];

const ENV_COMMON = [
  '# ---- Place Finder configuration (edit, then restart the app) ----',
  'PORT=4000',
  '',
  '# Identify yourself to the free OpenStreetMap services (change before heavy use).',
  'HTTP_USER_AGENT=PlaceFinder/1.0 (self-hosted)',
  '',
  '# AI-written PDF articles and English names for non-Latin places.',
  '# A local Ollama is detected automatically — install it from https://ollama.com',
  '# and pull the two recommended models:',
  '#   ollama pull qwen3:8b     (filtering + writing + translation)',
  '#   ollama pull bge-m3       (embeddings: merges duplicate place names)',
  '# Whatever is installed is used automatically; qwen3:4b is the smaller',
  '# fallback for CPU-only machines.',
  '# Nothing below needs filling in for that. Use these only to override the',
  '# choice, or to point at a hosted OpenAI-compatible endpoint instead:',
  '#   LLM_BASE_URL=https://router.huggingface.co/v1',
  '#   LLM_API_KEY=hf_xxxxxxxx',
  '#   LLM_MODEL=meta-llama/Llama-3.3-70B-Instruct',
  'LLM_BASE_URL=',
  'LLM_API_KEY=',
  'LLM_MODEL=',
  '',
  '# Tuning for slow CPU-only machines. Batches stay small so one slow call',
  '# never times out a whole group of places; raise these on a GPU machine.',
  'LLM_BATCH_SIZE=5',
  'LLM_TIMEOUT_MS=180000',
  '',
  '# Embeddings are auto-detected too (pull bge-m3). Override the model, or set',
  '# EMBED_ENABLED=false to turn semantic duplicate-merging off entirely.',
  'EMBED_MODEL=',
  'EMBED_ENABLED=true',
  '# Similarity above which two names count as the same place (0-1).',
  'EMBED_DUPLICATE_THRESHOLD=0.92',
  '',
  '# ---- Photos ----',
  '# Places without at least one HD photo are left out of results. Set to',
  '# false to keep them (their PDFs will have no pictures).',
  'REQUIRE_IMAGES=true',
  '# HD threshold in pixels, measured on the long edge of the photo.',
  'MIN_IMAGE_WIDTH=1600',
  '',
  '# Free, licensed photo sources. Each adds many HD photos; both are off',
  '# until a key is filled in.',
  '#   Flickr (CC-licensed only):  https://www.flickr.com/services/apps/create/apply',
  'FLICKR_API_KEY=',
  '#   Europeana (museums, monuments): https://pro.europeana.eu/pages/get-api',
  'EUROPEANA_API_KEY=',
  '',
  '# Web image search via Brave (official API, paid per query). Only used for',
  '# places the licensed sources above cannot illustrate. Its photos are',
  '# mostly all-rights-reserved: they are labelled "licence unknown" in each',
  '# PDF, and you are responsible for checking before sharing exports.',
  '#   https://api-dashboard.search.brave.com',
  'BRAVE_SEARCH_API_KEY=',
  '',
];

function readme(edition) {
  return [
    edition.title,
    '='.repeat(edition.title.length),
    '',
    'HOW TO RUN',
    '----------',
    `  Double-click ${edition.name}.exe. That is the whole setup.`,
    '',
    'Your browser opens the app by itself (http://localhost:4000, or the next',
    'free port if 4000 is taken). Nothing to install, no account, no key.',
    '',
    'If Windows shows "Windows protected your PC" (SmartScreen, which every',
    'unsigned program gets): click "More info", then "Run anyway".',
    '',
    'Keep the black console window open while you work - closing it stops the',
    'app. Double-clicking the exe again just reopens the browser tab.',
    '',
    'WHAT YOU NEED',
    '-------------',
    'An internet connection. Place data comes from OpenStreetMap and the',
    'write-ups from Wikipedia, Wikidata and Wikivoyage.',
    '',
    'AI IS OPTIONAL AND AUTOMATIC',
    '----------------------------',
    'If Ollama (https://ollama.com) is running on the same PC, the app finds it',
    'on startup and uses it - there is nothing to configure. The console window',
    'prints which models it picked.',
    '',
    'It looks for two kinds of model and uses whichever are installed:',
    '  - a chat model, for relevance filtering, the PDF articles and English',
    '    names for non-Latin places. Preferred order: qwen3:8b, qwen3:14b,',
    '    llama3.1:8b, qwen3:4b, then anything else it finds.',
    '  - an embedding model, which merges duplicate places across regions.',
    '    Preferred order: bge-m3, mxbai-embed, nomic-embed, all-minilm.',
    '',
    'To add them:',
    '  ollama pull qwen3:8b',
    '  ollama pull bge-m3',
    '',
    'Without Ollama nothing breaks: searches and exports still work, using text',
    'assembled straight from the sources instead of AI-written articles.',
    '',
    'USING IT',
    '--------',
    'Single search: say what and where, then press Search. The type defaults to',
    '               "all"; the buttons underneath narrow it, and several can be',
    '               picked at once.',
    'Batch search : upload a CSV (Country, City, Province/State, and an optional',
    '               Maximum search column), choose the attribute and a save',
    '               folder - one ZIP of PDFs and photos is saved per region.',
    '',
    'Pick a save folder and the ZIP is written straight into it. Leave it empty',
    'and the browser downloads it instead.',
    '',
    'Settings live in the .env file next to the exe. Nothing in it has to be',
    'filled in for the app to work.',
    ...(edition.placeSource === 'google'
      ? [
          '',
          'THIS EDITION NEEDS A KEY',
          '------------------------',
          'Set GOOGLE_MAPS_API_KEY in .env before the first search. The key needs the',
          'Places API and Geocoding API enabled at',
          'https://console.cloud.google.com/apis/library',
        ]
      : []),
    '',
  ].join('\r\n');
}

const selected = onlyEdition
  ? EDITIONS.filter((edition) => edition.placeSource === onlyEdition)
  : EDITIONS;
if (selected.length === 0) throw new Error(`Unknown edition "${onlyEdition}" (use osm or google).`);

for (const edition of selected) {
  console.log(`\n=== Building ${edition.name} ===`);

  // Stamped so a stale copy on another PC is obvious from the console line
  // and the app header, rather than looking identical to a current one.
  writeFileSync(
    path.join(stage, 'edition.json'),
    JSON.stringify({
      placeSource: edition.placeSource,
      builtAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
      commit: gitCommit(),
    }),
  );
  writeFileSync(
    path.join(stage, 'package.json'),
    JSON.stringify(
      {
        name: edition.name.toLowerCase(),
        version: '1.0.0',
        main: 'server.cjs',
        bin: 'server.cjs',
        pkg: {
          assets: ['data/**/*', 'web/**/*', 'edition.json'],
        },
      },
      null,
      2,
    ),
  );

  const outDir = path.join(distRoot, edition.name);
  mkdirSync(outDir, { recursive: true });

  const pkgBin = path.join(backend, 'node_modules', '.bin', process.platform === 'win32' ? 'pkg.cmd' : 'pkg');
  run(
    `"${pkgBin}" . --targets node22-win-x64 --output "${path.join(outDir, `${edition.name}.exe`)}" --compress GZip`,
    stage,
  );

  bundleSharp(outDir);

  writeFileSync(path.join(outDir, '.env'), [...ENV_COMMON, ...edition.envExtra, ''].join('\r\n'));
  writeFileSync(path.join(outDir, 'README.txt'), readme(edition));
}

console.log('\nDone. Copy the folder from dist-exe\\ to the target PC and run the exe.');

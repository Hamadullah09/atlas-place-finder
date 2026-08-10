/**
 * Builds the two standalone Windows executables:
 *
 *   dist-exe/PlaceFinder-OpenSource/PlaceFinder-OpenSource.exe   (PLACE_SOURCE=osm)
 *   dist-exe/PlaceFinder-Google/PlaceFinder-Google.exe           (PLACE_SOURCE=google)
 *
 * Each exe embeds Node, the API server and the static frontend; next to it sit
 * an editable .env, a README and (optionally) sharp for image conversion.
 *
 * Run from the place-finder folder:  node build-exe.mjs [--skip-frontend]
 */

import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const backend = path.join(root, 'backend');
const frontend = path.join(root, 'frontend');
const stage = path.join(root, 'pkg-stage');
const distRoot = path.join(root, 'dist-exe');

const skipFrontend = process.argv.includes('--skip-frontend');

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
    name: 'PlaceFinder-OpenSource',
    placeSource: 'osm',
    title: 'Place Finder — Open Source edition',
    envExtra: [
      '# This edition searches OpenStreetMap / Wikidata / Wikipedia / Wikivoyage.',
      '# No API key is required.',
    ],
  },
  {
    name: 'PlaceFinder-Google',
    placeSource: 'google',
    title: 'Place Finder — Google Maps edition',
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
  '#   ollama pull qwen3:4b     (writing + translation)',
  '#   ollama pull bge-m3       (embeddings: merges duplicate place names)',
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
];

function readme(edition) {
  return [
    edition.title,
    '='.repeat(edition.title.length),
    '',
    'Run:',
    `  1. Double-click ${edition.name}.exe`,
    '  2. Your browser opens the app automatically (http://localhost:4000,',
    '     or the next free port if 4000 is taken).',
    '',
    'If Windows shows "Windows protected your PC" (SmartScreen — normal for',
    'unsigned downloads): click "More info", then "Run anyway".',
    '',
    'Keep the black console window open while using the app — closing it',
    'stops the server. Double-clicking the exe again just reopens the browser.',
    '',
    'Single search: pick what/where and press Search.',
    'Batch search : upload a CSV (Country, City, Province/State columns),',
    '               choose the attribute, a save folder and optional source',
    '               links — one ZIP of PDFs + photos is saved per region.',
    '',
    'Configuration lives in the .env file next to the exe.',
    ...(edition.placeSource === 'google'
      ? [
          '',
          'IMPORTANT: set GOOGLE_MAPS_API_KEY in .env before the first search.',
          'The key needs the Places API and Geocoding API enabled at',
          'https://console.cloud.google.com/apis/library',
        ]
      : []),
    '',
    'For AI-written PDF articles and English names for non-Latin places,',
    'install Ollama from https://ollama.com and run:',
    '  ollama pull qwen3:4b',
    '  ollama pull bge-m3',
    'That is all — the app detects a running Ollama on startup and uses both, with',
    'no configuration. The console window says which models it picked. Without',
    'them exports still work, using text assembled directly from the sources.',
    '',
    'qwen3:4b is the smallest model that reliably holds the article format and',
    'translates Chinese/Arabic/Cyrillic place names. Smaller models produce',
    'thin articles and leave some names untranslated.',
    '',
  ].join('\r\n');
}

for (const edition of EDITIONS) {
  console.log(`\n=== Building ${edition.name} ===`);

  writeFileSync(
    path.join(stage, 'edition.json'),
    JSON.stringify({ placeSource: edition.placeSource }),
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

  writeFileSync(path.join(outDir, '.env'), [...ENV_COMMON, ...edition.envExtra, ''].join('\r\n'));
  writeFileSync(path.join(outDir, 'README.txt'), readme(edition));
}

console.log('\nDone. Editions are in dist-exe\\');
console.log('Optional (better image conversion): inside each edition folder run');
console.log('  npm install sharp --no-save --prefix .');

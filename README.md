# Atlas — Place Finder

Find every place of a given kind in any city on earth, research each one, and export
the lot as a folder tree of illustrated PDFs.

Point it at a single city (*museums in Hefei, China*) or hand it a CSV of hundreds of
cities and provinces and let it work through them unattended.

It ships as **two editions from one codebase**:

| | Open Source edition | Google Maps edition |
| --- | --- | --- |
| Places | OpenStreetMap (Overpass) + Wikidata + Nominatim | Google Places Text Search |
| Details | Wikipedia · Wikivoyage · Wikidata | Google Place Details (ratings, hours, contact) |
| Photos | Wikimedia Commons · Openverse | Google Place Photos |
| API key | none | Places API + Geocoding API |

---

## What it produces

Every search becomes a ZIP laid out per place, so a run over a CSV of cities builds a
browsable archive:

```
[Save folder]/
├── China/
│   ├── Hefei/
│   │   └── museums.zip
│   │       └── China/Hefei/
│   │           ├── _search-summary.pdf
│   │           └── Hefei Historical and Cultural Museum of the Three Kingdoms/
│   │               ├── …_details.pdf        ← written article + contact + location
│   │               ├── …_01.jpeg            ← ultra-HD imagery
│   │               └── …_02.jpeg
│   └── Anhui/
│       └── museums.zip
├── _batch-report.txt                        ← per-region outcome
└── _batch-state.json                        ← resume point
```

Each `_details.pdf` carries an Overview, History, Architecture, Highlights, Visiting
and Practical section written from sourced material only — Wikipedia, Wikivoyage,
Wikidata statements, OSM tags, plus any source URLs you supply.

---

## Quick start (development)

```bash
cd backend && npm install && cp .env.example .env && npm run dev
```

```bash
cd frontend && npm install && cp .env.local.example .env.local && npm run dev
```

Open <http://localhost:3000>. With no keys at all you get OpenStreetMap results,
Wikimedia imagery and PDF export; the LLM and Google features are opt-in below.

---

## The two modes

### Single search
Pick what, which city, which country. Results plot on the map, and any subset can be
exported.

### Batch search
Upload a CSV, set three things once, and walk away.

| Column | Purpose |
| --- | --- |
| `Country` | Repeats down the rows — write it once |
| `City` | One search per row |
| `Province/state` | Searched as its own region |
| `Attributes` | *(optional)* pre-fills the attribute box |
| `Path` | *(optional)* pre-fills the save folder |
| any column | any `http(s)` URL found becomes an extra source |

```csv
S.No.,Country,City,Province/state,Attributes,Path,Add Source
1,China,Anshan,,tourist places,C:\Exports\China,https://www.travelchina.org.cn/en
2,China,Beijing,,,,
,,,Anhui,,,
```

Then choose the **attribute** (what to search for in every city), a **save folder**
(there is a native Browse… button), and optional **source links**, and press Start.

Batch runs are built to survive being interrupted:

- Each region's ZIP is written to a `.part` file and renamed only when complete, so a
  crash never leaves a half-archive that looks finished.
- Progress is flushed to `_batch-state.json` after every region — restart and it
  continues where it stopped.
- A place already exported for another region is skipped, because a province and the
  cities inside it return the same landmarks.

---

## Configuration

### Local models (optional, recommended)

Used to filter results, write the PDF articles, translate non-Latin place names, and
merge records that name one place two ways. Install [Ollama](https://ollama.com) and:

```bash
ollama pull qwen3:4b
ollama pull bge-m3
```

**That is the whole setup** — both are detected at startup and used automatically.
The console prints which it picked. Everything runs on CPU; no key, no GPU, no cost.

| Model | Job |
| --- | --- |
| `qwen3:4b` | Filtering, English write-ups, translating CJK/Arabic/Cyrillic names |
| `bge-m3` | Embeddings — merges near-duplicate names, multilingual |

Without them the app still runs end to end; PDFs use text assembled directly from the
sources. Any OpenAI-compatible endpoint can be used instead via `LLM_BASE_URL` /
`LLM_API_KEY` / `LLM_MODEL`.

`qwen3:4b` is the recommended floor. Smaller models leave a share of non-Latin names
untranslated and produce noticeably thinner articles — measure it yourself with the
harness below. It is a reasoning model that emits `<think>` blocks; the parser strips
them.

### Measuring prompt and schema changes

Prompts are evaluated against a fixed corpus of real records rather than by eye:

```bash
npm run eval:harvest -- --target 800    # one-off: capture real places to JSONL
npm run eval -- --limit 500             # score every LLM stage
```

The corpus is captured *before* any model touches it, so a prompt change can be
compared against byte-identical input as often as needed without re-hitting Overpass.
It is weighted towards Chinese, Arabic, Cyrillic and Indic cities, because that is
where translation and rendering actually break.

Scoring is deterministic — no rubric model, no subjective grading. It counts things
that are objectively wrong: residual source script in a translated name, the original
echoed beside its translation, name collisions, write-up JSON that fails to parse,
empty sections, and opening-hours claims with no supporting tag. Run one stage at a
time with `--stage translate|filter|writeup|dedupe`, and `--report FILE` to save.

### Google Maps

Enable **Places API** and **Geocoding API** for the search engine, and **Maps
JavaScript API** for the interactive map. Then in `backend/.env`:

```ini
GOOGLE_MAPS_API_KEY=AIza…
```

The key stays server-side: browser photo URLs point at the app's own
`/api/google-photo` proxy. Optionally set `GOOGLE_MAPS_BROWSER_KEY` to a separate
referrer-restricted key for the map.

### Pinning an edition

`PLACE_SOURCE` decides which engines an install offers:

| Value | Behaviour |
| --- | --- |
| `both` | user picks per search (default) |
| `osm` | open-source only — no Google UI anywhere |
| `google` | Google only |

### Other settings

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `4000` | falls forward if busy |
| `HTTP_USER_AGENT` | — | Nominatim rejects placeholder domains |
| `MAX_RESULTS` | `60` | per search |
| `IMAGES_PER_PLACE` | `10` | |
| `PDF_FONT_PATH` | — | Unicode TTF (e.g. Noto Sans) to render CJK/Arabic natively |
| `DATABASE_URL` | — | optional Postgres cache; in-memory otherwise |

---

## Building the desktop editions

```bash
node build-exe.mjs
```

Produces two self-contained Windows executables under `dist-exe/` (Node, API and UI
all embedded — nothing to install):

```
dist-exe/
├── PlaceFinder-OpenSource/   PlaceFinder-OpenSource.exe · .env · README.txt
└── PlaceFinder-Google/       PlaceFinder-Google.exe     · .env · README.txt
```

Copy a whole folder to any Windows PC and double-click the exe — it starts the server
and opens the browser itself. Settings live in the `.env` beside it.

`dist-exe/` is gitignored: the executables are ~60 MB each, past GitHub's limits.

Notes: unsigned exes trigger a SmartScreen warning (*More info → Run anyway*); image
format conversion needs `sharp`, installable per edition folder with
`npm install sharp --no-save --prefix .`.

---

## Non-English places

Places mapped only in Chinese, Arabic or Cyrillic are resolved to English through
OSM's `name:en`/`int_name` tags → the Wikidata English label → LLM translation, with
the original preserved as `name:local`. The write-up model is instructed to answer in
English regardless of source language, so a place named 安徽省科学技术馆 exports as
*Anhui Science and Technology Museum* with a full English article.

---

## Stack

Next.js 15 · React 19 · Tailwind 4 · Express · TypeScript · pdfkit · sharp ·
archiver · Zod

## Attribution

Place data © OpenStreetMap contributors, [ODbL](https://www.openstreetmap.org/copyright).
Imagery from Wikimedia Commons, Wikipedia and Openverse under the licence recorded per
file; Google-sourced data and photos are subject to the Google Maps Platform terms.
Check the licence before commercial reuse.

import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Writable } from 'node:stream';
import archiver from 'archiver';
import { config, isPackaged } from '../config.js';
import { mapLimit } from '../lib/concurrency.js';
import { fetchBuffer } from '../lib/http.js';
import { fetchPublicImage } from '../lib/publicUrl.js';
import { createNameDeduper, sanitizePathSegment } from '../lib/sanitize.js';
import { fetchContentForPlaces } from './content.js';
import { excerptsForPlace, type ExtraSourceDoc } from './extraSources.js';
import { isAllowedImageUrl, notifyUnsplashDownload } from './images.js';
import { renderPlacePdf, renderSummaryPdf, type PdfImageAsset } from './pdf.js';
import { setStage, type SearchProgress } from './progress.js';
import { generateWriteups } from './writeup.js';
import type { Place, PlaceContent, PlaceWriteup, SearchResult } from '../types.js';

/**
 * sharp is a native module. If the install failed (common on locked-down
 * Windows/Alpine boxes) we degrade to passing JPEG bytes through untouched
 * rather than crashing the download endpoint.
 */
type SharpModule = typeof import('sharp');
let sharpModule: SharpModule | null | undefined;

async function loadSharp(): Promise<SharpModule | null> {
  if (sharpModule !== undefined) return sharpModule;

  try {
    sharpModule = (await import('sharp')).default as unknown as SharpModule;
    return sharpModule;
  } catch {
    // Fall through to the packaged lookup below.
  }

  // Inside the exe the bundle has no node_modules of its own: sharp is a
  // native module, so it ships as a real folder beside the executable and has
  // to be required from there by absolute path.
  if (isPackaged) {
    try {
      const beside = path.join(path.dirname(process.execPath), 'node_modules', 'sharp');
      const requireBeside = createRequire(path.join(path.dirname(process.execPath), 'index.cjs'));
      sharpModule = requireBeside(beside) as SharpModule;
      return sharpModule;
    } catch {
      // Genuinely unavailable — callers degrade to JPEG passthrough.
    }
  }

  sharpModule = null;
  return sharpModule;
}

interface ConvertedImage {
  buffer: Buffer;
  /** Position in the place's photo list; the filename is built from it later. */
  index: number;
  caption?: string;
}

function captionFor(place: Place, index: number): string {
  const image = place.images[index];
  if (!image) return '';
  return [
    image.title ?? `${place.name} (${index + 1})`,
    image.credit ? `— ${image.credit}` : '',
    image.license ? `[${image.license}]` : '',
    `via ${image.source}`,
  ]
    .filter(Boolean)
    .join(' ');
}

function safeHost(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return 'invalid URL';
  }
}

async function toJpeg(input: Buffer, contentType: string): Promise<Buffer | null> {
  const sharp = await loadSharp();

  if (!sharp) {
    return /jpe?g/i.test(contentType) ? input : null;
  }

  try {
    return await sharp(input)
      .rotate() // honour EXIF orientation before stripping metadata
      // Plain libjpeg at 4:2:0, not mozjpeg at 4:4:4. On a 2341x2871 photo the
      // old settings took 1930ms to produce 2.17MB; these take 124ms to
      // produce 2.11MB -- fifteen times faster and slightly smaller. mozjpeg
      // was measured costing 11x the CPU for a file no smaller, and 4:2:0 is
      // what every camera and every photo site already uses; it is only worth
      // avoiding for text and line art, which these never are. An export of a
      // few hundred places spends minutes here, so this is the difference
      // between a wait and a coffee break.
      .jpeg({ quality: 90 })
      .toBuffer();
  } catch {
    return /jpe?g/i.test(contentType) ? input : null;
  }
}

async function downloadPlaceImages(
  place: Place,
  notes: string[],
): Promise<ConvertedImage[]> {
  const images = place.images.slice(0, config.limits.maxImagesPerPlace);
  if (images.length === 0) return [];

  const settled = await mapLimit(images, config.archiveDownloadConcurrency, async (image, index) => {
    // Web-search results point at whatever site published the photo, so no
    // allowlist can cover them; they must instead reach a public address.
    // Everything else still has to come from a known image host.
    const { buffer, contentType } = image.source === 'brave'
      ? await fetchPublicImage(image.downloadUrl)
      : await (async () => {
        if (!isAllowedImageUrl(image.downloadUrl)) {
          throw new Error(`image host not allowed: ${safeHost(image.downloadUrl)}`);
        }
        return fetchBuffer(image.downloadUrl, { timeoutMs: 45_000, retries: 1 });
      })();
    notifyUnsplashDownload(image.sourcePage);

    const jpeg = await toJpeg(buffer, contentType);
    if (!jpeg) throw new Error(`unsupported image type "${contentType}"`);

    return {
      buffer: jpeg,
      index,
      caption: captionFor(place, index),
    } satisfies ConvertedImage;
  });

  const output: ConvertedImage[] = [];
  settled.forEach((result, index) => {
    if (result.ok) {
      output.push(result.value);
    } else {
      const message = result.error instanceof Error ? result.error.message : String(result.error);
      notes.push(`${place.name}: image ${index + 1} skipped (${message})`);
    }
  });

  return output;
}

export interface ArchiveOptions {
  /** Adds `[Country]/[City]/_search-summary.pdf` listing every place. */
  includeSummary?: boolean;
  includeImages?: boolean;
  /** Embed the first N images inside the per-place PDF as well. */
  embedImagesInPdf?: number;
  /**
   * Research each place (Wikipedia/Wikidata/Wikivoyage) and have the LLM write
   * a multi-section article for its PDF. Slow but it is the whole point of the
   * export, so it defaults on.
   */
  detailedWriteups?: boolean;
  /**
   * Abandons the archive between places. One place costs a research pass, a
   * handful of image downloads and a PDF render, so this bounds how long a
   * cancel waits to roughly one place.
   */
  signal?: AbortSignal;
  /** Reports the export phases, so a long archive is not a blank wait. */
  progress?: SearchProgress;
  /** User-supplied source pages, mined for passages that mention each place. */
  extraDocs?: ExtraSourceDoc[];
}

export interface ArchiveInput {
  country: string;
  city: string;
  keyword: string;
  places: Place[];
  summarySource?: SearchResult;
  options?: ArchiveOptions;
}

export function archiveFilename(input: Pick<ArchiveInput, 'country' | 'city' | 'keyword'>): string {
  const parts = [input.keyword, input.city, input.country]
    // Commas arrive from multi-type keywords ("museums, parks"). They are legal
    // in a filename but read badly, so they collapse into the word separator.
    .map((part) => sanitizePathSegment(part, 'export')
      .replace(/[,;]+/g, ' ')
      .replace(/\s+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase())
    .filter(Boolean);
  return `${parts.join('_')}.zip`;
}

/**
 * Streams a ZIP laid out as:
 *
 *   [Country]/[City]/_search-summary.pdf
 *   [Country]/[City]/[Place]/[Place]_details.pdf
 *   [Country]/[City]/[Place]/[Place]_01.jpeg
 *   ...
 *   README.txt
 */
export async function streamPlacesArchive(destination: Writable, input: ArchiveInput): Promise<void> {
  await buildInto({ kind: 'zip', stream: destination }, input);
}

export interface FolderResult {
  /** The directory the places were written into. */
  path: string;
  files: number;
  bytes: number;
}

/**
 * Writes the same tree straight into a folder, with no ZIP in between.
 *
 * When the operator has named a folder there is nothing for a ZIP to do: it
 * only writes every byte a second time and leaves the reader to unpack it
 * before they can look at anything. Writing the files where they are wanted
 * also means the folder fills up as the run goes, rather than appearing whole
 * at the end.
 *
 * Nothing is deleted to make room. Files are written over, and anything else
 * already in the folder is left alone -- this path takes a directory the user
 * typed, and a recursive delete there is not worth the convenience.
 *
 * `nest` adds the Country/City folders; a caller that already put them in the
 * path passes false.
 */
export async function writePlacesFolder(
  root: string,
  input: ArchiveInput,
  options: { nest?: boolean } = {},
): Promise<FolderResult> {
  const target = options.nest === false
    ? root
    : path.join(
      root,
      sanitizePathSegment(input.country, 'Unknown Country'),
      sanitizePathSegment(input.city, 'Unknown City'),
    );

  const written = await buildInto({ kind: 'folder', root: target }, input);
  return { path: target, ...written };
}

type Destination =
  | { kind: 'zip'; stream: Writable }
  | { kind: 'folder'; root: string };

/** Somewhere to put one finished file, whether that is a ZIP entry or a path. */
interface OutputSink {
  add(name: string, data: Buffer | string): Promise<void>;
  finish(): Promise<void>;
  written: { files: number; bytes: number };
}

function zipSink(destination: Writable, notes: string[]): OutputSink {
  const archive = archiver('zip', { zlib: { level: 6 } });
  const written = { files: 0, bytes: 0 };

  const closed = new Promise<void>((resolve, reject) => {
    archive.on('error', reject);
    archive.on('warning', (warning) => {
      // Missing-entry warnings are non-fatal; anything else is a real failure.
      if ((warning as NodeJS.ErrnoException).code === 'ENOENT') notes.push(warning.message);
      else reject(warning);
    });
    destination.on('error', reject);
    destination.on('close', resolve);
    archive.on('end', resolve);
  });

  archive.pipe(destination);

  return {
    async add(name, data) {
      archive.append(data, { name });
      written.files += 1;
      written.bytes += Buffer.byteLength(data);
    },
    async finish() {
      await archive.finalize();
      await closed;
    },
    written,
  };
}

function folderSink(root: string): OutputSink {
  const written = { files: 0, bytes: 0 };
  const ensured = new Set<string>();

  return {
    async add(name, data) {
      const full = path.join(root, ...name.split('/'));
      const dir = path.dirname(full);
      if (!ensured.has(dir)) {
        await mkdir(dir, { recursive: true });
        ensured.add(dir);
      }
      await writeFile(full, data);
      written.files += 1;
      written.bytes += Buffer.byteLength(data);
    },
    async finish() {},
    written,
  };
}

async function buildInto(
  destination: Destination,
  input: ArchiveInput,
): Promise<{ files: number; bytes: number }> {
  const options = input.options ?? {};
  const includeImages = options.includeImages ?? true;
  const embedCount = Math.max(
    0,
    Math.min(options.embedImagesInPdf ?? config.pdfEmbedImages, config.limits.maxImagesPerPlace),
  );
  const generatedAt = new Date();
  const notes: string[] = [];

  let withoutPhotos = 0;
  // What actually reached the folder, so the summary and the README describe
  // the same set of places the reader can see.
  const exported: Place[] = [];
  const places = input.places.slice(0, config.limits.maxPlacesPerArchive);
  if (input.places.length > places.length) {
    notes.push(
      `Only the first ${places.length} of ${input.places.length} places were included `
        + `(server limit MAX_PLACES_PER_ARCHIVE=${config.limits.maxPlacesPerArchive}).`,
    );
  }

  // A ZIP carries the Country/City folders inside it; a folder target already
  // has them in its path, so entries go straight in.
  const prefix = destination.kind === 'zip'
    ? `${sanitizePathSegment(input.country, 'Unknown Country')}/${sanitizePathSegment(input.city, 'Unknown City')}`
    : '';
  const at = (...parts: string[]) => [prefix, ...parts].filter(Boolean).join('/');

  const sink = destination.kind === 'zip'
    ? zipSink(destination.stream, notes)
    : folderSink(destination.root);

  // ---- Research + write-up pass ------------------------------------------
  // Runs before any file is appended so the archive streams out in one go.
  let contentByPlace = new Map<string, PlaceContent>();
  let writeupByPlace = new Map<string, PlaceWriteup>();

  options.signal?.throwIfAborted();

  if (options.detailedWriteups !== false) {
    try {
      setStage(options.progress, 'researching', { total: places.length });
      contentByPlace = await fetchContentForPlaces(places);

      const extraDocs = options.extraDocs ?? [];
      for (const place of places) {
        let content = contentByPlace.get(place.id);

        if (extraDocs.length > 0) {
          const excerpts = excerptsForPlace(extraDocs, place.name);
          if (excerpts.length > 0) {
            if (!content) {
              content = { facts: [], sources: [] };
              contentByPlace.set(place.id, content);
            }
            content.extraExtracts = excerpts;
            content.sources.push(
              ...excerpts.map((excerpt) => ({ label: excerpt.label, url: excerpt.url })),
            );
          }
        }

        if (content) place.content = content;
      }

      setStage(options.progress, 'writing', { total: places.length });
      const outcome = await generateWriteups(places, contentByPlace);
      writeupByPlace = outcome.writeups;
      notes.push(...outcome.notes);

      const researched = contentByPlace.size;
      notes.push(
        `Researched ${researched} of ${places.length} place(s) against Wikipedia/Wikidata/Wikivoyage.`,
      );
    } catch (error) {
      notes.push(
        `Detailed write-ups unavailable (${error instanceof Error ? error.message : String(error)}); PDFs use the short summaries.`,
      );
    }
  }

  const dedupeFolder = createNameDeduper();

  let packaged = 0;

  for (const place of places) {
    options.signal?.throwIfAborted();
    setStage(options.progress, 'packaging', {
      done: packaged,
      total: places.length,
      message: `Building ${place.name}`,
    });
    packaged += 1;

    // Photos first. A place whose pictures all fail to arrive is left out
    // entirely rather than exported as a write-up with an empty folder: the
    // search already dropped places with no HD photo on record, but a URL that
    // 404s, times out or turns out not to be an image only shows up here.
    let converted: ConvertedImage[] = [];
    if (includeImages) {
      try {
        converted = await downloadPlaceImages(place, notes);
      } catch (error) {
        notes.push(`${place.name}: image download failed (${error instanceof Error ? error.message : String(error)})`);
      }
    }

    if (includeImages && config.requireImages && converted.length === 0) {
      withoutPhotos += 1;
      notes.push(`${place.name}: left out of the folder — no photo could be downloaded.`);
      continue;
    }

    const safeName = dedupeFolder(sanitizePathSegment(place.name, `place-${place.osmId}`));
    const placeDir = at(safeName);

    const embedded: PdfImageAsset[] = converted
      .slice(0, embedCount)
      .map((image) => ({ buffer: image.buffer, caption: image.caption }));

    try {
      const pdf = await renderPlacePdf(
        place,
        {
          city: input.city,
          country: input.country,
          keyword: input.keyword,
          generatedAt,
          writeup: writeupByPlace.get(place.id),
        },
        embedded,
      );
      await sink.add(`${placeDir}/${safeName}_details.pdf`, pdf);
    } catch (error) {
      notes.push(`${place.name}: PDF generation failed (${error instanceof Error ? error.message : String(error)})`);
    }

    for (const image of converted) {
      const filename = `${safeName}_${String(image.index + 1).padStart(2, '0')}.jpeg`;
      await sink.add(`${placeDir}/${filename}`, image.buffer);
    }

    // Only reachable when photos are not required; otherwise it was skipped.
    if (converted.length === 0 && includeImages) {
      notes.push(`${place.name}: no usable image was found.`);
    }

    exported.push(place);
  }

  if (options.includeSummary !== false && input.summarySource) {
    try {
      const summary = await renderSummaryPdf(
        { ...input.summarySource, places: exported },
        generatedAt,
      );
      await sink.add(at('_search-summary.pdf'), summary);
    } catch (error) {
      notes.push(`Summary PDF failed (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  if (withoutPhotos > 0) {
    notes.push(
      `${withoutPhotos} place(s) were left out because none of their photos could be `
        + 'downloaded. Set REQUIRE_IMAGES=false to export those as write-ups without pictures.',
    );
  }

  const sharp = await loadSharp();
  if (!sharp) {
    notes.push(
      'sharp could not be loaded, so non-JPEG source images were skipped. '
        + (isPackaged
          ? 'The node_modules folder next to the exe is missing or incomplete.'
          : 'Run `npm install sharp` in the backend to enable format conversion.'),
    );
  }

  await sink.add('README.txt', buildReadme(input, exported.length, generatedAt, notes));

  await sink.finish();
  return sink.written;
}

function buildReadme(
  input: ArchiveInput,
  placeCount: number,
  generatedAt: Date,
  notes: string[],
): string {
  const lines: string[] = [
    'SMA Place Finder export',
    '===================',
    '',
    `Search      : ${input.keyword}`,
    `City        : ${input.city}`,
    `Country     : ${input.country}`,
    `Places      : ${placeCount}`,
    `Generated   : ${generatedAt.toISOString()}`,
    '',
    'Folder structure',
    '----------------',
    '[Country]/[City]/_search-summary.pdf   Index of every place in this export',
    '[Country]/[City]/[Place]/              One folder per place',
    '    [Place]_details.pdf                Description, contact details, coordinates',
    '    [Place]_01.jpeg ...                Ultra-HD imagery, converted to JPEG',
    '',
    'Attribution',
    '-----------',
    'Place data (c) OpenStreetMap contributors, licensed under the ODbL.',
    '  https://www.openstreetmap.org/copyright',
    'Imagery comes from Wikimedia Commons / Wikipedia / Wikidata (see each',
    'PDF for the per-image licence and author) and, where configured, Unsplash',
    'under the Unsplash License. Check the licence before any commercial reuse.',
  ];

  if (notes.length > 0) {
    lines.push('', 'Notes', '-----', ...notes.map((note) => `- ${note}`));
  }

  lines.push('');
  return lines.join('\n');
}

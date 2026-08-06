import type { Writable } from 'node:stream';
import archiver from 'archiver';
import { config } from '../config.js';
import { mapLimit } from '../lib/concurrency.js';
import { fetchBuffer } from '../lib/http.js';
import { createNameDeduper, sanitizePathSegment } from '../lib/sanitize.js';
import { fetchContentForPlaces } from './content.js';
import { excerptsForPlace, type ExtraSourceDoc } from './extraSources.js';
import { isAllowedImageUrl, notifyUnsplashDownload } from './images.js';
import { renderPlacePdf, renderSummaryPdf, type PdfImageAsset } from './pdf.js';
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
  } catch {
    sharpModule = null;
  }
  return sharpModule;
}

interface ConvertedImage {
  buffer: Buffer;
  filename: string;
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
      .jpeg({ quality: 92, chromaSubsampling: '4:4:4', mozjpeg: true })
      .toBuffer();
  } catch {
    return /jpe?g/i.test(contentType) ? input : null;
  }
}

async function downloadPlaceImages(
  place: Place,
  baseName: string,
  notes: string[],
): Promise<ConvertedImage[]> {
  const images = place.images.slice(0, config.limits.maxImagesPerPlace);
  if (images.length === 0) return [];

  const settled = await mapLimit(images, 3, async (image, index) => {
    // Never fetch a URL that didn't come from our own image pipeline.
    if (!isAllowedImageUrl(image.downloadUrl)) {
      throw new Error(`image host not allowed: ${safeHost(image.downloadUrl)}`);
    }

    const { buffer, contentType } = await fetchBuffer(image.downloadUrl, {
      timeoutMs: 45_000,
      retries: 1,
    });
    notifyUnsplashDownload(image.sourcePage);

    const jpeg = await toJpeg(buffer, contentType);
    if (!jpeg) throw new Error(`unsupported image type "${contentType}"`);

    return {
      buffer: jpeg,
      filename: `${baseName}_${String(index + 1).padStart(2, '0')}.jpeg`,
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
    .map((part) => sanitizePathSegment(part, 'export').replace(/\s+/g, '-').toLowerCase())
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
  const options = input.options ?? {};
  const includeImages = options.includeImages ?? true;
  const embedCount = Math.max(
    0,
    Math.min(options.embedImagesInPdf ?? config.pdfEmbedImages, config.limits.maxImagesPerPlace),
  );
  const generatedAt = new Date();
  const notes: string[] = [];

  const places = input.places.slice(0, config.limits.maxPlacesPerArchive);
  if (input.places.length > places.length) {
    notes.push(
      `Only the first ${places.length} of ${input.places.length} places were included `
        + `(server limit MAX_PLACES_PER_ARCHIVE=${config.limits.maxPlacesPerArchive}).`,
    );
  }

  const countryDir = sanitizePathSegment(input.country, 'Unknown Country');
  const cityDir = sanitizePathSegment(input.city, 'Unknown City');
  const cityRoot = `${countryDir}/${cityDir}`;

  const archive = archiver('zip', { zlib: { level: 6 } });

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

  // ---- Research + write-up pass ------------------------------------------
  // Runs before any file is appended so the archive streams out in one go.
  let contentByPlace = new Map<string, PlaceContent>();
  let writeupByPlace = new Map<string, PlaceWriteup>();

  if (options.detailedWriteups !== false) {
    try {
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

  for (const place of places) {
    const safeName = dedupeFolder(sanitizePathSegment(place.name, `place-${place.osmId}`));
    const placeDir = `${cityRoot}/${safeName}`;

    let converted: ConvertedImage[] = [];
    if (includeImages) {
      try {
        converted = await downloadPlaceImages(place, safeName, notes);
      } catch (error) {
        notes.push(`${place.name}: image download failed (${error instanceof Error ? error.message : String(error)})`);
      }
    }

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
      archive.append(pdf, { name: `${placeDir}/${safeName}_details.pdf` });
    } catch (error) {
      notes.push(`${place.name}: PDF generation failed (${error instanceof Error ? error.message : String(error)})`);
    }

    for (const image of converted) {
      archive.append(image.buffer, { name: `${placeDir}/${image.filename}` });
    }

    if (converted.length === 0 && includeImages) {
      notes.push(`${place.name}: no usable image was found.`);
    }
  }

  if (options.includeSummary !== false && input.summarySource) {
    try {
      const summary = await renderSummaryPdf(
        { ...input.summarySource, places },
        generatedAt,
      );
      archive.append(summary, { name: `${cityRoot}/_search-summary.pdf` });
    } catch (error) {
      notes.push(`Summary PDF failed (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  const sharp = await loadSharp();
  if (!sharp) {
    notes.push(
      'sharp is not installed, so non-JPEG source images were skipped. '
        + 'Run `npm install sharp` in the backend to enable format conversion.',
    );
  }

  archive.append(buildReadme(input, places.length, generatedAt, notes), { name: 'README.txt' });

  await archive.finalize();
  await closed;
}

function buildReadme(
  input: ArchiveInput,
  placeCount: number,
  generatedAt: Date,
  notes: string[],
): string {
  const lines: string[] = [
    'Place Finder export',
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

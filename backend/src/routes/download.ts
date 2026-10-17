import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { rateLimit } from '../lib/rateLimit.js';
import { archiveFilename, streamPlacesArchive, writePlacesFolder } from '../services/archive.js';
import { crawlTourismSource } from '../services/siteCrawl.js';
import { countryPages } from '../services/countryPages.js';
import { getStore } from '../services/cache.js';
import type { ImageSource, Place, SearchResult } from '../types.js';

export const downloadRouter = Router();

const imageSchema = z.object({
  url: z.string().url(),
  downloadUrl: z.string().url(),
  thumbUrl: z.string().url(),
  width: z.number().optional(),
  height: z.number().optional(),
  // Kept in step with the ImageSource union in types.ts — a hand-copied
  // subset previously rejected most real results on this code path.
  source: z.enum([
    'wikidata', 'wikipedia', 'commons', 'commons-category', 'commons-geo',
    'wikipedia-article', 'flickr', 'europeana', 'openverse', 'unsplash', 'google', 'brave', 'tourism',
  ] as const satisfies readonly ImageSource[]),
  title: z.string().max(200).optional(),
  credit: z.string().max(300).optional(),
  license: z.string().max(200).optional(),
  sourcePage: z.string().url().optional(),
});

const placeSchema = z.object({
  id: z.string().max(80),
  osmType: z.enum(['node', 'way', 'relation']),
  osmId: z.number(),
  name: z.string().min(1).max(200),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  tags: z.record(z.string()).default({}),
  category: z.string().max(60).default('custom'),
  categoryLabel: z.string().max(80).default('Place'),
  summary: z.string().max(4000).default(''),
  contact: z
    .object({
      phone: z.string().max(120).optional(),
      email: z.string().max(200).optional(),
      website: z.string().max(500).optional(),
      address: z.string().max(400).optional(),
      openingHours: z.string().max(300).optional(),
    })
    .default({}),
  images: z.array(imageSchema).max(config.limits.maxImagesPerPlace).default([]),
  travelLinks: z
    .array(
      z.object({
        id: z.string().max(40),
        label: z.string().max(60),
        url: z.string().url(),
        kind: z.enum(['reviews', 'tours', 'booking', 'guide', 'reference']),
        generic: z.boolean().optional(),
      }),
    )
    .max(12)
    .default([]),
  qualityScore: z.number().default(50),
  llmProcessed: z.boolean().default(false),
  wikipediaUrl: z.string().url().optional(),
  wikidataUrl: z.string().url().optional(),
  googleMapsUrl: z.string().url(),
  osmUrl: z.string().url(),
});

const downloadBodySchema = z.union([
  // Preferred: reference a server-side search so we trust our own data.
  z.object({
    searchId: z.string().min(1).max(80),
    placeIds: z.array(z.string().max(80)).max(config.limits.maxPlacesPerArchive).optional(),
    includeImages: z.boolean().optional(),
    includeSummary: z.boolean().optional(),
    detailedWriteups: z.boolean().optional(),
    /** Absolute folder on the server. When set, the places are written into
     *  it as plain folders and nothing is zipped or streamed back. */
    savePath: z.string().trim().max(500).optional(),
  }),
  // Fallback: the client sends the payload it already has.
  z.object({
    country: z.string().trim().min(1).max(120),
    city: z.string().trim().min(1).max(120),
    keyword: z.string().trim().min(1).max(120),
    places: z.array(placeSchema).min(1).max(config.limits.maxPlacesPerArchive),
    includeImages: z.boolean().optional(),
    includeSummary: z.boolean().optional(),
    detailedWriteups: z.boolean().optional(),
    /** Absolute folder on the server. When set, the places are written into
     *  it as plain folders and nothing is zipped or streamed back. */
    savePath: z.string().trim().max(500).optional(),
  }),
]);

const downloadLimiter = rateLimit({
  max: 6,
  windowMs: 60_000,
  message: 'Download rate limit reached. Wait a minute before trying again.',
});

interface ResolvedArchive {
  country: string;
  city: string;
  keyword: string;
  places: Place[];
  summarySource?: SearchResult;
}

async function resolveRequest(body: z.infer<typeof downloadBodySchema>): Promise<ResolvedArchive | { error: string; status: number }> {
  if ('searchId' in body) {
    const store = await getStore();
    const result = await store.getById(body.searchId);
    if (!result) {
      return {
        status: 404,
        error: 'That search is no longer cached. Re-run the search and download again.',
      };
    }

    const wanted = body.placeIds && body.placeIds.length > 0 ? new Set(body.placeIds) : null;
    const places = wanted ? result.places.filter((place) => wanted.has(place.id)) : result.places;

    if (places.length === 0) {
      return { status: 400, error: 'None of the requested places were part of that search.' };
    }

    return {
      country: result.area.country || result.query.country,
      city: result.area.city || result.query.city,
      keyword: result.query.keyword,
      places,
      summarySource: result,
    };
  }

  return {
    country: body.country,
    city: body.city,
    keyword: body.keyword,
    places: body.places as Place[],
  };
}

downloadRouter.post('/download', downloadLimiter, async (req, res, next) => {
  const parsed = downloadBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'Invalid download request.',
      details: parsed.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      })),
    });
    return;
  }

  let resolved: ResolvedArchive;
  try {
    const outcome = await resolveRequest(parsed.data);
    if ('error' in outcome) {
      res.status(outcome.status).json({ error: outcome.error });
      return;
    }
    resolved = outcome;
  } catch (error) {
    next(error);
    return;
  }

  const filename = archiveFilename(resolved);

  // A single search writes its PDFs here too, so the country's official
  // tourism site is read for this city and mined for passages, exactly as a
  // batch run does.
  let extraDocs;
  if (config.crawl.tourismSources && parsed.data.detailedWriteups !== false) {
    const official = await crawlTourismSource(
      resolved.summarySource?.area?.countryCode,
      resolved.city,
    );
    if (official.docs.length > 0) extraDocs = official.docs;
  }
  // The country's Wikivoyage guide and Wikipedia article, mined the same way.
  if (parsed.data.detailedWriteups !== false) {
    const area = resolved.summarySource?.area;
    const pages = await countryPages(area?.countryCode, area?.country ?? resolved.country);
    if (pages.docs.length > 0) extraDocs = [...(extraDocs ?? []), ...pages.docs];
  }

  const options = {
    includeImages: parsed.data.includeImages ?? true,
    includeSummary: parsed.data.includeSummary ?? true,
    detailedWriteups: parsed.data.detailedWriteups ?? true,
    extraDocs,
  };

  // ---- Save on the server ------------------------------------------------
  // The browser cannot choose a folder, so when the operator has set one we
  // write the places there directly, one folder each, and reply with the path.
  // No ZIP is made on this path; README.txt is written last, so a folder
  // without one is an export that did not finish.
  const savePath = parsed.data.savePath?.trim();
  if (savePath) {
    if (!path.isAbsolute(savePath)) {
      res.status(400).json({ error: `Save folder must be an absolute path (got "${savePath}").` });
      return;
    }

    try {
      await mkdir(savePath, { recursive: true });
      const info = await stat(savePath);
      if (!info.isDirectory()) throw new Error(`${savePath} is not a folder`);

      // The operator named a folder, so the places go into it directly. Zipping
      // them first only wrote every byte twice and left them to unpack it.
      const written = await writePlacesFolder(savePath, { ...resolved, options });

      res.json({
        saved: true,
        path: written.path,
        filename: path.basename(written.path),
        bytes: written.bytes,
        files: written.files,
        places: resolved.places.length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[download] save to disk failed:', message);
      res.status(/EACCES|EPERM|ENOENT|not a folder/i.test(message) ? 400 : 500)
        .json({ error: `Could not save to ${savePath}: ${message}` });
    }
    return;
  }

  // ---- Stream to the browser ---------------------------------------------
  res.status(200);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  // Building the archive involves dozens of upstream fetches; keep proxies
  // from buffering it and let the browser show progress as bytes arrive.
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');

  try {
    await streamPlacesArchive(res, { ...resolved, options });
  } catch (error) {
    console.error('[download] archive failed:', error);
    // Headers are already out, so the only honest signal is a broken stream —
    // the client sees a truncated ZIP rather than a silently corrupt one.
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to build the archive.' });
    } else {
      res.destroy(error instanceof Error ? error : new Error('archive failed'));
    }
  }
});

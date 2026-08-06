import { config } from '../config.js';
import { chunk, mapLimitSettled } from '../lib/concurrency.js';
import { fetchJson, qs } from '../lib/http.js';
import { cleanText } from '../lib/sanitize.js';
import type { Place, PlaceContent, WikidataFact } from '../types.js';

const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';

/**
 * Curated Wikidata properties worth putting in front of a reader. Ordered —
 * this is the order they appear in the PDF fact table.
 */
const FACT_PROPERTIES: Array<{ id: string; label: string }> = [
  { id: 'P31', label: 'Instance of' },
  { id: 'P571', label: 'Founded / built' },
  { id: 'P1619', label: 'Officially opened' },
  { id: 'P84', label: 'Architect' },
  { id: 'P149', label: 'Architectural style' },
  { id: 'P138', label: 'Named after' },
  { id: 'P170', label: 'Creator' },
  { id: 'P127', label: 'Owned by' },
  { id: 'P137', label: 'Operator' },
  { id: 'P1435', label: 'Heritage status' },
  { id: 'P2048', label: 'Height' },
  { id: 'P2046', label: 'Area' },
  { id: 'P1174', label: 'Visitors per year' },
  { id: 'P856', label: 'Official website' },
  { id: 'P131', label: 'Located in' },
  { id: 'P17', label: 'Country' },
];

const FACT_PROPERTY_IDS = new Set(FACT_PROPERTIES.map((property) => property.id));

interface WikidataSnakValue {
  'entity-type'?: string;
  id?: string;
  time?: string;
  amount?: string;
  unit?: string;
  text?: string;
  language?: string;
}

interface WikidataEntity {
  descriptions?: Record<string, { value?: string }>;
  sitelinks?: Record<string, { title?: string }>;
  claims?: Record<
    string,
    Array<{ mainsnak?: { datatype?: string; datavalue?: { value?: unknown; type?: string } } }>
  >;
}

/** Wikidata times look like "+1851-01-01T00:00:00Z" with a precision field. */
function formatTime(raw: string): string {
  const match = /^([+-])(\d{4,})-(\d{2})-(\d{2})/.exec(raw);
  if (!match) return raw;
  const [, sign, year, month, day] = match;
  const era = sign === '-' ? ' BC' : '';
  const y = String(Number(year));
  if (month === '00' || day === '00') return `${y}${era}`;
  return `${y}-${month}-${day}${era}`;
}

function formatQuantity(value: WikidataSnakValue): string {
  const amount = value.amount ? value.amount.replace(/^\+/, '') : '';
  // Units arrive as entity URIs; the numeric value alone is still useful.
  return amount;
}

/**
 * Reads a statement's value. Entity references come back as Q-ids which are
 * resolved to labels in a second batched pass by the caller.
 */
function readSnak(
  snak: { datatype?: string; datavalue?: { value?: unknown; type?: string } } | undefined,
): { text?: string; entityId?: string } {
  const datavalue = snak?.datavalue;
  if (!datavalue) return {};
  const value = datavalue.value;

  if (datavalue.type === 'wikibase-entityid') {
    const id = (value as WikidataSnakValue)?.id;
    return id ? { entityId: id } : {};
  }
  if (datavalue.type === 'time') {
    const time = (value as WikidataSnakValue)?.time;
    return time ? { text: formatTime(time) } : {};
  }
  if (datavalue.type === 'quantity') {
    const quantity = formatQuantity(value as WikidataSnakValue);
    return quantity ? { text: quantity } : {};
  }
  if (datavalue.type === 'monolingualtext') {
    const text = (value as WikidataSnakValue)?.text;
    return text ? { text } : {};
  }
  if (typeof value === 'string') return { text: value };
  return {};
}

async function fetchEntities(ids: string[]): Promise<Record<string, WikidataEntity>> {
  const entities: Record<string, WikidataEntity> = {};
  if (ids.length === 0) return entities;

  for (const batch of chunk([...new Set(ids)], 45)) {
    const url = `${WIKIDATA_API}?${qs({
      action: 'wbgetentities',
      format: 'json',
      props: 'claims|descriptions|sitelinks',
      languages: 'en',
      sitefilter: 'enwiki|enwikivoyage',
      ids: batch.join('|'),
      origin: '*',
    })}`;

    try {
      const payload = await fetchJson<{ entities?: Record<string, WikidataEntity> }>(url, {
        timeoutMs: 25_000,
        retries: 1,
      });
      Object.assign(entities, payload.entities ?? {});
    } catch {
      // A missing entity just means fewer facts.
    }
  }

  return entities;
}

/** Second pass: turn referenced Q-ids into human-readable English labels. */
async function fetchLabels(ids: string[]): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  if (ids.length === 0) return labels;

  for (const batch of chunk([...new Set(ids)], 45)) {
    const url = `${WIKIDATA_API}?${qs({
      action: 'wbgetentities',
      format: 'json',
      props: 'labels',
      languages: 'en',
      ids: batch.join('|'),
      origin: '*',
    })}`;

    try {
      const payload = await fetchJson<{
        entities?: Record<string, { labels?: { en?: { value?: string } } }>;
      }>(url, { timeoutMs: 25_000, retries: 1 });

      for (const [id, entity] of Object.entries(payload.entities ?? {})) {
        const label = entity.labels?.en?.value;
        if (label) labels.set(id, label);
      }
    } catch {
      // Fall back to showing the raw Q-id.
    }
  }

  return labels;
}

/** Full plain-text article body from any MediaWiki wiki. */
async function fetchExtract(host: string, title: string): Promise<string | undefined> {
  const url = `https://${host}/w/api.php?${qs({
    action: 'query',
    format: 'json',
    formatversion: 2,
    prop: 'extracts',
    explaintext: 1,
    exsectionformat: 'plain',
    redirects: 1,
    titles: title,
    origin: '*',
  })}`;

  try {
    const payload = await fetchJson<{
      query?: { pages?: Array<{ extract?: string; missing?: boolean }> };
    }>(url, { timeoutMs: 30_000, retries: 1 });

    const extract = payload.query?.pages?.[0]?.extract;
    if (!extract) return undefined;
    return cleanText(extract, config.content.maxExtractChars);
  } catch {
    return undefined;
  }
}

function parseWikipediaTag(tag: string | undefined): { lang: string; title: string } | null {
  if (!tag?.trim()) return null;
  const match = /^([a-z-]{2,12}):(.+)$/i.exec(tag.trim());
  if (match) return { lang: match[1]!.toLowerCase(), title: match[2]! };
  return { lang: 'en', title: tag.trim() };
}

/**
 * Gathers long-form research for a batch of places.
 *
 * Called from the download pipeline rather than search: a full Wikipedia
 * extract per place is a lot of bytes nobody reads until they export.
 */
export async function fetchContentForPlaces(places: Place[]): Promise<Map<string, PlaceContent>> {
  const result = new Map<string, PlaceContent>();
  if (!config.content.enabled || places.length === 0) return result;

  // --- Pass 1: Wikidata entities (batched) --------------------------------
  const qidByPlace = new Map<string, string>();
  for (const place of places) {
    const qid = place.tags.wikidata?.trim();
    if (qid && /^Q\d+$/.test(qid)) qidByPlace.set(place.id, qid);
  }

  const entities = await fetchEntities([...qidByPlace.values()]);

  // Collect every referenced entity so labels can be fetched in one go.
  const referenced: string[] = [];
  for (const entity of Object.values(entities)) {
    for (const [propertyId, claims] of Object.entries(entity.claims ?? {})) {
      if (!FACT_PROPERTY_IDS.has(propertyId)) continue;
      for (const claim of claims.slice(0, 4)) {
        const { entityId } = readSnak(claim.mainsnak);
        if (entityId) referenced.push(entityId);
      }
    }
  }
  const labels = await fetchLabels(referenced);

  // --- Pass 2: article extracts (per place, concurrency-limited) ----------
  await mapLimitSettled(places, 4, async (place) => {
    const qid = qidByPlace.get(place.id);
    const entity = qid ? entities[qid] : undefined;

    const facts: WikidataFact[] = [];
    for (const property of FACT_PROPERTIES) {
      const claims = entity?.claims?.[property.id];
      if (!claims?.length) continue;

      const values: string[] = [];
      for (const claim of claims.slice(0, 3)) {
        const { text, entityId } = readSnak(claim.mainsnak);
        if (entityId) values.push(labels.get(entityId) ?? entityId);
        else if (text) values.push(text);
      }
      if (values.length > 0) {
        facts.push({ property: property.id, label: property.label, value: values.join(', ') });
      }
    }

    const sources: PlaceContent['sources'] = [];

    // Prefer the Wikidata sitelink over the OSM tag — it is better maintained.
    const enwikiTitle = entity?.sitelinks?.enwiki?.title;
    const osmWiki = parseWikipediaTag(place.tags.wikipedia ?? place.tags['wikipedia:en']);
    const wikiHost = enwikiTitle ? 'en.wikipedia.org' : `${osmWiki?.lang ?? 'en'}.wikipedia.org`;
    const wikiTitle = enwikiTitle ?? osmWiki?.title;

    let wikipediaExtract: string | undefined;
    let wikipediaUrl: string | undefined;
    if (wikiTitle) {
      wikipediaExtract = await fetchExtract(wikiHost, wikiTitle);
      wikipediaUrl = `https://${wikiHost}/wiki/${encodeURIComponent(wikiTitle.replace(/ /g, '_'))}`;
      if (wikipediaExtract) sources.push({ label: `Wikipedia — ${wikiTitle}`, url: wikipediaUrl });
    }

    let wikivoyageExtract: string | undefined;
    let wikivoyageUrl: string | undefined;
    const voyageTitle = entity?.sitelinks?.enwikivoyage?.title;
    if (config.content.wikivoyage && voyageTitle) {
      wikivoyageExtract = await fetchExtract('en.wikivoyage.org', voyageTitle);
      wikivoyageUrl = `https://en.wikivoyage.org/wiki/${encodeURIComponent(voyageTitle.replace(/ /g, '_'))}`;
      if (wikivoyageExtract) {
        sources.push({ label: `Wikivoyage — ${voyageTitle}`, url: wikivoyageUrl });
      }
    }

    if (qid) sources.push({ label: `Wikidata — ${qid}`, url: `https://www.wikidata.org/wiki/${qid}` });
    sources.push({
      label: `OpenStreetMap — ${place.id}`,
      url: `https://www.openstreetmap.org/${place.osmType}/${place.osmId}`,
    });

    const commonsCategory =
      cleanText(place.tags.wikimedia_commons, 200).replace(/^Category:/i, '') || undefined;

    const content: PlaceContent = {
      wikipediaExtract,
      wikipediaUrl,
      wikivoyageExtract,
      wikivoyageUrl,
      wikidataDescription: cleanText(entity?.descriptions?.en?.value, 400) || undefined,
      commonsCategory,
      facts,
      sources,
    };

    // Only record places we actually learned something about.
    const hasContent =
      Boolean(content.wikipediaExtract)
      || Boolean(content.wikivoyageExtract)
      || Boolean(content.wikidataDescription)
      || content.facts.length > 0;

    if (hasContent) result.set(place.id, content);
  });

  return result;
}

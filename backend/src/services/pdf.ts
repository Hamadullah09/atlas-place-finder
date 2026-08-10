import { existsSync } from 'node:fs';
import PDFDocument from 'pdfkit';
import { config } from '../config.js';
import { isMostlyNonLatin, toLatin1Safe } from '../lib/sanitize.js';
import { isSafeHttpUrl } from './llm.js';
import type { Place, PlaceWriteup, SearchResult } from '../types.js';

const COLORS = {
  ink: '#111827',
  muted: '#6b7280',
  accent: '#0f766e',
  rule: '#e5e7eb',
  chip: '#f0fdfa',
} as const;

const PAGE = { size: 'A4' as const, margin: 48 };

/**
 * pdfkit's bundled fonts only cover WinAnsi. If the operator supplies Unicode
 * TTFs we register them and pass text through untouched; otherwise every
 * string is transliterated to Latin-1 so the PDF never contains mojibake.
 */
function resolveFonts(doc: PDFKit.PDFDocument): { regular: string; bold: string; unicode: boolean } {
  const regularPath = config.pdfFontPath;
  const boldPath = config.pdfFontBoldPath || config.pdfFontPath;

  if (regularPath && existsSync(regularPath)) {
    try {
      doc.registerFont('Body', regularPath);
      doc.registerFont('BodyBold', boldPath && existsSync(boldPath) ? boldPath : regularPath);
      return { regular: 'Body', bold: 'BodyBold', unicode: true };
    } catch {
      // Fall through to the core fonts.
    }
  }

  return { regular: 'Helvetica', bold: 'Helvetica-Bold', unicode: false };
}

class PdfWriter {
  readonly doc: PDFKit.PDFDocument;
  private readonly fonts: { regular: string; bold: string; unicode: boolean };
  private readonly chunks: Buffer[] = [];
  private readonly done: Promise<Buffer>;

  constructor(title: string, author = 'Place Finder') {
    this.doc = new PDFDocument({
      size: PAGE.size,
      margin: PAGE.margin,
      bufferPages: true,
      info: { Title: title.slice(0, 200), Author: author, Creator: 'Place Finder' },
    });

    this.fonts = resolveFonts(this.doc);

    this.doc.on('data', (chunk: Buffer) => this.chunks.push(chunk));
    this.done = new Promise<Buffer>((resolve, reject) => {
      this.doc.on('end', () => resolve(Buffer.concat(this.chunks)));
      this.doc.on('error', reject);
    });
  }

  /**
   * Every string that reaches the PDF passes through here. `multiline` keeps
   * line breaks (the raw-tag dump needs them); everything else is collapsed to
   * a single line so a stray newline in an OSM tag can't break the layout.
   */
  text(value: string, multiline = false): string {
    if (!value) return '';
    if (this.fonts.unicode) {
      return multiline ? value : value.replace(/\s+/g, ' ').trim();
    }
    return toLatin1Safe(value, multiline);
  }

  /** True when a string would be lost entirely by Latin-1 transliteration. */
  wouldBeLost(value: string): boolean {
    return !this.fonts.unicode && isMostlyNonLatin(value) && toLatin1Safe(value).length < 2;
  }

  /**
   * Whether what survives transliteration still says something. A value that
   * reduces to punctuation, separators or a bare number carries no meaning
   * once its script has been stripped.
   */
  hasReadableContent(value: string): boolean {
    const rendered = this.text(value);
    if (!rendered) return false;
    const letters = rendered.replace(/[^A-Za-z]/g, '');
    if (letters.length >= 2) return true;
    // Keep pure identifiers (phone numbers, postcodes) that are meant to be digits.
    return /\d{4,}/.test(rendered);
  }

  get contentWidth(): number {
    return this.doc.page.width - PAGE.margin * 2;
  }

  ensureSpace(height: number): void {
    if (this.doc.y + height > this.doc.page.height - PAGE.margin - 24) this.doc.addPage();
  }

  heading(label: string): void {
    this.ensureSpace(46);
    this.doc
      .moveDown(0.9)
      .font(this.fonts.bold)
      .fontSize(11)
      .fillColor(COLORS.accent)
      .text(this.text(label.toUpperCase()), { characterSpacing: 0.8 });

    const y = this.doc.y + 3;
    this.doc
      .moveTo(PAGE.margin, y)
      .lineTo(PAGE.margin + this.contentWidth, y)
      .lineWidth(0.7)
      .strokeColor(COLORS.rule)
      .stroke();
    this.doc.moveDown(0.55);
  }

  paragraph(
    value: string,
    options: {
      size?: number;
      color?: string;
      bold?: boolean;
      multiline?: boolean;
      /** Set for prose: drops text that transliteration reduced to fragments. */
      requireReadable?: boolean;
    } = {},
  ): void {
    const body = this.text(value, options.multiline ?? false);
    if (!body) return;
    if (options.requireReadable && !this.hasReadableContent(value)) return;
    this.ensureSpace(28);
    this.doc.x = PAGE.margin;
    this.doc
      .font(options.bold ? this.fonts.bold : this.fonts.regular)
      .fontSize(options.size ?? 10.5)
      .fillColor(options.color ?? COLORS.ink)
      .text(body, { align: 'left', lineGap: 2.2, width: this.contentWidth });
  }

  /** Two-column "Label: value" row, with an optional hyperlink on the value. */
  field(label: string, value: string | undefined, link?: string): void {
    if (!value) return;
    // Transliterating a CJK/Arabic value leaves separators only ("299 , ,").
    // Printing that is worse than omitting the row.
    if (!this.hasReadableContent(value)) return;
    this.ensureSpace(22);

    const labelWidth = 108;
    const y = this.doc.y;

    this.doc
      .font(this.fonts.bold)
      .fontSize(9.5)
      .fillColor(COLORS.muted)
      .text(this.text(label), PAGE.margin, y, { width: labelWidth, continued: false });

    const valueOptions: PDFKit.Mixins.TextOptions = {
      width: this.contentWidth - labelWidth,
      lineGap: 1.5,
    };
    if (link && isSafeHttpUrl(link)) {
      valueOptions.link = link;
      valueOptions.underline = true;
    }

    this.doc
      .font(this.fonts.regular)
      .fontSize(10)
      .fillColor(link && isSafeHttpUrl(link) ? COLORS.accent : COLORS.ink)
      .text(this.text(value), PAGE.margin + labelWidth, y, valueOptions);

    this.doc.moveDown(0.35);
    this.doc.x = PAGE.margin;
  }

  /** Bulleted list — used for the write-up's highlights section. */
  bullets(items: string[]): void {
    for (const item of items) {
      const body = this.text(item);
      if (!body) continue;
      this.ensureSpace(24);
      const y = this.doc.y;

      this.doc
        .font(this.fonts.regular)
        .fontSize(10.5)
        .fillColor(COLORS.accent)
        .text('•', PAGE.margin + 2, y, { width: 10, lineBreak: false });

      this.doc
        .font(this.fonts.regular)
        .fontSize(10.5)
        .fillColor(COLORS.ink)
        .text(body, PAGE.margin + 16, y, { width: this.contentWidth - 16, lineGap: 2 });

      this.doc.moveDown(0.25);
      this.doc.x = PAGE.margin;
    }
  }

  image(buffer: Buffer, caption?: string): boolean {
    const maxHeight = 250;
    this.ensureSpace(maxHeight + (caption ? 26 : 8));
    try {
      this.doc.image(buffer, PAGE.margin, this.doc.y, {
        fit: [this.contentWidth, maxHeight],
        align: 'center',
      });
      this.doc.y += maxHeight + 6;
    } catch {
      return false; // corrupt or unsupported payload — skip silently
    }

    if (caption) {
      this.doc
        .font(this.fonts.regular)
        .fontSize(8)
        .fillColor(COLORS.muted)
        .text(this.text(caption), PAGE.margin, this.doc.y, { width: this.contentWidth });
    }
    this.doc.moveDown(0.5);
    this.doc.x = PAGE.margin;
    return true;
  }

  titleBlock(title: string, subtitle: string, eyebrow?: string): void {
    if (eyebrow) {
      this.doc
        .font(this.fonts.bold)
        .fontSize(9)
        .fillColor(COLORS.accent)
        .text(this.text(eyebrow.toUpperCase()), { characterSpacing: 1.1 });
      this.doc.moveDown(0.25);
    }

    this.doc
      .font(this.fonts.bold)
      .fontSize(21)
      .fillColor(COLORS.ink)
      .text(this.text(title) || 'Untitled place', { lineGap: 2 });

    if (subtitle) {
      this.doc
        .font(this.fonts.regular)
        .fontSize(10.5)
        .fillColor(COLORS.muted)
        .text(this.text(subtitle));
    }

    this.doc.moveDown(0.7);
  }

  /** Page numbers + attribution footer, applied to every buffered page. */
  finishWithFooters(footerText: string): void {
    const range = this.doc.bufferedPageRange();

    for (let index = 0; index < range.count; index += 1) {
      this.doc.switchToPage(range.start + index);

      // Writing below the bottom margin makes pdfkit paginate and dump the
      // footer at the top of a fresh page. Drop the margin for the duration of
      // the write, then put it back.
      const bottomMargin = this.doc.page.margins.bottom;
      this.doc.page.margins.bottom = 0;

      const y = this.doc.page.height - bottomMargin + 6;
      this.doc
        .font(this.fonts.regular)
        .fontSize(7.5)
        .fillColor(COLORS.muted)
        .text(this.text(footerText), PAGE.margin, y, {
          width: this.contentWidth - 44,
          lineBreak: false,
          ellipsis: true,
        })
        .text(`${index + 1} / ${range.count}`, PAGE.margin + this.contentWidth - 40, y, {
          width: 40,
          align: 'right',
          lineBreak: false,
        });

      this.doc.page.margins.bottom = bottomMargin;
    }

    this.doc.flushPages();
  }

  async end(): Promise<Buffer> {
    this.doc.end();
    return this.done;
  }
}

export interface PdfImageAsset {
  buffer: Buffer;
  caption?: string;
}

export interface PdfMeta {
  city: string;
  country: string;
  keyword: string;
  generatedAt: Date;
  /** Multi-section article generated by services/writeup.ts. */
  writeup?: PlaceWriteup;
}

function formatCoordinate(lat: number, lon: number): string {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(6)}° ${ns}, ${Math.abs(lon).toFixed(6)}° ${ew}  (${lat.toFixed(6)}, ${lon.toFixed(6)})`;
}

const FOOTER = 'Place data © OpenStreetMap contributors (ODbL). Imagery credited per file. Generated by Place Finder.';
const FOOTER_GOOGLE = 'Place data and imagery via the Google Maps Platform. Generated by Place Finder.';

/**
 * The archive keeps the real (possibly Urdu/CJK) name as the folder name, but
 * the core PDF fonts can't draw it. Fall back through the English/international
 * name tags before giving up on a label entirely.
 */
function pdfDisplayName(writer: PdfWriter, place: Place): { name: string; substituted: boolean } {
  const primary = writer.text(place.name);
  if (primary.length > 1) return { name: primary, substituted: false };

  for (const key of ['name:en', 'int_name', 'official_name:en', 'alt_name']) {
    const candidate = writer.text(place.tags[key] ?? '');
    if (candidate.length > 1) return { name: candidate, substituted: true };
  }

  return {
    name: `${place.categoryLabel} (OSM ${place.osmType}/${place.osmId})`,
    substituted: true,
  };
}

/** The heuristic summary embeds the raw name, which suffers the same loss. */
function repairSummary(summary: string, rawName: string, displayName: string): string {
  if (!summary || !rawName || rawName === displayName) return summary;
  return summary.split(rawName).join(displayName).replace(/^\s*is\s/i, `${displayName} is `);
}

/** One PDF per place — this is the `[Place Name]_details.pdf` in the archive. */
export async function renderPlacePdf(
  place: Place,
  meta: PdfMeta,
  images: PdfImageAsset[] = [],
): Promise<Buffer> {
  const writer = new PdfWriter(`${place.name} — details`);
  const { name: displayName, substituted } = pdfDisplayName(writer, place);

  writer.titleBlock(
    displayName,
    `${place.categoryLabel} · ${meta.city}, ${meta.country}`,
    meta.keyword,
  );

  if (substituted) {
    // The original name is deliberately not interpolated here — it would be
    // stripped by the same transliteration and leave an empty quote.
    writer.paragraph(
      'Note: this place is mapped under a name the default PDF font cannot render, so a '
        + 'substitute label is shown above. The ZIP folder and the raw tag list below both keep '
        + 'the original. Set PDF_FONT_PATH to a Unicode TTF such as Noto Sans to render it.',
      { size: 9, color: COLORS.muted },
    );
    writer.doc.moveDown(0.4);
  }

  const hero = images[0];
  if (hero) writer.image(hero.buffer, hero.caption);

  // ---- The long-form article ---------------------------------------------
  const writeup = meta.writeup;

  /** Emits a section only when its prose survives font transliteration. */
  const section = (title: string, body: string | undefined): void => {
    const text = repairSummary(body ?? '', place.name, displayName);
    if (!text || !writer.hasReadableContent(text)) return;
    writer.heading(title);
    writer.paragraph(text);
  };

  if (writeup) {
    const overview = repairSummary(writeup.overview, place.name, displayName);
    const fallbackOverview = repairSummary(place.summary, place.name, displayName);
    writer.heading('Overview');
    writer.paragraph(
      (writer.hasReadableContent(overview) && overview)
        || (writer.hasReadableContent(fallbackOverview) && fallbackOverview)
        || 'No English-language description is available for this location.',
    );

    section('History', writeup.history);
    section('Architecture & design', writeup.architecture);
    section('Significance', writeup.context);

    const highlights = writeup.highlights
      .map((item) => repairSummary(item, place.name, displayName))
      .filter((item) => writer.hasReadableContent(item));
    if (highlights.length > 0) {
      writer.heading('Highlights');
      writer.bullets(highlights);
    }

    section('Visiting', writeup.visiting);
    section('Practical information', writeup.practical);
  } else {
    const summary = repairSummary(place.summary, place.name, displayName);
    writer.heading('Description');
    writer.paragraph(
      (writer.hasReadableContent(summary) && summary)
        || 'No English-language description is available for this location.',
    );
  }

  // ---- Sourced facts ------------------------------------------------------
  const facts = place.content?.facts ?? [];
  if (facts.length > 0) {
    writer.heading('Key facts');
    for (const fact of facts) writer.field(fact.label, fact.value);
  }

  writer.heading('Contact details');
  const contact = place.contact;
  const hasContact = Boolean(
    contact.phone || contact.email || contact.website || contact.address || contact.openingHours,
  );
  if (hasContact) {
    writer.field('Address', contact.address);
    writer.field('Phone', contact.phone);
    writer.field('Email', contact.email, contact.email ? `mailto:${contact.email}` : undefined);
    writer.field('Website', contact.website, contact.website);
    writer.field('Opening hours', contact.openingHours);
  } else {
    writer.paragraph('No contact details are recorded for this place in OpenStreetMap.', {
      color: COLORS.muted,
    });
  }

  const isGooglePlace = place.id.startsWith('google/');

  writer.heading('Location');
  writer.field('Coordinates', formatCoordinate(place.lat, place.lon));
  writer.field('Google Maps', 'Open in Google Maps', place.googleMapsUrl);
  if (!isGooglePlace) writer.field('OpenStreetMap', place.id, place.osmUrl);
  if (place.wikipediaUrl) writer.field('Wikipedia', 'Article', place.wikipediaUrl);
  if (place.wikidataUrl) writer.field('Wikidata', place.tags.wikidata, place.wikidataUrl);

  const extraImages = images.slice(1);
  if (extraImages.length > 0) {
    writer.heading('Gallery');
    for (const asset of extraImages) writer.image(asset.buffer, asset.caption);
  }

  writer.finishWithFooters(`${isGooglePlace ? FOOTER_GOOGLE : FOOTER} ${meta.generatedAt.toISOString()}`);
  return writer.end();
}

/** City-level index PDF listing every place in the archive. */
export async function renderSummaryPdf(result: SearchResult, generatedAt: Date): Promise<Buffer> {
  const writer = new PdfWriter(`${result.query.keyword} in ${result.area.city}`);

  writer.titleBlock(
    `${result.query.keyword} in ${result.area.city}`,
    result.area.displayName,
    'Search summary',
  );

  writer.heading('Search');
  writer.field('Keyword', result.query.keyword);
  writer.field('City', result.area.city);
  writer.field('Country', result.area.country);
  writer.field('Results', String(result.places.length));
  writer.field('Data cleaning', result.stats.llmUsed ? `LLM (${result.stats.llmModel ?? 'configured model'})` : 'Rule-based (no LLM key configured)');
  writer.field('Generated', generatedAt.toISOString());

  writer.heading('Places');
  result.places.forEach((place, index) => {
    writer.ensureSpace(60);
    const { name: displayName } = pdfDisplayName(writer, place);
    writer.paragraph(`${index + 1}. ${displayName}`, { bold: true, size: 11 });
    writer.paragraph(
      `${place.categoryLabel} · ${place.lat.toFixed(5)}, ${place.lon.toFixed(5)}`,
      { size: 9, color: COLORS.muted },
    );
    const summary = repairSummary(place.summary, place.name, displayName);
    if (summary) writer.paragraph(summary, { size: 9.5 });
    const contactLine = [
      place.contact.address,
      place.contact.phone,
      place.contact.website,
    ].filter(Boolean).join(' · ');
    if (contactLine) writer.paragraph(contactLine, { size: 9, color: COLORS.muted });
    writer.doc.moveDown(0.35);
  });

  if (result.stats.warnings.length > 0) {
    writer.heading('Notes');
    for (const warning of result.stats.warnings) {
      writer.paragraph(`- ${warning}`, { size: 9, color: COLORS.muted });
    }
  }

  writer.finishWithFooters(`${FOOTER} ${generatedAt.toISOString()}`);
  return writer.end();
}

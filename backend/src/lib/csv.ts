/**
 * Parses the batch-upload CSV: one row per city and/or province, with optional
 * Attributes / Path / source-link columns that pre-fill the batch form.
 *
 * Real-world sheets are messy — country appears once and is implied for the
 * rows below it, provinces live in their own column with everything else
 * blank, and extra columns carry stray URLs. All of that is tolerated.
 */

export interface BatchTarget {
  country: string;
  /** City or province/state name — what gets geocoded as the search area. */
  region: string;
  kind: 'city' | 'province';
  /** Per-row ceiling from a "Maximum search" column, when the sheet has one. */
  limit?: number;
}

export interface ParsedBatchCsv {
  targets: BatchTarget[];
  /** Pre-fill values lifted from Attributes / Path columns, if present. */
  attribute?: string;
  outputPath?: string;
  /** Result cap from the sheet, applied to rows that do not set their own. */
  maxSearch?: number;
  /** Every http(s) link found anywhere in the sheet, deduplicated. */
  sourceLinks: string[];
  warnings: string[];
}

/** RFC-4180-ish line splitter that respects quoted fields. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    // Skip rows that are entirely empty cells.
    if (row.some((cell) => cell.trim().length > 0)) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') inQuotes = true;
    else if (ch === ',') pushField();
    else if (ch === '\n') pushRow();
    else if (ch !== '\r') field += ch;
  }
  if (field.length > 0 || row.length > 0) pushRow();

  return rows;
}

function findColumn(header: string[], ...patterns: RegExp[]): number {
  for (const pattern of patterns) {
    const index = header.findIndex((cell) => pattern.test(cell.trim()));
    if (index !== -1) return index;
  }
  return -1;
}

const URL_PATTERN = /https?:\/\/[^\s",]+/gi;

function extractUrls(cells: string[]): string[] {
  const urls: string[] = [];
  for (const cell of cells) {
    for (const match of cell.matchAll(URL_PATTERN)) {
      urls.push(match[0].replace(/[),.;]+$/, ''));
    }
  }
  return urls;
}

/**
 * Reads a per-row result cap. Blank, zero, "all" and anything unparseable
 * mean "no cap from this sheet" rather than zero results.
 */
function parseMax(value: string): number | undefined {
  const raw = value.trim();
  if (!raw) return undefined;
  if (/^(all|max|any|unlimited)$/i.test(raw)) return undefined;
  const n = Number.parseInt(raw.replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Windows or POSIX absolute path, e.g. `C:\Users\x\Exports` or `/home/x`. */
function looksLikePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('/');
}

export function parseBatchCsv(text: string): ParsedBatchCsv {
  const rows = parseCsv(text);
  const warnings: string[] = [];

  if (rows.length === 0) {
    return { targets: [], sourceLinks: [], warnings: ['The CSV is empty.'] };
  }

  const header = rows[0]!.map((cell) => cell.trim().toLowerCase());
  const countryCol = findColumn(header, /^country$/, /country/);
  const cityCol = findColumn(header, /^city$/, /city/);
  const provinceCol = findColumn(header, /province|state/);
  const attributeCol = findColumn(header, /attribute/);
  const pathCol = findColumn(header, /^path$/, /path|folder|destination/);
  // "Maximum search", "Max results", "Limit" — how many places to take per row.
  const maxCol = findColumn(header, /^max(imum)?[\s_-]*(search|results?)?$/, /max|limit|count|quantity/);

  const hasHeader = countryCol !== -1 || cityCol !== -1 || provinceCol !== -1;
  if (!hasHeader) {
    warnings.push(
      'No Country/City/Province header row was found — treating column 1 as Country and column 2 as City.',
    );
  }

  const dataRows = hasHeader ? rows.slice(1) : rows;
  const iCountry = hasHeader ? countryCol : 0;
  const iCity = hasHeader ? cityCol : 1;

  const targets: BatchTarget[] = [];
  const seen = new Set<string>();
  const sourceLinks: string[] = [];
  let attribute: string | undefined;
  let outputPath: string | undefined;
  let maxSearch: number | undefined;
  let lastCountry = '';

  for (const cells of dataRows) {
    const cell = (index: number): string => (index >= 0 ? (cells[index] ?? '').trim() : '');

    const country = cell(iCountry) || lastCountry;
    if (cell(iCountry)) lastCountry = cell(iCountry);

    const city = cell(iCity);
    const province = cell(provinceCol);

    if (!attribute && cell(attributeCol)) attribute = cell(attributeCol);
    if (!outputPath && cell(pathCol) && looksLikePath(cell(pathCol))) outputPath = cell(pathCol);

    const rowMax = parseMax(cell(maxCol));
    if (rowMax !== undefined && maxSearch === undefined) maxSearch = rowMax;

    // Any cell outside the known geo columns may carry a source link.
    sourceLinks.push(
      ...extractUrls(cells.filter((_, index) => index !== iCity && index !== provinceCol)),
    );

    const add = (region: string, kind: BatchTarget['kind']) => {
      if (!region || !country) {
        if (region) warnings.push(`Skipped "${region}" — no country on or above its row.`);
        return;
      }
      const key = `${kind}|${country.toLowerCase()}|${region.toLowerCase()}`;
      if (seen.has(key)) return;
      seen.add(key);
      targets.push(
        rowMax !== undefined ? { country, region, kind, limit: rowMax } : { country, region, kind },
      );
    };

    add(city, 'city');
    add(province, 'province');
  }

  if (targets.length === 0) {
    warnings.push('No usable city or province rows were found in the CSV.');
  }

  return {
    targets,
    attribute,
    outputPath,
    maxSearch,
    sourceLinks: [...new Set(sourceLinks)],
    warnings,
  };
}

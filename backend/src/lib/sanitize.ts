/**
 * Place names come straight out of OpenStreetMap, i.e. from untrusted user
 * input, and end up as ZIP entry paths. A malicious name like
 * `../../../../etc/cron.d/x` must never escape the archive root, so every
 * segment is aggressively normalised here.
 *
 * Control-character handling is done with code-point comparisons rather than
 * regex ranges so the source file stays free of literal control bytes.
 */

/** Path separators plus the characters Windows forbids in filenames. */
const ILLEGAL_CHARS = /[<>:"/\\|?*]/g;

/** Windows refuses to create files with these names, extension or not. */
const RESERVED_WINDOWS_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/**
 * Replaces C0/C1 control codes (and NBSP-likes) with a plain space.
 * With `keepNewlines`, line feeds survive — needed for multi-line PDF blocks
 * such as the raw OSM tag dump, which would otherwise run together.
 */
export function stripControlChars(input: string, keepNewlines = false): string {
  let out = '';
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    if (keepNewlines && (code === 0x0a || code === 0x0d)) {
      // Normalise CRLF/CR to a single LF.
      if (code === 0x0a || !out.endsWith('\n')) out += '\n';
      continue;
    }
    const isC0 = code < 0x20;
    const isDelC1 = code >= 0x7f && code <= 0x9f;
    const isSpaceLike = code === 0x00a0 || code === 0x2007 || code === 0x202f || code === 0xfeff;
    out += isC0 || isDelC1 || isSpaceLike ? ' ' : ch;
  }
  return out;
}

export function sanitizePathSegment(input: string, fallback = 'unnamed'): string {
  let value = stripControlChars((input ?? '').normalize('NFC'))
    .replace(ILLEGAL_CHARS, ' ')
    // Any run of dots collapses to one: kills `..` traversal and `...` oddities.
    .replace(/\.{2,}/g, '.')
    .replace(/\s+/g, ' ')
    .trim()
    // Windows silently strips trailing dots/spaces, which would desync paths.
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');

  if (value.length > 80) {
    value = value.slice(0, 80).replace(/[.\s]+$/, '').trim();
  }

  if (RESERVED_WINDOWS_NAMES.has(value.toLowerCase())) value = `${value}_`;
  if (value.length === 0) value = fallback;

  return value;
}

/**
 * Returns a function that hands out unique names within one namespace,
 * appending ` (2)`, ` (3)`, ... on collision. Comparison is case-insensitive
 * because Windows and macOS filesystems are.
 */
export function createNameDeduper(): (name: string) => string {
  const seen = new Map<string, number>();
  return (name: string): string => {
    const key = name.toLowerCase();
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    return count === 0 ? name : `${name} (${count + 1})`;
  };
}

/** Collapses whitespace and strips control characters from display text. */
export function cleanText(input: string | undefined | null, maxLength = 2000): string {
  if (!input) return '';
  return stripControlChars(input).replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

/**
 * pdfkit's built-in fonts are WinAnsi (Latin-1) only — anything outside that
 * range renders as garbage. When no Unicode TTF is configured we transliterate
 * what we can and drop the rest, rather than emitting mojibake.
 */
export function toLatin1Safe(input: string, keepNewlines = false): string {
  if (!input) return '';

  const normalised = stripControlChars(input, keepNewlines)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // combining diacritics left by NFKD
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
    .replace(/[•·]/g, '-');

  let out = '';
  for (const ch of normalised) {
    const code = ch.codePointAt(0) ?? 0;
    if ((code >= 0x20 && code <= 0xff) || (keepNewlines && code === 0x0a)) out += ch;
  }

  if (!keepNewlines) return out.replace(/\s+/g, ' ').trim();

  return out
    .replace(/[^\S\n]+/g, ' ') // collapse horizontal whitespace only
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** True when a string is dominated by scripts pdfkit's core fonts can't draw. */
export function isMostlyNonLatin(input: string): boolean {
  if (!input) return false;
  let nonLatin = 0;
  let total = 0;
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x20) continue;
    total += 1;
    // Beyond Latin Extended-B is Greek, Cyrillic, Arabic, CJK, ...
    if (code > 0x024f) nonLatin += 1;
  }
  return total > 0 && nonLatin / total > 0.3;
}

/**
 * Does a piece of text -- a photo's title, description and categories -- name
 * this place?
 *
 * Photos found by position or by a loose text search are only as good as this
 * test. Without it, a Shenzhen batch filled museum folders with whatever a
 * prolific photographer had uploaded nearby: a Mazda, an air-conditioner, a
 * metro platform, Pizza Hut. A photo now counts when its own words name the
 * place: every distinctive word of one of its names ("Science", "Technology"
 * in Shenzhen Science & Technology Museum), or, when a name has none
 * ("Shenzhen Museum"), the whole name as a phrase. Chinese, Japanese and
 * Korean names are matched as written.
 */

/** Words that say what kind of place it is, not which one. */
export const GENERIC_WORDS = new Set((
  'the and des del der die das les los las von van city town old new national state royal great saint '
  + 'museum muuseum museo musee muzeum gallery galerie art arts church kirik kirche iglesia chapel cathedral '
  + 'castle palace loss schloss house home hall park garden gardens square plats platz plaza market tower '
  + 'bridge monument memorial theatre theater centre center hotel restaurant cafe bar pub beach lake '
  + 'island hill mountain river street road apartment temple mosque shrine station building '
  + 'china chinese province district').split(' '));

/** Lowercased and stripped of accents, so "Košice" matches "kosice". */
export function fold(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

/** The words of a text; underscores, dashes and %20 in file names count as spaces. */
export function wordsOf(text: string): string[] {
  return fold(text).replace(/%20/g, ' ').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** The same word, or one a declension away: "Ericu" is Estonian for Eric's. */
export function sameWord(a: string, b: string): boolean {
  return a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)));
}

const CJK = /[぀-ヿ㐀-鿿가-힯]/u;

/**
 * Whether `text` names one of `names`. `city` is left out of a name's words,
 * since every photo in the city may carry it.
 */
export function describesPlace(text: string, names: string[], city?: string): boolean {
  if (!text) return false;
  const have = wordsOf(text);
  const joined = ` ${have.join(' ')} `;
  const raw = text.normalize('NFC');
  const cityWords = new Set(city ? wordsOf(city) : []);

  return names.some((name) => {
    if (!name) return false;
    // A Chinese, Japanese or Korean name is not split into words: match it whole.
    if (CJK.test(name)) {
      const compact = name.replace(/\s+/g, '');
      return compact.length >= 2 && raw.replace(/\s+/g, '').includes(compact);
    }
    const words = wordsOf(name).filter((word) => word.length >= 2);
    if (words.length === 0) return false;
    const distinctive = words.filter((word) => word.length >= 3 && !GENERIC_WORDS.has(word) && !cityWords.has(word));
    if (distinctive.length > 0) {
      return distinctive.every((word) => have.some((candidate) => sameWord(candidate, word)));
    }
    // Nothing distinctive ("Shenzhen Museum"): the whole name, as a phrase.
    return joined.includes(` ${words.join(' ')} `);
  });
}

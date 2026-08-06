/**
 * Guards LLM prose against fabricated opening hours.
 *
 * Measured with qwen2.5:1.5b on a 20-result Karachi search, 4 of 20 summaries
 * carried an unreliable hours claim:
 *   - "Th-Tu 10:00-17:00"  ->  "Open Monday to Friday"     (Wednesday is closed)
 *   - no opening_hours tag ->  "Open daily from 09:00 to 23:00" (pure invention)
 * Those sentences are written into the downloadable PDFs, so a hallucinated
 * opening time becomes a fact in a file someone keeps.
 *
 * This module only ever DELETES unsupported claims — it never rewrites or
 * invents one. The authoritative `opening_hours` tag is already displayed
 * verbatim in its own field in both the UI and the PDF, so dropping the prose
 * sentence loses no information.
 */

/** Mo=0 ... Su=6, matching the OSM opening_hours convention. */
const DAY_ABBREVIATIONS: Record<string, number> = {
  mo: 0, tu: 1, we: 2, th: 3, fr: 4, sa: 5, su: 6,
};

const DAY_WORDS: Record<string, number> = {
  monday: 0, tuesday: 1, wednesday: 2, thursday: 3,
  friday: 4, saturday: 5, sunday: 6,
};

const ALL_DAYS = new Set([0, 1, 2, 3, 4, 5, 6]);
const WEEKDAYS = new Set([0, 1, 2, 3, 4]);
const WEEKEND = new Set([5, 6]);

/** Expands `Th-Tu` into {Th,Fr,Sa,Su,Mo,Tu} — OSM ranges wrap around Sunday. */
function expandRange(from: number, to: number): number[] {
  const days: number[] = [];
  let cursor = from;
  for (let guard = 0; guard < 7; guard += 1) {
    days.push(cursor);
    if (cursor === to) break;
    cursor = (cursor + 1) % 7;
  }
  return days;
}

function normaliseTime(raw: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!match) return raw.trim();
  return `${match[1]!.padStart(2, '0')}:${match[2]}`;
}

export function timesIn(text: string): Set<string> {
  const found = new Set<string>();
  for (const match of text.matchAll(/\b(\d{1,2}:\d{2})\b/g)) {
    found.add(normaliseTime(match[1]!));
  }
  return found;
}

/**
 * Which days an `opening_hours` tag covers.
 * Returns null when the tag is absent — "we know nothing", distinct from an
 * empty set which would mean "covers no days".
 */
export function daysCoveredByTag(tag: string | undefined): Set<number> | null {
  if (!tag || !tag.trim()) return null;

  const value = tag.toLowerCase();
  if (value.includes('24/7')) return new Set(ALL_DAYS);

  const covered = new Set<number>();

  for (const rule of value.split(';')) {
    // `Mo-Fr`, `Th-Tu`
    for (const match of rule.matchAll(/\b(mo|tu|we|th|fr|sa|su)\s*-\s*(mo|tu|we|th|fr|sa|su)\b/g)) {
      for (const day of expandRange(DAY_ABBREVIATIONS[match[1]!]!, DAY_ABBREVIATIONS[match[2]!]!)) {
        covered.add(day);
      }
    }
    // Standalone `Mo`, `We`, `Fr` not already consumed by a range
    const withoutRanges = rule.replace(/\b(mo|tu|we|th|fr|sa|su)\s*-\s*(mo|tu|we|th|fr|sa|su)\b/g, ' ');
    for (const match of withoutRanges.matchAll(/\b(mo|tu|we|th|fr|sa|su)\b/g)) {
      covered.add(DAY_ABBREVIATIONS[match[1]!]!);
    }
  }

  // A bare time span such as "10:00-23:00" carries no day restriction.
  if (covered.size === 0) return new Set(ALL_DAYS);
  return covered;
}

/** Which days a natural-language sentence claims the place is open. */
export function daysClaimedInText(text: string): Set<number> {
  const value = text.toLowerCase();
  const claimed = new Set<number>();

  // "Monday to Friday", "Tuesday through Sunday"
  for (const match of value.matchAll(
    /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s*(?:to|through|-|–|until)\s*(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/g,
  )) {
    for (const day of expandRange(DAY_WORDS[match[1]!]!, DAY_WORDS[match[2]!]!)) claimed.add(day);
  }

  if (claimed.size === 0) {
    for (const match of value.matchAll(
      /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/g,
    )) {
      claimed.add(DAY_WORDS[match[1]!]!);
    }
  }

  if (/\b(daily|every day|all week|seven days)\b/.test(value)) {
    for (const day of ALL_DAYS) claimed.add(day);
  }
  if (/\bweekdays?\b/.test(value)) for (const day of WEEKDAYS) claimed.add(day);
  if (/\bweekends?\b/.test(value)) for (const day of WEEKEND) claimed.add(day);

  return claimed;
}

/** Does this sentence assert anything about when the place is open? */
export function assertsOpeningHours(sentence: string): boolean {
  const value = sentence.toLowerCase();
  const mentionsSchedule = /\b(open|opens|opening|closed|closes|closing|hours)\b/.test(value);
  const mentionsWhen =
    /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|daily|weekdays?|weekends?)\b/.test(value)
    || /\b\d{1,2}:\d{2}\b/.test(value)
    || /\b\d{1,2}\s*(am|pm)\b/.test(value);

  return mentionsSchedule && mentionsWhen;
}

/** Splits prose into sentences, keeping the terminating punctuation. */
function splitSentences(text: string): string[] {
  return text.match(/[^.!?]+[.!?]*/g)?.map((part) => part.trim()).filter(Boolean) ?? [];
}

export interface HoursCheckResult {
  summary: string;
  /** Sentences removed, for logging/telemetry. */
  removed: string[];
}

/**
 * Removes any sentence whose opening-hours claim is not supported by the
 * place's own `opening_hours` tag.
 *
 * A claim is unsupported when the tag is absent, when it names a day the tag
 * does not cover, or when it cites a clock time absent from the tag.
 */
export function stripUnsupportedHoursClaims(
  summary: string,
  openingHoursTag: string | undefined,
): HoursCheckResult {
  if (!summary) return { summary: '', removed: [] };

  const tagDays = daysCoveredByTag(openingHoursTag);
  const tagTimes = openingHoursTag ? timesIn(openingHoursTag) : new Set<string>();

  const kept: string[] = [];
  const removed: string[] = [];

  for (const sentence of splitSentences(summary)) {
    if (!assertsOpeningHours(sentence)) {
      kept.push(sentence);
      continue;
    }

    // No tag at all — the model had nothing to base this on.
    if (tagDays === null) {
      removed.push(sentence);
      continue;
    }

    const claimedDays = daysClaimedInText(sentence);
    const daysUnsupported = [...claimedDays].some((day) => !tagDays.has(day));

    const claimedTimes = timesIn(sentence);
    const timesUnsupported = [...claimedTimes].some((time) => !tagTimes.has(time));

    if (daysUnsupported || timesUnsupported) removed.push(sentence);
    else kept.push(sentence);
  }

  return { summary: kept.join(' ').trim(), removed };
}

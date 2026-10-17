/**
 * The app's colour scheme: one accent, teal, used the same way everywhere.
 *
 * - Selected and primary things are solid teal-700 with white text (AA).
 * - Idle things are white with a slate border and turn teal on hover.
 * - Soft highlights (badges, totals) are teal-50/100 with teal-800 text.
 *
 * Green, amber and red appear only as status (done, warning, failed).
 */
export interface ChipColour {
  idle: string;
  on: string;
}

const CHIP: ChipColour = {
  idle: 'border-slate-300 bg-white text-mist-300 hover:border-teal-600 hover:text-teal-800',
  on: 'border-teal-700 bg-teal-700 text-white',
};

export const ALL_COLOUR: ChipColour = CHIP;

/** Every kind of place uses the same chip colours; kept as a function so callers need not change. */
export function pickColour(_pick: string): ChipColour {
  return CHIP;
}

/** Small numbered badges and list dots. */
export const ACCENT = {
  dot: 'bg-teal-600',
  badge: 'bg-teal-100 text-teal-800',
  ring: 'hover:border-teal-600',
} as const;

/** The main call to action: Search, Start batch, Save all. */
export const PRIMARY_BUTTON =
  'bg-teal-700 text-white shadow-md shadow-teal-900/15 transition hover:bg-teal-800 active:scale-[0.99] disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500 disabled:shadow-none';

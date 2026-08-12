'use client';

/**
 * Shown before the first search. The tool does something quite specific —
 * research every place of a kind in a city and write it up as PDFs — and
 * without saying so the empty screen reads as a plain map search.
 */

const STEPS = [
  {
    n: '1',
    title: 'Say what and where',
    body: 'For example “museums” in “Kyoto, Japan”. Leave Max results blank to get every place in the city.',
  },
  {
    n: '2',
    title: 'It researches each place',
    body: 'Finds them on OpenStreetMap and Wikidata, translates non-English names, checks each is relevant, and gathers photos.',
  },
  {
    n: '3',
    title: 'Download the write-ups',
    body: 'A ZIP with one folder per place: an illustrated PDF article plus the photographs.',
  },
];

export default function WelcomePanel({ onExample }: { onExample: () => void }) {
  return (
    <div className="rounded-2xl border border-white/[0.08] bg-ink-900/50 p-4">
      <h2 className="text-[13.5px] font-semibold text-mist-100">
        Research every place of a kind, in any city
      </h2>
      <p className="mt-1 text-[11.5px] leading-relaxed text-mist-400">
        Search once, get a folder of illustrated PDF write-ups you can keep.
      </p>

      <ol className="mt-3.5 space-y-3">
        {STEPS.map((step) => (
          <li key={step.n} className="flex gap-2.5">
            <span
              aria-hidden
              className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-aqua-500/15 text-[11px] font-bold text-aqua-300"
            >
              {step.n}
            </span>
            <span className="min-w-0">
              <span className="block text-[12.5px] font-medium text-mist-200">{step.title}</span>
              <span className="block text-[11px] leading-snug text-mist-500">{step.body}</span>
            </span>
          </li>
        ))}
      </ol>

      <button
        type="button"
        onClick={onExample}
        className="mt-3.5 w-full rounded-xl border border-aqua-500/30 bg-aqua-500/10 px-3 py-2 text-[12.5px] font-semibold text-aqua-300 transition hover:bg-aqua-500/20"
      >
        Try an example: museums in Kyoto
      </button>

      <p className="mt-3 border-t border-white/[0.06] pt-2.5 text-[10.5px] leading-snug text-mist-500">
        Got a list of cities? Switch to <span className="text-mist-300">Batch search</span> to
        work through a whole CSV unattended.
      </p>
    </div>
  );
}

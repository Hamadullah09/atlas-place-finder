import PlaceFinder from '@/components/PlaceFinder';

/**
 * Server component shell — keeps the page itself server-rendered for SEO while
 * all interactive state lives in <PlaceFinder />.
 */
export default function HomePage() {

  return (
    <div className="relative z-10 flex h-dvh flex-col overflow-hidden">
      <header className="shrink-0 border-b border-white/[0.06] bg-ink-950/60 backdrop-blur-xl">
        <div className="flex h-14 items-center gap-3 px-4 sm:px-5">
          <a href="/" className="group flex items-center gap-2.5">
            <span
              aria-hidden
              className="relative grid h-8 w-8 place-items-center overflow-hidden rounded-[10px] bg-gradient-to-br from-aqua-400 to-aqua-600 shadow-lg shadow-aqua-500/25"
            >
              <span className="absolute inset-0 bg-gradient-to-tr from-transparent to-white/25" />
              <svg viewBox="0 0 24 24" className="relative h-4 w-4 text-ink-950" aria-hidden>
                <path
                  fill="currentColor"
                  d="M12 2a7 7 0 0 0-7 7c0 4.6 5.4 11.4 6.3 12.5a.9.9 0 0 0 1.4 0C13.6 20.4 19 13.6 19 9a7 7 0 0 0-7-7Zm0 9.6A2.6 2.6 0 1 1 12 6.4a2.6 2.6 0 0 1 0 5.2Z"
                />
              </svg>
            </span>
            <span className="flex flex-col leading-none">
              <span className="text-[15px] font-semibold tracking-tight text-mist-50">Atlas</span>
              <span className="mt-0.5 hidden text-[10px] font-medium tracking-wide text-mist-500 sm:block">
                Find any place, anywhere
              </span>
            </span>
          </a>

          <div className="ml-auto flex items-center gap-2">
            <a
              href="https://www.openstreetmap.org/copyright"
              target="_blank"
              rel="noreferrer noopener"
              className="rounded-full border border-white/[0.07] px-2.5 py-1 text-[11px] font-medium text-mist-400 transition hover:border-white/15 hover:text-mist-200"
            >
              © OpenStreetMap
            </a>
          </div>
        </div>
      </header>

      <PlaceFinder />
    </div>
  );
}

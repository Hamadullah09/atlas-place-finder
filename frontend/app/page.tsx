import Image from 'next/image';
import PlaceFinder from '@/components/PlaceFinder';

/**
 * Server component shell — keeps the page itself server-rendered for SEO while
 * all interactive state lives in <PlaceFinder />.
 */
export default function HomePage() {

  return (
    <div className="relative z-10 flex h-dvh flex-col overflow-hidden">
      <header className="shrink-0 border-b border-slate-200 bg-ink-950/60 backdrop-blur-xl">
        <div className="flex h-14 items-center gap-3 px-4 sm:px-5">
          <a href="/" className="group flex items-center gap-2.5">
            <Image
              src="/logo.png"
              alt=""
              width={40}
              height={40}
              priority
              className="h-9 w-9 shrink-0 object-contain sm:h-10 sm:w-10"
            />
            <span className="flex flex-col leading-none">
              <span className="text-[18px] font-semibold tracking-tight text-mist-50">
                SMA Place Finder
              </span>
              <span className="mt-0.5 hidden text-[17px] font-medium tracking-wide text-mist-500 sm:block">
                Find any place, anywhere
              </span>
            </span>
          </a>

          <div className="ml-auto flex items-center gap-2">
            <a
              href="https://www.openstreetmap.org/copyright"
              target="_blank"
              rel="noreferrer noopener"
              className="rounded-full border border-slate-200 px-2.5 py-1 text-[16px] font-medium text-mist-400 transition hover:border-slate-300 hover:text-mist-200"
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

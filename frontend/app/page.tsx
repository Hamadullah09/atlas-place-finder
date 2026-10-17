import PlaceFinder from '@/components/PlaceFinder';

/**
 * Server component shell — keeps the page itself server-rendered for SEO while
 * all interactive state lives in <PlaceFinder />, including the nav bar, whose
 * Single / Batch switch is part of that state.
 */
export default function HomePage() {
  return (
    <div className="relative z-10 flex h-dvh flex-col overflow-hidden">
      <PlaceFinder />
    </div>
  );
}

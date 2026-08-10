'use client';

import { useState } from 'react';
import type { Place } from '@/lib/types';

interface PlaceCardProps {
  place: Place;
  index: number;
  selected: boolean;
  city: string;
  downloading: boolean;
  onSelect: (place: Place) => void;
  onDownload: (place: Place) => void;
}

/** Deterministic hue from the name so imageless cards still look intentional. */
function hueFor(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) % 360;
  return hash;
}

export default function PlaceCard({
  place,
  index,
  selected,
  city,
  downloading,
  onSelect,
  onDownload,
}: PlaceCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);

  const hero = place.images[0];
  const showImage = hero && !imageFailed;
  const isUltraHd = (hero?.width ?? 0) >= 1600;
  const summary = place.summary || 'No description recorded in OpenStreetMap for this place.';
  const isLong = summary.length > 150;
  const hue = hueFor(place.name);

  return (
    <article
      id={`place-${place.id.replace('/', '-')}`}
      onClick={() => onSelect(place)}
      style={{ animationDelay: `${Math.min(index, 8) * 45}ms` }}
      className={`group shrink-0 cursor-pointer overflow-hidden rounded-2xl border transition duration-200 animate-rise ${
        selected
          ? 'border-aqua-500/50 bg-aqua-500/[0.06] shadow-lg shadow-aqua-500/10'
          : 'border-white/[0.07] bg-white/[0.025] hover:border-white/15 hover:bg-white/[0.05]'
      }`}
    >
      {/* Hero */}
      <div className="relative aspect-[16/9] w-full overflow-hidden">
        {showImage ? (
          // Plain <img>: sources are already CDN thumbnails, so Next's
          // optimizer would only add a hop.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={hero.thumbUrl}
            alt={hero.title ?? place.name}
            // The first few cards are above the fold — lazy-loading them would
            // delay the most important visual content on the page.
            loading={index < 3 ? 'eager' : 'lazy'}
            fetchPriority={index === 0 ? 'high' : 'auto'}
            decoding="async"
            className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.04]"
            onError={() => setImageFailed(true)}
          />
        ) : (
          <div
            className="grid h-full w-full place-items-center"
            style={{
              background: `linear-gradient(135deg, hsl(${hue} 45% 22%), hsl(${(hue + 50) % 360} 40% 12%))`,
            }}
          >
            <span className="text-4xl font-bold text-white/15">
              {place.name.trim().charAt(0).toUpperCase() || '?'}
            </span>
          </div>
        )}

        {/* Scrim keeps the overlaid title legible on any photo */}
        <div className="absolute inset-0 bg-gradient-to-t from-ink-950 via-ink-950/45 to-transparent" />

        <div className="absolute left-2.5 top-2.5 flex items-center gap-1.5">
          <span className="grid h-5 min-w-5 place-items-center rounded-md bg-ink-950/75 px-1.5 text-[10.5px] font-bold tabular-nums text-mist-100 backdrop-blur">
            {index + 1}
          </span>
          {isUltraHd && (
            <span className="rounded-md bg-ember-500/90 px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-ink-950">
              Ultra HD
            </span>
          )}
        </div>

        <span
          title={`Quality score ${place.qualityScore}/100`}
          className="absolute right-2.5 top-2.5 rounded-md bg-ink-950/75 px-1.5 py-0.5 text-[10.5px] font-semibold tabular-nums text-mist-200 backdrop-blur"
        >
          {place.qualityScore}
        </span>

        <div className="absolute inset-x-0 bottom-0 p-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="rounded-md bg-aqua-500/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-aqua-300 ring-1 ring-inset ring-aqua-400/25">
              {place.categoryLabel}
            </span>
            {place.llmProcessed && (
              <span className="rounded-md bg-white/10 px-1.5 py-0.5 text-[10px] font-medium text-mist-300">
                LLM-cleaned
              </span>
            )}
          </div>
          {/* dir="auto": OSM names are often RTL (Arabic/Urdu/Hebrew). */}
          <h3
            dir="auto"
            title={place.name}
            className="mt-1 truncate text-[15px] font-semibold text-balance-tight text-white drop-shadow"
          >
            {place.name}
          </h3>
        </div>
      </div>

      {/* Body */}
      <div className="px-3 pb-2.5 pt-2.5">
        <p
          dir="auto"
          className={`text-[12.5px] leading-relaxed text-mist-400 ${expanded ? '' : 'line-clamp-2'}`}
        >
          {summary}
        </p>
        {isLong && (
          <button
            type="button"
            className="mt-1 text-[11px] font-semibold text-aqua-400 transition hover:text-aqua-300"
            onClick={(event) => {
              event.stopPropagation();
              setExpanded((open) => !open);
            }}
          >
            {expanded ? 'Less' : 'More'}
          </button>
        )}

        <ContactChips place={place} />
        <TravelLinks place={place} />
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1.5 border-t border-white/[0.06] px-3 py-2">
        <button
          type="button"
          disabled={downloading}
          onClick={(event) => {
            event.stopPropagation();
            onDownload(place);
          }}
          className="flex items-center gap-1 rounded-lg border border-white/10 px-2.5 py-1.5 text-[11.5px] font-semibold text-mist-300 transition hover:border-white/20 hover:bg-white/5 hover:text-mist-100 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {downloading ? (
            <>
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
              Zipping
            </>
          ) : (
            <>
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" aria-hidden>
                <path fill="currentColor" d="M12 3v10.6l3.3-3.3 1.4 1.4L12 17.4l-4.7-5.7 1.4-1.4L12 13.6V3h0ZM5 19h14v2H5v-2Z" />
              </svg>
              Download
            </>
          )}
        </button>

        <div className="ml-auto flex items-center gap-0.5">
          {place.wikipediaUrl && (
            <IconLink href={place.wikipediaUrl} label="Wikipedia article">
              <span className="text-[12px] font-bold leading-none">W</span>
            </IconLink>
          )}
          <IconLink href={place.osmUrl} label="View on OpenStreetMap">
            <span className="text-[10px] font-bold leading-none">OSM</span>
          </IconLink>
        </div>
      </div>
    </article>
  );
}

function IconLink({
  href,
  label,
  children,
}: {
  href: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      title={label}
      aria-label={label}
      onClick={(event) => event.stopPropagation()}
      className="grid h-7 min-w-7 place-items-center rounded-lg px-1.5 text-mist-500 transition hover:bg-white/5 hover:text-mist-200"
    >
      {children}
    </a>
  );
}

const LINK_STYLE: Record<string, string> = {
  reviews: 'text-emerald-300 hover:bg-emerald-500/15 ring-emerald-400/25',
  tours: 'text-ember-300 hover:bg-ember-500/15 ring-ember-400/25',
  booking: 'text-sky-300 hover:bg-sky-500/15 ring-sky-400/25',
  guide: 'text-violet-300 hover:bg-violet-500/15 ring-violet-400/25',
  reference: 'text-mist-300 hover:bg-white/10 ring-white/15',
};

const LINK_HINT: Record<string, string> = {
  reviews: 'Reviews and ratings',
  tours: 'Tours and tickets',
  booking: 'Booking',
  guide: 'Destination guide',
  reference: 'Official tourism portal',
};

/**
 * Outbound search links into the travel marketplaces. These open the provider's
 * own site — no ratings, prices or review text are copied into this app, which
 * is what their terms restrict.
 */
function TravelLinks({ place }: { place: Place }) {
  const links = place.travelLinks ?? [];
  if (links.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1">
      <span className="mr-0.5 text-[9.5px] font-semibold uppercase tracking-wider text-mist-500">
        Book
      </span>
      {links.map((link) => (
        <a
          key={link.id}
          href={link.url}
          target="_blank"
          rel="noreferrer noopener sponsored"
          title={
            link.generic
              ? `${link.label} — general portal (this site has no search)`
              : `${LINK_HINT[link.kind] ?? 'Open'} — ${link.label}`
          }
          onClick={(event) => event.stopPropagation()}
          className={`rounded-md px-1.5 py-0.5 text-[10.5px] font-medium ring-1 ring-inset transition ${
            LINK_STYLE[link.kind] ?? 'text-mist-300 ring-white/10 hover:bg-white/10'
          }`}
        >
          {link.label} ↗
        </a>
      ))}
    </div>
  );
}

function ContactChips({ place }: { place: Place }) {
  const { address, phone, website, openingHours } = place.contact;
  const chips: React.ReactNode[] = [];

  if (address) {
    chips.push(
      <Chip key="addr" icon="📍" title={address}>
        {address}
      </Chip>,
    );
  }
  if (phone) {
    chips.push(
      <Chip key="tel" icon="📞" href={`tel:${phone.replace(/\s+/g, '')}`}>
        {phone}
      </Chip>,
    );
  }
  if (website) {
    chips.push(
      <Chip key="web" icon="🔗" href={website} title={website}>
        {website.replace(/^https?:\/\//, '').replace(/\/$/, '')}
      </Chip>,
    );
  }
  if (openingHours) {
    chips.push(
      <Chip key="hrs" icon="🕒" title={openingHours}>
        {openingHours}
      </Chip>,
    );
  }

  if (chips.length === 0) return null;
  return <div className="mt-2 flex flex-wrap gap-1">{chips}</div>;
}

function Chip({
  icon,
  children,
  href,
  title,
}: {
  icon: string;
  children: React.ReactNode;
  href?: string;
  title?: string;
}) {
  const className =
    'flex max-w-full items-center gap-1 rounded-md bg-white/[0.05] px-1.5 py-0.5 text-[10.5px] text-mist-400 transition hover:bg-white/[0.09]';

  const inner = (
    <>
      <span aria-hidden className="shrink-0 text-[9px] leading-none opacity-70">
        {icon}
      </span>
      <span className="truncate">{children}</span>
    </>
  );

  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        title={title}
        onClick={(event) => event.stopPropagation()}
        className={`${className} hover:text-aqua-300`}
      >
        {inner}
      </a>
    );
  }

  return (
    <span className={className} title={title}>
      {inner}
    </span>
  );
}

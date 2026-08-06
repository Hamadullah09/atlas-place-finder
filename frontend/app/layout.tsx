import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Atlas — find any place, anywhere',
  description:
    'Search tourist places, universities, hospitals, cafes and more in any city on earth. '
    + 'Results are drawn from OpenStreetMap, illustrated with ultra-HD Wikimedia imagery, '
    + 'cleaned by an open-source LLM, mapped with Google Maps, and exportable as PDFs and JPEGs.',
  keywords: ['OpenStreetMap', 'Overpass API', 'place search', 'Google Maps', 'travel', 'directory'],
  openGraph: {
    title: 'Atlas — find any place, anywhere',
    description: 'Find and export detailed place data for any city in the world.',
    type: 'website',
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#060910',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="h-full">{children}</body>
    </html>
  );
}

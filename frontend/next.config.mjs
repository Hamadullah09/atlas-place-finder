/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Packaged desktop builds export static files that the backend serves
  // itself (build-exe.mjs sets NEXT_EXPORT=1). Dev keeps the Next server.
  ...(process.env.NEXT_EXPORT === '1' ? { output: 'export' } : {}),
  images: {
    // Ultra-HD source imagery lives on these hosts.
    remotePatterns: [
      { protocol: 'https', hostname: 'upload.wikimedia.org' },
      { protocol: 'https', hostname: '**.wikimedia.org' },
      { protocol: 'https', hostname: '**.wikipedia.org' },
      { protocol: 'https', hostname: 'images.unsplash.com' },
      { protocol: 'https', hostname: 'plus.unsplash.com' },
    ],
  },
};

export default nextConfig;

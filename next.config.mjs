/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // 2026-06-12: dist-dir override for build/serve contention. A `next dev`
  // session (owner's parallel work) and a production `next build` writing
  // the SAME .next corrupt each other (BUILD_ID vanishes mid-build — bit us
  // twice today). Proof harnesses and gate builds set NEXT_DIST_DIR to an
  // isolated dir (e.g. ".next-prod"); default behavior is unchanged.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  experimental: {
    // Vault PDF ingest (2026-06-10): webpack-bundling pdf-parse/pdfjs-dist
    // breaks it at runtime ("Object.defineProperty called on non-object")
    // and strands pdf.worker.mjs outside the bundle (the historical
    // worker-copy-into-.next/server/chunks post-build step). Externalizing
    // makes Node require pdf-parse from node_modules directly — verified
    // working standalone. No new dependency; pdf-parse was already shipped.
    serverComponentsExternalPackages: ["pdf-parse"],
  },
};

export default nextConfig;

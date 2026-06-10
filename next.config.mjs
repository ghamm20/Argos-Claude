/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // Boots email-intake listeners at server start (Railway / self-hosted).
    instrumentationHook: true,
    serverActions: { allowedOrigins: ["localhost:3000"] },
    // pdf-parse and mammoth aren't webpack-friendly: pdf-parse reads
    // a bundled test fixture relative to its install path, mammoth
    // pulls in optional native bits. Marking them external means
    // they're left as plain Node require()s at runtime, which Just
    // Works on the Railway server runtime.
    serverComponentsExternalPackages: ["pdf-parse", "mammoth"],
    // Same `canvas` stub as the webpack config below, for `next dev --turbo`
    // (the default dev script). Turbopack does NOT run the webpack() hook, so
    // without this, printing an email with a PDF attachment fails in dev with
    // the exact "Can't resolve 'canvas'" the alias exists to prevent — while
    // production builds, which use webpack, are fine.
    turbo: {
      resolveAlias: {
        canvas: { browser: "./src/lib/empty-module.js" }
      }
    }
  },
  webpack: (config) => {
    // pdfjs-dist (used client-side to rasterize PDF attachments into the
    // printable document) has an optional `require('canvas')` for its Node
    // build. In the browser it renders to a real <canvas> and never touches it,
    // but webpack still tries to resolve the import and fails the build with
    // "Module not found: Can't resolve 'canvas'". Resolving it to false stubs
    // it out — the documented workaround from pdf.js.
    config.resolve.alias = { ...config.resolve.alias, canvas: false };
    return config;
  }
};

export default nextConfig;

// The owner's Executive AI API (/api/exec/*), and nothing else in DD:
//   - no stored copies: its responses carry his data (unless a handler sets
//     its own Cache-Control);
//   - never framed, and no Referer (X-Frame-Options for old browsers, CSP
//     frame-ancestors for current ones).
// "/api/exec/:path*" matches "/api/exec" itself too.
//
// The /executive pages get none of these, on purpose. Headers set here
// attach by path before the page or the middleware runs, so they would also
// go out on the 404 a non-owner gets and on the redirect to /login a
// signed-out visitor gets, and no other DD path sends them: anyone could
// tell the page exists from the headers alone. On the page they would add
// little: Next sends "private, no-cache, no-store" for every dynamic render
// already, the P2b page only reads (no button acts as him yet), and its links
// out carry rel="noreferrer". When P5 puts his actions on the page, frame
// protection there has to come from a rule that doesn't single the page out
// (nothing frames DD, so frame-ancestors 'none' could cover every route).
//
// The API keeps them although they mark it the same way (a signed-out
// request gets the middleware's 401 with them): not caching his data matters
// more there, and the API was never indistinguishable anyway, since the
// gate's 404 is JSON where a missing route's is a page.
const EXEC_ROUTE_SOURCES = ["/api/exec/:path*"];
const EXEC_SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Cache-Control", value: "private, no-store" }
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async headers() {
    return EXEC_ROUTE_SOURCES.map((source) => ({ source, headers: EXEC_SECURITY_HEADERS }));
  },
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
    //
    // Unconditional (bare string), NOT `{ browser: ... }`: pdfjs-dist's
    // `require('canvas')` also runs on the NODE path (e.g. sop-ingest.ts server
    // side), where a browser-only condition wouldn't match and the build fails
    // with "Can't resolve 'canvas'". Aliasing it for every condition mirrors
    // webpack's unconditional `canvas: false` and is safe — the browser renders
    // to a real DOM <canvas> and never touches the npm package.
    turbo: {
      resolveAlias: {
        canvas: "./src/lib/empty-module.js"
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

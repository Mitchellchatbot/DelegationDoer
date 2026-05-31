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
    serverComponentsExternalPackages: ["pdf-parse", "mammoth"]
  }
};

export default nextConfig;

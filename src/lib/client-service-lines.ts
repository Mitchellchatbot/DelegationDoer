// Which parts of the business a client buys. Stored on clients.service_lines.
// Pure — safe to import from client components.
//
//   seo_web  — the original SEO / Website book. Every pre-existing client.
//   facebook — Facebook ads team clients. Kept out of the SEO-only surfaces.

export const SERVICE_LINES = [
  { id: "seo_web", label: "SEO & Web" },
  { id: "facebook", label: "Facebook" }
] as const;

export type ServiceLine = (typeof SERVICE_LINES)[number]["id"];

const VALID = new Set<string>(SERVICE_LINES.map((l) => l.id));

// Unknown / empty falls back to seo_web — the column's own default, and the
// right answer for any row written before the column existed.
export function parseServiceLines(raw: unknown): ServiceLine[] {
  const lines = Array.isArray(raw) ? raw.filter((v): v is ServiceLine => typeof v === "string" && VALID.has(v)) : [];
  return lines.length > 0 ? Array.from(new Set(lines)) : ["seo_web"];
}

export const isSeoWebClient = (c: { serviceLines: ServiceLine[] }) => c.serviceLines.includes("seo_web");

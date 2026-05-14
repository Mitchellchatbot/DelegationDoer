import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

// GET /api/recommendations/search/rawg?q=...
//   Searches the RAWG video-game database.
export async function GET(req: NextRequest) {
  await requireCurrentUserId();
  const key = process.env.RAWG_API_KEY;
  if (!key) return NextResponse.json({ error: "RAWG_API_KEY not set" }, { status: 500 });

  const q = req.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (!q) return NextResponse.json({ results: [] });

  const url = new URL("https://api.rawg.io/api/games");
  url.searchParams.set("key", key);
  url.searchParams.set("search", q);
  url.searchParams.set("page_size", "12");

  const res = await fetch(url.toString());
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return NextResponse.json(
      { error: `rawg ${res.status}: ${text.slice(0, 120)}` },
      { status: 500 }
    );
  }
  const data = await res.json();
  const items = (data.results ?? []).slice(0, 12).map((r: any) => ({
    id: String(r.id),
    title: r.name,
    subtitle: r.released ? new Date(r.released).getFullYear().toString() : "",
    imageUrl: r.background_image ?? null,
    backdropUrl: r.background_image_additional ?? r.background_image ?? null,
    body: (r.platforms ?? [])
      .slice(0, 3)
      .map((p: any) => p?.platform?.name)
      .filter(Boolean)
      .join(" · "),
    externalUrl: `https://rawg.io/games/${r.slug}`
  }));
  return NextResponse.json({ results: items });
}

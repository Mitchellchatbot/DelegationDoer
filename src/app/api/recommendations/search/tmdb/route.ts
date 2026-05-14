import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

// GET /api/recommendations/search/tmdb?q=...&kind=movie|tv
//   Proxies TMDB's multi-search so the recommendation picker can show
//   posters + titles without leaking the API key to the client.
export async function GET(req: NextRequest) {
  await requireCurrentUserId();
  const key = process.env.TMDB_API_KEY;
  if (!key) return NextResponse.json({ error: "TMDB_API_KEY not set" }, { status: 500 });

  const q = req.nextUrl.searchParams.get("q")?.trim() ?? "";
  const kind = req.nextUrl.searchParams.get("kind") ?? "movie";
  if (!q) return NextResponse.json({ results: [] });

  const endpoint = kind === "tv" ? "search/tv" : "search/movie";
  const url = new URL(`https://api.themoviedb.org/3/${endpoint}`);
  url.searchParams.set("api_key", key);
  url.searchParams.set("query", q);
  url.searchParams.set("include_adult", "false");

  const res = await fetch(url.toString());
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return NextResponse.json(
      { error: `tmdb ${res.status}: ${text.slice(0, 120)}` },
      { status: 500 }
    );
  }
  const data = await res.json();
  const items = (data.results ?? []).slice(0, 12).map((r: any) => {
    const title = r.title || r.name || "(untitled)";
    const date = r.release_date || r.first_air_date || null;
    return {
      id: String(r.id),
      title,
      subtitle: date ? new Date(date).getFullYear().toString() : "",
      imageUrl: r.poster_path
        ? `https://image.tmdb.org/t/p/w500${r.poster_path}`
        : null,
      backdropUrl: r.backdrop_path
        ? `https://image.tmdb.org/t/p/original${r.backdrop_path}`
        : null,
      body: r.overview || null,
      externalUrl: `https://www.themoviedb.org/${kind === "tv" ? "tv" : "movie"}/${r.id}`
    };
  });
  return NextResponse.json({ results: items });
}

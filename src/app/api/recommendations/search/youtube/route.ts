import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

// GET /api/recommendations/search/youtube?q=...
//   Searches YouTube via the Data API (server-side so the key stays
//   out of the bundle).
export async function GET(req: NextRequest) {
  await requireCurrentUserId();
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return NextResponse.json({ error: "YOUTUBE_API_KEY not set" }, { status: 500 });

  const q = req.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (!q) return NextResponse.json({ results: [] });

  const url = new URL("https://www.googleapis.com/youtube/v3/search");
  url.searchParams.set("key", key);
  url.searchParams.set("q", q);
  url.searchParams.set("part", "snippet");
  url.searchParams.set("type", "video");
  url.searchParams.set("maxResults", "12");

  const res = await fetch(url.toString());
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return NextResponse.json(
      { error: `youtube ${res.status}: ${text.slice(0, 120)}` },
      { status: 500 }
    );
  }
  const data = await res.json();
  const items = (data.items ?? []).slice(0, 12).map((r: any) => {
    const id = r.id?.videoId;
    return {
      id: String(id),
      title: r.snippet?.title ?? "(untitled)",
      subtitle: r.snippet?.channelTitle ?? "",
      imageUrl:
        r.snippet?.thumbnails?.high?.url ??
        r.snippet?.thumbnails?.medium?.url ??
        r.snippet?.thumbnails?.default?.url ??
        null,
      backdropUrl: r.snippet?.thumbnails?.maxres?.url ?? r.snippet?.thumbnails?.high?.url ?? null,
      body: r.snippet?.description?.slice(0, 240) ?? null,
      externalUrl: id ? `https://www.youtube.com/watch?v=${id}` : null
    };
  });
  return NextResponse.json({ results: items });
}

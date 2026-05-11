import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

// One-shot dev seeder for the Moments grid. Drops in ~16 stock images
// distributed across whichever users are in the DB. Idempotent-ish:
// passes `?clear=1` to wipe existing moments before seeding.
const STOCK = [
  { url: "https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=1280&q=70", caption: "Mountain view on the way home" },
  { url: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=1280&q=70", caption: "Coffee + thinking" },
  { url: "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?w=1280&q=70", caption: "Light through the trees" },
  { url: "https://images.unsplash.com/photo-1494526585095-c41746248156?w=1280&q=70", caption: "New desk setup" },
  { url: "https://images.unsplash.com/photo-1543007630-9710e4a00a20?w=1280&q=70", caption: "Found this little guy" },
  { url: "https://images.unsplash.com/photo-1469474968028-56623f02e42e?w=1280&q=70", caption: "Sunset commute" },
  { url: "https://images.unsplash.com/photo-1518770660439-4636190af475?w=1280&q=70", caption: "Wiring up the rack" },
  { url: "https://images.unsplash.com/photo-1517336714731-489689fd1ca8?w=1280&q=70", caption: "Late-night ship 🚀" },
  { url: "https://images.unsplash.com/photo-1518791841217-8f162f1e1131?w=1280&q=70", caption: "Studio cat" },
  { url: "https://images.unsplash.com/photo-1488972685288-c3fd157d7c7a?w=1280&q=70", caption: "Skyline" },
  { url: "https://images.unsplash.com/photo-1517694712202-14dd9538aa97?w=1280&q=70", caption: "Pair programming" },
  { url: "https://images.unsplash.com/photo-1542038784456-1ea8e935640e?w=1280&q=70", caption: "Morning run" },
  { url: "https://images.unsplash.com/photo-1547591297-c1bb5b6d2c11?w=1280&q=70", caption: "Out for a walk" },
  { url: "https://images.unsplash.com/photo-1502082553048-f009c37129b9?w=1280&q=70", caption: "Hike day" },
  { url: "https://images.unsplash.com/photo-1551434678-e076c223a692?w=1280&q=70", caption: "All hands deck" },
  { url: "https://images.unsplash.com/photo-1531297484001-80022131f5a1?w=1280&q=70", caption: "On-call kit" }
];

export async function GET(req: Request) {
  const supabase = getSupabaseAdmin();
  const url = new URL(req.url);
  const clear = url.searchParams.get("clear") === "1";

  if (clear) {
    await supabase.from("moments").delete().neq("id", "");
  }

  const { data: users } = await supabase
    .from("users")
    .select("id, name")
    .order("name");
  if (!users || users.length === 0) {
    return NextResponse.json({ error: "no users in DB" }, { status: 400 });
  }

  const inserted: string[] = [];
  for (let i = 0; i < STOCK.length; i++) {
    const u = users[i % users.length];
    const id = `mm_seed_${Date.now().toString(36)}_${i}`;
    const { error } = await supabase.from("moments").insert({
      id,
      user_id: u.id,
      image_url: STOCK[i].url,
      caption: STOCK[i].caption,
      // Stagger created_at backwards so the order looks natural
      // (newest first; older entries trail).
      created_at: new Date(Date.now() - i * 47 * 60 * 1000).toISOString()
    });
    if (!error) inserted.push(id);
  }

  return NextResponse.json({
    ok: true,
    cleared: clear,
    seeded: inserted.length,
    users: users.length
  });
}

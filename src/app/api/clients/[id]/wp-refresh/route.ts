import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { fetchWpCounts, normalizeWpUrl, WordPressError } from "@/lib/wordpress";

export const dynamic = "force-dynamic";

// POST /api/clients/[id]/wp-refresh
// Body: { url?: string }
//
// Behaviour:
//   - If `url` is provided, normalize + persist as clients.wp_url before
//     fetching (so saving + refreshing is one round-trip).
//   - Resolve the effective URL: explicit wp_url first, then websites[0],
//     then the legacy single `website` column.
//   - Hit WordPress, store counts (or the error) on the row, return the
//     fresh values.
//
// Gated to dep_seo + leaders + admins (same audience that sees the card).
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unknown user" }, { status: 401 });
    const allowed =
      me.isAdmin ||
      me.role === "leader" ||
      me.departmentIds.includes("dep_seo");
    if (!allowed) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const body = (await req.json().catch(() => ({}))) as { url?: unknown };
    const supabase = getSupabaseAdmin();

    let nextUrlOverride: string | null | undefined;
    if (typeof body.url === "string") {
      const raw = body.url.trim();
      if (raw === "") {
        nextUrlOverride = null; // explicit clear → fall back to websites[0]
      } else {
        try {
          nextUrlOverride = normalizeWpUrl(raw);
        } catch (err) {
          return NextResponse.json(
            { error: err instanceof Error ? err.message : "invalid url" },
            { status: 400 }
          );
        }
      }
    }

    // Persist the override (if it was sent) before resolving below, so a
    // subsequent retry reads the new value even if the WP fetch fails.
    if (nextUrlOverride !== undefined) {
      const { error } = await supabase
        .from("clients")
        .update({ wp_url: nextUrlOverride })
        .eq("id", params.id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const { data: row, error: readErr } = await supabase
      .from("clients")
      .select("wp_url, website, websites")
      .eq("id", params.id)
      .maybeSingle();
    if (readErr || !row) {
      return NextResponse.json(
        { error: readErr?.message ?? "client not found" },
        { status: 404 }
      );
    }

    const effective =
      (row.wp_url as string | null) ??
      ((row.websites as string[] | null)?.[0] ?? null) ??
      (row.website as string | null);
    if (!effective) {
      return NextResponse.json(
        { error: "No website on file — set a WordPress URL first." },
        { status: 400 }
      );
    }

    try {
      const counts = await fetchWpCounts(effective);
      const updatedAt = new Date().toISOString();
      await supabase
        .from("clients")
        .update({
          wp_blog_posts_count: counts.blogPosts,
          wp_counts_updated_at: updatedAt,
          wp_last_error: null
        })
        .eq("id", params.id);
      return NextResponse.json({
        ok: true,
        blogPostsCount: counts.blogPosts,
        updatedAt
      });
    } catch (err) {
      const message =
        err instanceof WordPressError
          ? err.message
          : err instanceof Error
          ? err.message
          : "Unknown WordPress error";
      await supabase
        .from("clients")
        .update({
          wp_last_error: message,
          wp_counts_updated_at: new Date().toISOString()
        })
        .eq("id", params.id);
      return NextResponse.json({ ok: false, error: message }, { status: 502 });
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { OWNER_EMAIL } from "@/lib/access";

export const dynamic = "force-dynamic";

// POST /api/signin/<claimId> — invoked when the user clicks "Sign me in"
// on the /signin/<claimId> page. Mints a fresh Supabase magic link
// *now*, marks the claim used, and 302s to the verify URL. Slack /
// Outlook scanners never reach this code path because it requires a
// POST.
export async function POST(
  req: NextRequest,
  { params }: { params: { claimId: string } }
) {
  const supabase = getSupabaseAdmin();

  const { data: claim, error: claimErr } = await supabase
    .from("magic_link_claims")
    .select("id, email, expires_at, used_at, created_by")
    .eq("id", params.claimId)
    .maybeSingle();

  if (claimErr || !claim) {
    return signinErrorRedirect(req, "Link not found.");
  }

  // Owner sign-in links are only honoured when the owner minted them. The
  // mint route now refuses anyone else, and this check also defuses claims
  // that a leader or admin created before that rule existed.
  if ((claim.email ?? "").trim().toLowerCase() === OWNER_EMAIL) {
    let mintedByOwner = false;
    if (claim.created_by) {
      const { data: creator } = await supabase
        .from("users")
        .select("email")
        .eq("id", claim.created_by)
        .maybeSingle();
      mintedByOwner = (creator?.email ?? "").trim().toLowerCase() === OWNER_EMAIL;
    }
    if (!mintedByOwner) {
      return signinErrorRedirect(req, "This sign-in link can't be used. Sign in with your password instead.");
    }
  }
  if (claim.used_at) {
    return signinErrorRedirect(req, "This link has already been used.");
  }
  if (new Date(claim.expires_at) < new Date()) {
    return signinErrorRedirect(req, "This link expired. Ask for a new one.");
  }

  const baseUrl = (
    process.env.NEXT_PUBLIC_APP_URL ||
    "https://delegationdoer-production.up.railway.app"
  ).replace(/\/$/, "");

  const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
    type: "magiclink",
    email: claim.email,
    options: { redirectTo: `${baseUrl}/auth/finish` }
  });
  if (linkErr || !linkData?.properties?.action_link) {
    return signinErrorRedirect(req, "Couldn't generate a sign-in token.");
  }

  await supabase
    .from("magic_link_claims")
    .update({ used_at: new Date().toISOString() })
    .eq("id", claim.id);

  return NextResponse.redirect(linkData.properties.action_link, { status: 302 });
}

// Block GET entirely — link scanners that crawl this endpoint must
// not be able to advance the flow. Real users see the form at
// /signin/<claimId>, not here.
export async function GET() {
  return NextResponse.json({ error: "POST required" }, { status: 405 });
}

function signinErrorRedirect(req: NextRequest, message: string) {
  const url = new URL("/signin/expired", req.url);
  url.searchParams.set("reason", message);
  return NextResponse.redirect(url, { status: 302 });
}

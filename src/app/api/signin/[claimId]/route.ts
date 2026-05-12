import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

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
    .select("id, email, expires_at, used_at")
    .eq("id", params.claimId)
    .maybeSingle();

  if (claimErr || !claim) {
    return signinErrorRedirect(req, "Link not found.");
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

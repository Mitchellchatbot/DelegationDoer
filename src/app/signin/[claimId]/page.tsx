import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

// Pre-flight sign-in landing page. The URL we hand out (e.g. via Slack)
// points here. Link scanners that pre-fetch this URL see only the
// HTML below — no Supabase token, nothing to consume. Only when the
// actual user clicks "Sign me in" does the form POST to
// /api/signin/<claimId>, which mints a fresh magic link and 302s to
// it.
//
// The whole point is to keep one-time-use Supabase tokens out of
// chat-app URL previews / safe-link scanners.
export default async function SignInClaimPage({
  params
}: {
  params: { claimId: string };
}) {
  const supabase = getSupabaseAdmin();
  const { data: claim } = await supabase
    .from("magic_link_claims")
    .select("email, expires_at, used_at")
    .eq("id", params.claimId)
    .maybeSingle();

  const now = new Date();
  const expired = claim && new Date(claim.expires_at) < now;
  const used = claim?.used_at != null;
  const invalid = !claim || expired || used;

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
        <div className="text-lg font-semibold text-ink mb-1">
          Sign in to DelegationDoer
        </div>
        {invalid ? (
          <>
            <div className="text-sm text-red-700 mt-2">
              {!claim
                ? "This sign-in link wasn't recognized."
                : used
                  ? "This sign-in link has already been used."
                  : "This sign-in link has expired."}
            </div>
            <div className="text-xs text-ink/55 mt-2">
              Ask your leader to generate a new one.
            </div>
          </>
        ) : (
          <>
            <div className="text-sm text-ink/70 mb-4">
              We&apos;ll sign you in as{" "}
              <span className="font-medium text-ink">{claim!.email}</span>.
            </div>
            <form
              method="POST"
              action={`/api/signin/${params.claimId}`}
              className="flex flex-col gap-2"
            >
              <button
                type="submit"
                className="w-full inline-flex items-center justify-center px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold transition-colors active:scale-[0.98]"
              >
                Sign me in
              </button>
              <div className="text-[11px] text-ink/45 text-center mt-1">
                Single-use. Click only when you&apos;re ready to sign in.
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

export const dynamic = "force-dynamic";

export default function SignInExpiredPage({
  searchParams
}: {
  searchParams: { reason?: string };
}) {
  const reason = searchParams?.reason || "This sign-in link is no longer valid.";
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
        <div className="text-lg font-semibold text-ink mb-1">Sign-in link unavailable</div>
        <div className="text-sm text-red-700 mt-1">{reason}</div>
        <div className="text-xs text-ink/55 mt-2">
          Ask your leader to send you a new link.
        </div>
      </div>
    </div>
  );
}

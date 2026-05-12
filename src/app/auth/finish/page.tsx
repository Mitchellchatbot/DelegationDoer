import { Suspense } from "react";
import { AuthFinishClient } from "./AuthFinishClient";

// Server entry. Route-segment config (force-dynamic) must live in a
// server component, so we keep this thin and delegate the actual
// session-handling to the client child.
export const dynamic = "force-dynamic";

export default function AuthFinishPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center p-6">
          <div className="text-sm text-ink/60">Signing you in…</div>
        </div>
      }
    >
      <AuthFinishClient />
    </Suspense>
  );
}

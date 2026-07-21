import { CheckCircle2, AlertCircle, ExternalLink, Mail } from "lucide-react";
import { listAccounts } from "@/lib/missive-client";

// Server component that probes the Missive API on render and surfaces a
// human-readable connection status. No interactivity yet — the actual
// "connect" step still happens via Railway env vars (MISSIVE_API_URL +
// MISSIVE_API_TOKEN) since storing them in the DB has security and
// rotation tradeoffs we haven't decided on. This card makes the existing
// connection visible and gives the user a one-click way into the Missive
// app.
export async function MissiveIntegrationSection() {
  const url = process.env.MISSIVE_API_URL?.replace(/\/$/, "") ?? "";
  const hasToken = Boolean(process.env.MISSIVE_API_TOKEN);

  let status: "connected" | "missing-vars" | "auth-failed" | "unreachable" = "missing-vars";
  let inboxCount = 0;
  let errorMessage: string | null = null;

  if (url && hasToken) {
    try {
      const accounts = await listAccounts();
      inboxCount = accounts.length;
      status = "connected";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errorMessage = msg;
      // Distinguish 401/403 from network failure so we can hint at token
      // expiry vs. misconfigured URL.
      status = /401|403|invalid_auth|missing|expired/i.test(msg) ? "auth-failed" : "unreachable";
    }
  }

  return (
    <section className="rounded-2xl border border-white/60 shadow-soft bg-gradient-to-br from-indigo-50/60 to-white p-5">
      <div className="flex items-start justify-between gap-3 mb-3 flex-wrap">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-indigo-500 text-white grid place-items-center shadow-sm">
            <Mail className="w-4 h-4" />
          </div>
          <div>
            <div className="text-sm font-semibold inline-flex items-center gap-2">
              Missive integration
              <StatusPill status={status} />
            </div>
            <div className="text-xs text-muted mt-0.5">
              Email threads + assignments live over there. Scaled Operations reads them through this connection.
            </div>
          </div>
        </div>
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium text-white shadow-sm transition-all hover:-translate-y-0.5"
            style={{ background: "linear-gradient(135deg, #0a4099 0%, #063270 100%)" }}
          >
            <ExternalLink className="w-3.5 h-3.5" /> Open Missive
          </a>
        )}
      </div>

      {status === "connected" && (
        <div className="text-xs text-ink/70 inline-flex items-center gap-2">
          <span className="inline-flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            <span className="text-ink/70">{url}</span>
          </span>
          <span>·</span>
          <span className="font-semibold text-ink tabular-nums">{inboxCount}</span>
          <span>connected mailbox{inboxCount === 1 ? "" : "es"}</span>
        </div>
      )}

      {status === "missing-vars" && (
        <SetupInstructions />
      )}

      {status === "auth-failed" && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs space-y-1.5">
          <div className="font-medium text-amber-900 inline-flex items-center gap-1.5">
            <AlertCircle className="w-3.5 h-3.5" /> Authorization failed
          </div>
          <div className="text-amber-900/80">
            <code className="bg-amber-100 px-1 py-0.5 rounded">MISSIVE_API_TOKEN</code> is set but the
            Missive API rejected it. JWTs from the clone expire after ~30 days — grab a fresh one.
          </div>
          <details className="text-amber-900/70">
            <summary className="cursor-pointer">How to refresh</summary>
            <ol className="list-decimal pl-5 mt-1 space-y-0.5">
              <li>Open the Missive UI and log in</li>
              <li>DevTools → Application → Local Storage → copy <code>missive_clone_token</code></li>
              <li>Paste into Railway → Scaled Operations service → Variables → <code>MISSIVE_API_TOKEN</code></li>
              <li>Redeploy</li>
            </ol>
          </details>
          {errorMessage && (
            <div className="text-amber-900/60 text-[10px] mt-1">Error: {errorMessage}</div>
          )}
        </div>
      )}

      {status === "unreachable" && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs space-y-1.5">
          <div className="font-medium text-rose-900 inline-flex items-center gap-1.5">
            <AlertCircle className="w-3.5 h-3.5" /> Couldn't reach Missive
          </div>
          <div className="text-rose-900/80">
            <code className="bg-rose-100 px-1 py-0.5 rounded">{url || "MISSIVE_API_URL"}</code> didn't respond.
            Check the URL on Railway and verify the Missive service is up.
          </div>
          {errorMessage && (
            <div className="text-rose-900/60 text-[10px] mt-1">Error: {errorMessage}</div>
          )}
        </div>
      )}
    </section>
  );
}

function StatusPill({ status }: { status: "connected" | "missing-vars" | "auth-failed" | "unreachable" }) {
  if (status === "connected") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 border border-emerald-200">
        <CheckCircle2 className="w-3 h-3" /> Connected
      </span>
    );
  }
  if (status === "auth-failed") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 border border-amber-200">
        <AlertCircle className="w-3 h-3" /> Token expired
      </span>
    );
  }
  if (status === "unreachable") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-rose-100 text-rose-700 border border-rose-200">
        <AlertCircle className="w-3 h-3" /> Unreachable
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 border border-slate-200">
      Not configured
    </span>
  );
}

function SetupInstructions() {
  return (
    <div className="rounded-xl border border-indigo-200/60 bg-white/70 p-3 text-xs space-y-2">
      <div className="font-medium text-ink/80">
        Connect Missive in three steps
      </div>
      <ol className="list-decimal pl-5 space-y-1 text-ink/70">
        <li>
          Stand up your Missive clone (it's already on Railway at{" "}
          <code className="bg-indigo-50 px-1 py-0.5 rounded">missiveclone-production.up.railway.app</code>{" "}
          or wherever you deployed it).
        </li>
        <li>
          Log in to Missive in your browser, open DevTools → Application → Local Storage, copy the
          value of <code className="bg-indigo-50 px-1 py-0.5 rounded">missive_clone_token</code>.
        </li>
        <li>
          On the Scaled Operations Railway service → Variables, add{" "}
          <code className="bg-indigo-50 px-1 py-0.5 rounded">MISSIVE_API_URL</code> (your missive URL)
          and <code className="bg-indigo-50 px-1 py-0.5 rounded">MISSIVE_API_TOKEN</code> (the token).
          Redeploy.
        </li>
      </ol>
      <div className="text-ink/50">
        After Railway redeploys, this card flips to "Connected" and the inbox tab starts showing real threads.
      </div>
    </div>
  );
}

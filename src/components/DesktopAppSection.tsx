"use client";

import { useEffect, useState } from "react";
import { Apple, Monitor, Download } from "lucide-react";

// "Get the desktop app" section. Detects the user's OS and highlights the
// matching installer. URLs come from env vars so we can swap hosting later
// without code changes, with hardcoded Supabase Storage fallbacks so the
// download just works without a redeploy when a new build lands:
//
//   NEXT_PUBLIC_DESKTOP_APP_URL_MAC=https://.../DelegationDoer.dmg
//   NEXT_PUBLIC_DESKTOP_APP_URL_WIN=https://.../DelegationDoer-Setup.exe
//   NEXT_PUBLIC_DESKTOP_APP_URL_WIN_PREVIOUS=https://.../DelegationDoer-Setup-prev.exe
//
// If both are empty, the platform's button is disabled with a "Coming soon".

const FALLBACK_WIN_URL =
  "https://hbmggvsmmilxvsoxcneh.supabase.co/storage/v1/object/public/desktop-app/DelegationDoer%20Setup%200.1.1.exe";
// Previous Windows build, kept as a fallback download in case the latest
// release regresses. The older installer stays in the Supabase bucket.
const FALLBACK_WIN_URL_PREVIOUS =
  "https://hbmggvsmmilxvsoxcneh.supabase.co/storage/v1/object/public/desktop-app/DelegationDoer%20Setup%200.1.0.exe";
const FALLBACK_MAC_URL = "";

type OS = "mac" | "win" | "other";

function detectOs(): OS {
  if (typeof window === "undefined") return "other";
  const p = window.navigator.platform.toLowerCase();
  if (p.includes("mac")) return "mac";
  if (p.includes("win")) return "win";
  return "other";
}

export function DesktopAppSection() {
  const [os, setOs] = useState<OS>("other");
  useEffect(() => setOs(detectOs()), []);

  const macUrl = process.env.NEXT_PUBLIC_DESKTOP_APP_URL_MAC || FALLBACK_MAC_URL;
  const winUrl = process.env.NEXT_PUBLIC_DESKTOP_APP_URL_WIN || FALLBACK_WIN_URL;
  const prevWinUrl = process.env.NEXT_PUBLIC_DESKTOP_APP_URL_WIN_PREVIOUS || FALLBACK_WIN_URL_PREVIOUS;

  return (
    <section className="card p-4">
      <div className="flex items-center gap-2 mb-1">
        <Download className="w-4 h-4 text-accent" />
        <div className="text-sm font-medium">Desktop widget</div>
      </div>
      <p className="text-xs text-muted mb-4">
        Floating bubble that lives on your desktop and alerts you when a task is assigned.
        Your login carries over from this browser session inside the app.
      </p>

      <div className="grid grid-cols-2 gap-3">
        <DownloadButton
          icon={<Apple className="w-4 h-4" />}
          label="Mac (.dmg)"
          href={macUrl}
          recommended={os === "mac"}
        />
        <DownloadButton
          icon={<Monitor className="w-4 h-4" />}
          label="Windows (.exe)"
          href={winUrl}
          recommended={os === "win"}
        />
      </div>

      <p className="text-[11px] text-muted mt-3 leading-relaxed">
        First launch may show an "unidentified developer" warning — on Mac, right-click the app and
        choose Open. On Windows, click "More info" → "Run anyway." The app is unsigned because
        it's an internal tool.
      </p>

      {prevWinUrl && (
        <p className="text-[11px] text-muted mt-2">
          Trouble with the latest version?{" "}
          <a href={prevWinUrl} className="underline underline-offset-2 hover:text-ink">
            Download the previous Windows build (0.1.0)
          </a>
        </p>
      )}
    </section>
  );
}

function DownloadButton({
  icon, label, href, recommended
}: { icon: React.ReactNode; label: string; href: string; recommended: boolean }) {
  if (!href) {
    return (
      <div className="flex items-center justify-between border border-border rounded-xl px-3 py-2.5 bg-surface2/40 text-muted">
        <span className="flex items-center gap-2 text-sm">
          {icon}
          {label}
        </span>
        <span className="text-[11px]">Coming soon</span>
      </div>
    );
  }
  return (
    <a
      href={href}
      className={
        "flex items-center justify-between border rounded-xl px-3 py-2.5 transition-all hover:-translate-y-0.5 hover:shadow-lift " +
        (recommended ? "border-accent/40 bg-accent/5 text-ink" : "border-border bg-surface text-ink")
      }
    >
      <span className="flex items-center gap-2 text-sm font-medium">
        {icon}
        {label}
      </span>
      <span className="text-[11px] text-muted">
        {recommended ? "Recommended" : "Download"}
      </span>
    </a>
  );
}

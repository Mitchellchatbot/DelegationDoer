"use client";

import { useEffect, useState } from "react";
import { Apple, Monitor, Download } from "lucide-react";

// "Get the desktop app" section. Detects the user's OS and highlights the
// matching installer. URLs come from env vars so we can swap hosting later
// without code changes:
//
//   NEXT_PUBLIC_DESKTOP_APP_URL_MAC=https://.../DelegationDoer.dmg
//   NEXT_PUBLIC_DESKTOP_APP_URL_WIN=https://.../DelegationDoer-Setup.exe
//
// If a URL is empty, that platform's button is disabled with a "Coming soon".

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

  const macUrl = process.env.NEXT_PUBLIC_DESKTOP_APP_URL_MAC || "";
  const winUrl = process.env.NEXT_PUBLIC_DESKTOP_APP_URL_WIN || "";

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

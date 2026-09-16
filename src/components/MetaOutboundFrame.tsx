"use client";

import { useEffect, useRef, useState } from "react";
import { ExternalLink, ShieldAlert, Maximize2, Minimize2, RefreshCw } from "lucide-react";
import { META_OUTBOUND_APP, frameAllow, isSameSite } from "@/components/multitask/multitask-apps";

// The Scale Room's Outbound tab, Live board view: the Meta ads dashboard's own
// Outbound page, framed whole — rep chips, Texts, Board, Table and (for finance
// staff there) Ads — for working the leads, which the tab's native Pipeline and
// Ads views deliberately can't do.
//
// The URL, the allow grant and the framing notes (no CSP or X-Frame-Options
// there, sign-in redirects that survive a frame) live on META_OUTBOUND_APP,
// shared with the multitask bubble. No `sandbox`, for the reasons given on the
// bubble's iframe in MultitaskBubbles.tsx.

// The framed app is a full desktop shell (a fixed 224px sidebar that never
// collapses by width), so below md it would leave the board a few dozen pixels.
const WIDE_ENOUGH = "(min-width: 768px)";
// Room kept under the frame so the page fits without scrolling: main's bottom
// padding plus the app shell's (md:pb-6 + pb-3; py-4 + p-3 below md).
const BELOW_MD = 36;
const BELOW_SM = 28;
const MIN_HEIGHT = 560;

export function MetaOutboundFrame() {
  const app = META_OUTBOUND_APP;
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  // All three are browser facts, decided after mount; null until then so a
  // phone never starts loading a frame it will immediately drop.
  const [wide, setWide] = useState<boolean | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  // Full-screen: the browser's own (Fullscreen API on the box), so the board is
  // a real workspace, not a letterbox. A CSS `fixed` overlay can't do it — it
  // is capped by main's `relative z-10` stacking context, so the Topbar paints
  // over its toolbar — and a keydown listener here never hears Esc once focus
  // is inside the cross-origin frame. The browser's full screen sits above all
  // of that and exits on Esc itself. This mirrors document.fullscreenElement
  // (via fullscreenchange) rather than driving it, so Esc, F11 and the button
  // all agree.
  const [full, setFull] = useState(false);
  // The dashboard's session cookie is SameSite=Lax, so it only rides into the
  // frame when this page is same-site with it (operations.scaledai.org). From
  // the Railway alias signing in inside the frame would hang, so say so.
  const [crossSite, setCrossSite] = useState(false);

  useEffect(() => {
    setCrossSite(!isSameSite(app.url, window.location.hostname));
  }, [app.url]);

  // Size the frame from where it actually starts rather than a guessed
  // constant: the header above it wraps at narrower widths, and a second
  // scrollbar around a frame that scrolls itself is the thing to avoid.
  useEffect(() => {
    const mq = window.matchMedia(WIDE_ENOUGH);
    const fit = () => {
      // Entering and leaving full screen resizes the window. While anything is
      // full screen the viewport is the screen, not the page, so a height (or
      // a narrow verdict that would unmount the frame) measured now is wrong —
      // leave both alone and measure again once it exits.
      if (document.fullscreenElement) return;
      setWide(mq.matches);
      const el = box.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top + window.scrollY;
      const below = mq.matches ? BELOW_MD : BELOW_SM;
      setHeight(Math.max(MIN_HEIGHT, Math.floor(window.innerHeight - top - below)));
    };
    // Only our box counts as "full": the framed dashboard can put something of
    // its own full screen, which the parent document reports as the iframe.
    const onFullscreen = () => {
      setFull(!!box.current && document.fullscreenElement === box.current);
      if (!document.fullscreenElement) fit();
    };
    fit();
    window.addEventListener("resize", fit);
    mq.addEventListener("change", fit);
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => {
      window.removeEventListener("resize", fit);
      mq.removeEventListener("change", fit);
      document.removeEventListener("fullscreenchange", onFullscreen);
    };
  }, []);

  // DD's Ask AI launcher is fixed bottom-right, exactly where the framed
  // dashboard puts its own — and DD's paints over it. Hidden only while the
  // frame is actually mounted (wide), so the narrow-screen notice and the
  // moment before mount keep it; the drawer is still a ⌘K away.
  useEffect(() => {
    if (!wide) return;
    document.body.classList.add("hide-ai-fab");
    return () => document.body.classList.remove("hide-ai-fab");
  }, [wide]);

  // Reload the board without reloading DD (re-poke the iframe's src).
  const reload = () => {
    const el = frame.current;
    if (el) el.src = app.url;
  };

  // The toolbar's full-screen button. Toggling only asks the browser; `full`
  // follows from fullscreenchange above. The iframe stays the same element
  // either way, so the board never reloads. Where the API is missing or
  // refused (iPhone Safari, DD itself framed without allow="fullscreen", a
  // policy block) the nearest thing to a full-screen board is its own tab.
  const toggleFull = () => {
    if (document.fullscreenElement) {
      Promise.resolve(document.exitFullscreen()).catch(() => {});
      return;
    }
    const openOwnTab = () => {
      window.open(app.url, "_blank", "noopener");
    };
    const el = box.current;
    if (!el || !document.fullscreenEnabled || typeof el.requestFullscreen !== "function") {
      openOwnTab();
      return;
    }
    try {
      // Promise.resolve: some older engines return undefined, not a promise.
      Promise.resolve(el.requestFullscreen()).catch(openOwnTab);
    } catch {
      openOwnTab();
    }
  };

  if (wide === false) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-4 text-[12.5px] text-muted shadow-soft">
        The live board is the Meta ads dashboard&apos;s desktop page, which doesn&apos;t fit a screen this narrow.{" "}
        <a href={app.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold text-indigo-700 hover:underline">
          Open it in its own tab
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>
    );
  }

  return (
    <div
      ref={box}
      className={
        full
          ? "flex h-full w-full flex-col overflow-hidden bg-white"
          : "flex flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-soft"
      }
      // The fitted height is for the page; in full screen the box is the screen.
      style={full ? undefined : { height: height ?? MIN_HEIGHT }}
    >
      {/* Toolbar: reload, full-screen toggle, open in own tab. */}
      <div className="flex items-center justify-between gap-2 border-b border-slate-200 bg-slate-50/70 px-3 py-1.5">
        <span className="text-[11px] font-medium text-muted truncate">Live board · Meta ads dashboard</span>
        <div className="flex items-center gap-1">
          <button type="button" onClick={reload} title="Reload board" className="rounded-md p-1.5 text-muted hover:bg-slate-200/60 hover:text-ink transition-colors">
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <button type="button" onClick={toggleFull} title={full ? "Exit full screen (Esc)" : "Full screen"} className="rounded-md p-1.5 text-muted hover:bg-slate-200/60 hover:text-ink transition-colors">
            {full ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
          <a href={app.url} target="_blank" rel="noreferrer" title="Open in own tab" className="rounded-md p-1.5 text-muted hover:bg-slate-200/60 hover:text-ink transition-colors">
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      </div>
      {crossSite && (
        <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
          <p className="text-[11px] leading-relaxed text-amber-900">
            This page isn&apos;t on a scaledai.org address, so the browser keeps the Meta ads
            dashboard&apos;s sign-in out of the frame. Use operations.scaledai.org, or open{" "}
            <a href={app.url} target="_blank" rel="noreferrer" className="underline">
              the board in its own tab
            </a>
            .
          </p>
        </div>
      )}
      {wide && (
        <iframe
          ref={frame}
          src={app.url}
          title="Outbound · Meta ads dashboard"
          allow={frameAllow(app)}
          className="w-full flex-1 border-0 bg-white"
          referrerPolicy="strict-origin-when-cross-origin"
        />
      )}
    </div>
  );
}

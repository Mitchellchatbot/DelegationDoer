"use client";

import { useEffect, useRef, useState } from "react";
import { Play, Pause, Volume2, VolumeX } from "lucide-react";
import { cn } from "@/lib/utils";

export interface Overlay {
  id: string;
  text: string;
  xPct: number;      // 0-100
  yPct: number;      // 0-100
  sizePx: number;    // font-size
  weight: 400 | 500 | 600 | 700 | 800 | 900;
  color: string;     // hex / rgba
  shadow: boolean;
  align: "left" | "center" | "right";
}

export interface CanvasLayout {
  overlays?: Overlay[];
  imageFit?: "cover" | "contain";
  imageFocalX?: number;  // 0-1
  imageFocalY?: number;  // 0-1
}

export interface RecommendationCanvasProps {
  imageUrl: string | null;
  audioUrl?: string | null;
  layout: CanvasLayout;
  // Editor mode: makes overlays draggable + click-to-edit; emits
  // updates so the parent can persist. View mode = read-only.
  editing?: boolean;
  onLayoutChange?: (l: CanvasLayout) => void;
  onOverlayClick?: (id: string) => void;
  selectedOverlayId?: string | null;
  // Visual size — the canvas is always 16:9 aspect ratio so posters
  // look consistent in featured + grid. Pass small=true for grid tiles.
  small?: boolean;
  // When the canvas itself has no useful image, show a colored
  // fallback rather than a broken-image symbol.
  fallbackTone?: string;
}

// Shared poster renderer. Image fills the frame (cover by default),
// every overlay sits absolutely-positioned by percentage so the same
// layout reads at any size. Audio control floats bottom-right when
// audioUrl is set.
export function RecommendationCanvas({
  imageUrl, audioUrl, layout, editing,
  onLayoutChange, onOverlayClick, selectedOverlayId,
  small, fallbackTone
}: RecommendationCanvasProps) {
  const ref = useRef<HTMLDivElement>(null);
  const overlays = layout.overlays ?? [];
  const fit = layout.imageFit ?? "cover";
  const focal = `${(layout.imageFocalX ?? 0.5) * 100}% ${(layout.imageFocalY ?? 0.5) * 100}%`;

  function onPointerDown(e: React.PointerEvent, ov: Overlay) {
    if (!editing) return;
    e.stopPropagation();
    onOverlayClick?.(ov.id);
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const startXPct = ov.xPct;
    const startYPct = ov.yPct;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    function onMove(ev: PointerEvent) {
      const dx = ((ev.clientX - startX) / rect!.width) * 100;
      const dy = ((ev.clientY - startY) / rect!.height) * 100;
      const nextOverlays = overlays.map((o) =>
        o.id === ov.id
          ? {
              ...o,
              xPct: Math.max(0, Math.min(100, startXPct + dx)),
              yPct: Math.max(0, Math.min(100, startYPct + dy))
            }
          : o
      );
      onLayoutChange?.({ ...layout, overlays: nextOverlays });
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  return (
    <div
      ref={ref}
      className={cn(
        "relative w-full overflow-hidden rounded-2xl select-none",
        small ? "shadow-soft" : "shadow-[0_30px_80px_-20px_rgba(15,23,42,0.45)]"
      )}
      style={{ aspectRatio: "16 / 9" }}
    >
      {imageUrl ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={imageUrl}
            alt=""
            draggable={false}
            className="absolute inset-0 w-full h-full"
            style={{
              objectFit: fit,
              objectPosition: focal
            }}
          />
          {/* Subtle vignette so light overlay text stays legible. */}
          <div
            aria-hidden
            className="absolute inset-0"
            style={{
              background:
                "linear-gradient(180deg, rgba(0,0,0,0.05) 0%, rgba(0,0,0,0) 30%, rgba(0,0,0,0) 60%, rgba(0,0,0,0.25) 100%)"
            }}
          />
        </>
      ) : (
        <div
          className={cn(
            "absolute inset-0 bg-gradient-to-br",
            fallbackTone ?? "from-indigo-200 via-fuchsia-200 to-amber-200"
          )}
        />
      )}

      {overlays.map((ov) => {
        const selected = editing && selectedOverlayId === ov.id;
        return (
          <div
            key={ov.id}
            onPointerDown={(e) => onPointerDown(e, ov)}
            onClick={(e) => { if (editing) { e.stopPropagation(); onOverlayClick?.(ov.id); } }}
            className={cn(
              "absolute -translate-x-1/2 -translate-y-1/2 whitespace-pre-wrap leading-tight",
              editing && "cursor-move",
              selected && "outline outline-2 outline-offset-2 outline-blue-400 rounded-md"
            )}
            style={{
              left: `${ov.xPct}%`,
              top: `${ov.yPct}%`,
              fontSize: `${ov.sizePx * (small ? 0.5 : 1)}px`,
              fontWeight: ov.weight,
              color: ov.color,
              textAlign: ov.align,
              textShadow: ov.shadow
                ? "0 2px 12px rgba(0,0,0,0.55), 0 1px 2px rgba(0,0,0,0.4)"
                : undefined,
              maxWidth: "85%"
            }}
          >
            {ov.text || (editing ? "double-click to edit" : "")}
          </div>
        );
      })}

      {audioUrl && !small && <AudioControl src={audioUrl} />}
    </div>
  );
}

function AudioControl({ src }: { src: string }) {
  const ref = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    const a = ref.current;
    if (!a) return;
    a.muted = muted;
  }, [muted]);

  function toggle() {
    const a = ref.current;
    if (!a) return;
    if (playing) {
      a.pause();
      setPlaying(false);
    } else {
      a.play().then(() => setPlaying(true)).catch(() => { /* user gesture race */ });
    }
  }

  return (
    <div className="absolute bottom-3 right-3 z-10 inline-flex items-center gap-1 rounded-full bg-white/85 backdrop-blur-md border border-white shadow-md px-1 py-1">
      <audio ref={ref} src={src} preload="metadata" onEnded={() => setPlaying(false)} />
      <button
        type="button"
        onClick={toggle}
        className="w-7 h-7 rounded-full bg-ink text-white grid place-items-center hover:bg-accent transition-colors"
        title={playing ? "Pause" : "Play"}
      >
        {playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 ml-0.5" />}
      </button>
      <button
        type="button"
        onClick={() => setMuted((v) => !v)}
        className="w-7 h-7 rounded-full text-ink/70 hover:text-ink hover:bg-slate-100 grid place-items-center transition-colors"
        title={muted ? "Unmute" : "Mute"}
      >
        {muted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
      </button>
    </div>
  );
}

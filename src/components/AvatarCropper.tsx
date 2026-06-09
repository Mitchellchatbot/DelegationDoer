"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Loader2, RotateCcw, ZoomIn, ZoomOut, X } from "lucide-react";

// Canvas-based circular-crop UI. User loads an image via the parent
// (`source` prop = File or URL), then drags + zooms it to position the
// circle on the part they want as their avatar. On save we extract a
// 512×512 PNG of exactly that circular slice and hand the Blob back via
// `onSave`. Output is square; the receiver renders it with `rounded-full`
// to get the final circle on screen.

interface Props {
  // The image to crop. Either a File (just-picked) or an existing URL
  // (re-cropping their current avatar).
  source: File | string;
  onCancel: () => void;
  onSave: (cropped: Blob) => void | Promise<void>;
  // Pixel size of the rendered preview. The output is always 512×512
  // regardless of this — the preview is just for visual feedback.
  previewSize?: number;
}

export function AvatarCropper({ source, onCancel, onSave, previewSize = 320 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [loaded, setLoaded] = useState(false);
  // scale = pixels-on-canvas per pixel-of-source-image.
  const [scale, setScale] = useState(1);
  const [minScale, setMinScale] = useState(0.1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);

  // Drag state — handled via pointer events for cross-input parity.
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  // Load the source into an HTMLImageElement once. Center it inside the
  // circle and pick an initial scale so the smaller side fills the
  // diameter (so the circle starts fully covered with content).
  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (cancelled) return;
      imgRef.current = img;
      const cs = previewSize;
      const r = cs / 2 - 16;
      const diameter = 2 * r;
      // Cover-fit: scale up so the smaller image side fills the circle.
      const fit = diameter / Math.min(img.naturalWidth, img.naturalHeight);
      setScale(fit);
      setMinScale(fit * 0.5);
      // Center the (scaled) image inside the canvas.
      const w = img.naturalWidth * fit;
      const h = img.naturalHeight * fit;
      setOffset({ x: (cs - w) / 2, y: (cs - h) / 2 });
      setLoaded(true);
    };
    img.onerror = () => setLoaded(false);
    if (typeof source === "string") {
      img.src = source;
    } else {
      objectUrl = URL.createObjectURL(source);
      img.src = objectUrl;
    }
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [source, previewSize]);

  // Re-render the preview whenever the image / pan / zoom changes.
  useEffect(() => {
    const c = canvasRef.current;
    const i = imgRef.current;
    if (!c || !i || !loaded) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;

    const cs = previewSize;
    const r = cs / 2 - 16;
    ctx.clearRect(0, 0, cs, cs);

    // 1) Draw the image.
    ctx.drawImage(i, offset.x, offset.y, i.naturalWidth * scale, i.naturalHeight * scale);

    // 2) Dim everything outside the circle (even-odd fill rule).
    ctx.save();
    ctx.fillStyle = "rgba(15,23,42,0.55)";
    ctx.beginPath();
    ctx.rect(0, 0, cs, cs);
    ctx.arc(cs / 2, cs / 2, r, 0, Math.PI * 2, true);
    ctx.fill("evenodd");
    ctx.restore();

    // 3) Crisp circle outline.
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cs / 2, cs / 2, r, 0, Math.PI * 2);
    ctx.stroke();
  }, [scale, offset, loaded, previewSize]);

  // ---- Interaction ----

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!loaded) return;
    (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
  }
  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const d = dragRef.current;
    if (!d) return;
    setOffset({ x: d.ox + (e.clientX - d.x), y: d.oy + (e.clientY - d.y) });
  }
  function onPointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    try { (e.target as HTMLCanvasElement).releasePointerCapture(e.pointerId); } catch {}
    dragRef.current = null;
  }
  function onWheel(e: React.WheelEvent<HTMLCanvasElement>) {
    if (!loaded) return;
    const next = clampScale(scale * (e.deltaY < 0 ? 1.06 : 1 / 1.06));
    zoomAroundCenter(next);
  }

  function clampScale(s: number) {
    return Math.max(minScale, Math.min(minScale * 8, s));
  }

  function zoomAroundCenter(nextScale: number) {
    const i = imgRef.current;
    if (!i) return;
    const cs = previewSize;
    const cx = cs / 2;
    const cy = cs / 2;
    // Image coords currently under the canvas center:
    const iCenterX = (cx - offset.x) / scale;
    const iCenterY = (cy - offset.y) / scale;
    // Keep the same image coords under the canvas center after zoom.
    setOffset({
      x: cx - iCenterX * nextScale,
      y: cy - iCenterY * nextScale
    });
    setScale(nextScale);
  }

  function resetView() {
    const i = imgRef.current;
    if (!i) return;
    const cs = previewSize;
    const r = cs / 2 - 16;
    const diameter = 2 * r;
    const fit = diameter / Math.min(i.naturalWidth, i.naturalHeight);
    const w = i.naturalWidth * fit;
    const h = i.naturalHeight * fit;
    setScale(fit);
    setOffset({ x: (cs - w) / 2, y: (cs - h) / 2 });
  }

  // ---- Export ----

  async function save() {
    const i = imgRef.current;
    if (!i || !loaded) return;
    setBusy(true);
    try {
      const cs = previewSize;
      const r = cs / 2 - 16;
      // The visible circle covers canvas coords [cs/2 - r, cs/2 + r] in
      // both axes. Map that back to source-image coords using the current
      // pan + zoom, then extract that square into a 512×512 output.
      const srcSize = (2 * r) / scale;
      const srcX = ((cs / 2 - r) - offset.x) / scale;
      const srcY = ((cs / 2 - r) - offset.y) / scale;

      const out = document.createElement("canvas");
      out.width = 512;
      out.height = 512;
      const ctx = out.getContext("2d");
      if (!ctx) throw new Error("no 2d context");
      // White background — when the source has transparency the output
      // PNG should still look right against any backdrop.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, 512, 512);
      ctx.drawImage(i, srcX, srcY, srcSize, srcSize, 0, 0, 512, 512);

      const blob: Blob | null = await new Promise((resolve) =>
        out.toBlob((b) => resolve(b), "image/png", 0.95)
      );
      if (!blob) throw new Error("toBlob failed");
      await onSave(blob);
    } catch (err) {
      console.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-center gap-3">
      <div
        className="relative rounded-2xl overflow-hidden bg-slate-900"
        style={{ width: previewSize, height: previewSize }}
      >
        <canvas
          ref={canvasRef}
          width={previewSize}
          height={previewSize}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheel}
          style={{
            display: "block",
            touchAction: "none",
            cursor: dragRef.current ? "grabbing" : "grab"
          }}
        />
        {!loaded && (
          <div className="absolute inset-0 grid place-items-center text-white/85 text-xs">
            <Loader2 className="w-4 h-4 animate-spin" />
          </div>
        )}
      </div>

      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => zoomAroundCenter(clampScale(scale / 1.15))}
          className="p-1.5 rounded-lg text-ink/65 hover:text-ink hover:bg-slate-100 transition-colors"
          title="Zoom out"
        >
          <ZoomOut className="w-4 h-4" />
        </button>
        <input
          type="range"
          min={minScale}
          max={minScale * 8}
          step={(minScale * 8 - minScale) / 100}
          value={scale}
          onChange={(e) => zoomAroundCenter(clampScale(Number(e.target.value)))}
          className="w-40 accent-blue-500"
        />
        <button
          type="button"
          onClick={() => zoomAroundCenter(clampScale(scale * 1.15))}
          className="p-1.5 rounded-lg text-ink/65 hover:text-ink hover:bg-slate-100 transition-colors"
          title="Zoom in"
        >
          <ZoomIn className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={resetView}
          className="p-1.5 rounded-lg text-ink/65 hover:text-ink hover:bg-slate-100 transition-colors"
          title="Reset"
        >
          <RotateCcw className="w-4 h-4" />
        </button>
      </div>

      <div className="flex items-center gap-2 w-full">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium text-ink/70 hover:text-ink hover:bg-slate-100 transition-colors"
        >
          <X className="w-3.5 h-3.5" /> Cancel
        </button>
        <button
          type="button"
          onClick={save}
          disabled={!loaded || busy}
          className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 active:scale-95 disabled:opacity-60 disabled:hover:translate-y-0"
          style={{ background: "linear-gradient(135deg, #0a4099 0%, #063270 100%)" }}
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

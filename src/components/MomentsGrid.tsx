"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Camera, ChevronLeft, Plus, Upload, X, Loader2, Trash2, Crop, Check,
  RotateCcw, RotateCw
} from "lucide-react";
import { toast } from "sonner";
import { cn, initials } from "@/lib/utils";

// Spatial grid image explorer for "moments" — port of the CodePen by
// Giovanni Antonio. The page-level layout uses CSS container-query
// units so the grid fills the available content area instead of
// fighting the sidebar's width.
//
// Key state:
//   coords {x,y} — which cell is centered.
//   zoom         — scale factor of the viewport; smaller = more cells
//                  visible at once. The mini-map adjusts accordingly.
//   open         — whether the selected cell has zoomed to fullscreen.

export interface MomentItem {
  id: string;
  userId: string;
  userName: string;
  userAvatarUrl: string | null;
  imageUrl: string;
  caption: string | null;
  createdAt: string;
}

interface Props {
  initialMoments: MomentItem[];
  currentUserId: string;
  isLeader: boolean;
}

// Pick a grid size that scales with the number of items but never feels
// too sparse or too cramped. Always square — the math + the mini-map
// assume that.
function gridSizeFor(count: number): number {
  if (count <= 1) return 1;
  if (count <= 4) return 2;
  if (count <= 9) return 3;
  if (count <= 16) return 4;
  if (count <= 25) return 5;
  return 6;
}

const ZOOM_PRESETS = [
  { value: 0.375, label: "0.375×", hint: "wide" },
  { value: 0.5625, label: "0.5625×", hint: "" },
  { value: 0.75, label: "0.75×", hint: "tight" }
];

export function MomentsGrid({ initialMoments, currentUserId, isLeader }: Props) {
  const router = useRouter();
  const [moments, setMoments] = useState<MomentItem[]>(initialMoments);
  const gridSize = useMemo(() => Math.max(2, gridSizeFor(moments.length)), [moments.length]);
  const cellCount = gridSize * gridSize;

  // Pad with nulls so the grid is always square — empty cells render as
  // a faint "open slot" prompt.
  const cells = useMemo<(MomentItem | null)[]>(() => {
    const out: (MomentItem | null)[] = moments.slice(0, cellCount);
    while (out.length < cellCount) out.push(null);
    return out;
  }, [moments, cellCount]);

  // Pick the first non-empty cell as the default selection so the user
  // lands on real content. Falls back to (0,0) if nothing's posted yet.
  const [selectedIdx, setSelectedIdx] = useState(() => {
    const i = initialMoments.length > 0 ? 0 : 0;
    return i;
  });
  const coords = useMemo(() => ({
    x: selectedIdx % gridSize,
    y: Math.floor(selectedIdx / gridSize)
  }), [selectedIdx, gridSize]);

  const [zoom, setZoom] = useState(0.375);
  const [open, setOpen] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);

  // ---- Navigation ----
  const move = useCallback(
    (dx: number, dy: number) => {
      const nx = Math.max(0, Math.min(gridSize - 1, coords.x + dx));
      const ny = Math.max(0, Math.min(gridSize - 1, coords.y + dy));
      setSelectedIdx(ny * gridSize + nx);
    },
    [coords.x, coords.y, gridSize]
  );

  // Keyboard arrows + Enter to open/close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "ArrowLeft")  { e.preventDefault(); move(-1, 0); }
      if (e.key === "ArrowRight") { e.preventDefault(); move( 1, 0); }
      if (e.key === "ArrowUp")    { e.preventDefault(); move( 0,-1); }
      if (e.key === "ArrowDown")  { e.preventDefault(); move( 0, 1); }
      if (e.key === "Enter")      { e.preventDefault(); setOpen((o) => !o); }
      if (e.key === "Escape")     { e.preventDefault(); setOpen(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [move]);

  // Wheel-zoom — plain scroll wheel maps to zoom while inside the
  // stage. The stage is full-height so there's nothing useful to
  // scroll past it anyway; treating wheel as zoom is the most natural
  // gesture once you're inside.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (open) return;
      e.preventDefault();
      // Tuned for both trackpad (fine deltas) and mouse wheel (chunky
      // deltas). The clamp keeps cells from getting unreadably small.
      setZoom((z) => Math.max(0.25, Math.min(0.9, z + e.deltaY * -0.0015)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [open]);

  // ---- Mutations ----
  async function deleteMoment(m: MomentItem) {
    if (m.userId !== currentUserId && !isLeader) return;
    if (!confirm("Delete this moment?")) return;
    try {
      const res = await fetch(`/api/moments/${encodeURIComponent(m.id)}`, {
        method: "DELETE"
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        throw new Error(d?.error ?? "failed");
      }
      setMoments((cur) => cur.filter((x) => x.id !== m.id));
      toast.success("Moment removed");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "couldn't delete");
    }
  }

  async function handleUpload(file: File, caption: string) {
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("taskId", `moments/${currentUserId}`);
      const upRes = await fetch("/api/upload", { method: "POST", body: form });
      const upData = await upRes.json();
      if (!upRes.ok) throw new Error(upData?.error ?? "upload failed");
      const url: string = upData.url;
      const postRes = await fetch("/api/moments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrl: url, caption })
      });
      const postData = await postRes.json();
      if (!postRes.ok) throw new Error(postData?.error ?? "save failed");
      // Optimistic: prepend the new moment locally so the grid updates
      // before router.refresh() returns server-rendered HTML.
      setMoments((cur) => [
        {
          id: postData.id,
          userId: currentUserId,
          userName: "You",
          userAvatarUrl: null,
          imageUrl: url,
          caption: caption || null,
          createdAt: new Date().toISOString()
        },
        ...cur
      ]);
      setSelectedIdx(0);
      toast.success("Moment posted ✨");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "couldn't post");
      throw err;
    }
  }

  return (
    <>
      {/* dangerouslySetInnerHTML keeps React from reconciling the CSS as
          text children — otherwise tiny whitespace differences between
          server + client renders trigger a hydration warning. */}
      <style dangerouslySetInnerHTML={{ __html: stageCss }} />

      <div
        ref={stageRef}
        className={cn("moments-stage", open && "is-open")}
        style={{
          ["--grid-size" as string]: gridSize,
          ["--zoom" as string]: zoom,
          ["--x" as string]: coords.x,
          ["--y" as string]: coords.y
        }}
      >
        {/* Crosshair reticle when wandering the grid. */}
        <div className="moments-reticle" aria-hidden>
          <span /><span /><span />
        </div>

        <div className="moments-viewport">
          <div className="moments-canvas">
            {cells.map((m, i) => {
              const isSelected = i === selectedIdx;
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => {
                    if (i === selectedIdx) setOpen((o) => !o);
                    else setSelectedIdx(i);
                  }}
                  className={cn(
                    "moments-cell",
                    isSelected && "is-selected",
                    !m && "is-empty"
                  )}
                  aria-label={
                    m ? `${m.userName}'s moment` : "Empty slot — post your moment"
                  }
                >
                  {m ? (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={m.imageUrl} alt={m.caption ?? `${m.userName}'s moment`} draggable={false} />
                      {/* Caption + author overlay, only painted on the
                          selected cell so the wide view stays clean. */}
                      {isSelected && (
                        <div className="moments-meta">
                          <div className="moments-author">
                            {m.userAvatarUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={m.userAvatarUrl} alt="" className="moments-avatar" />
                            ) : (
                              <span className="moments-avatar moments-avatar-fallback">
                                {initials(m.userName)}
                              </span>
                            )}
                            <span className="moments-name">{m.userName}</span>
                            <span className="moments-time">{timeAgo(m.createdAt)}</span>
                            {(m.userId === currentUserId || isLeader) && (
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); deleteMoment(m); }}
                                className="moments-del"
                                title="Delete moment"
                                aria-label="Delete moment"
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            )}
                          </div>
                          {m.caption && (
                            <div className="moments-caption">{m.caption}</div>
                          )}
                        </div>
                      )}
                    </>
                  ) : (
                    <span className="moments-empty">
                      <Plus className="w-7 h-7 opacity-50" />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Mini-map navigator (bottom-right). */}
        <div className="moments-map" aria-label="Grid map">
          <div className="moments-map-grid">
            {cells.map((_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setSelectedIdx(i)}
                className={cn(
                  "moments-map-cell",
                  i === selectedIdx && "is-selected"
                )}
                aria-label={`Jump to cell ${i + 1}`}
              />
            ))}
          </div>
        </div>

        {/* Zoom rail (right edge, hidden on narrow viewports). */}
        <div className="moments-zoom">
          {ZOOM_PRESETS.map((p) => {
            const active = Math.abs(zoom - p.value) < 0.01;
            return (
              <button
                key={p.value}
                type="button"
                onClick={() => setZoom(p.value)}
                className={cn("moments-zoom-pill", active && "is-active")}
              >
                {p.label}
              </button>
            );
          })}
        </div>

        {/* Focus crosshair → open. */}
        {!open && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="moments-focus"
            aria-label="Expand selected moment"
          />
        )}

        {/* Close pill — top-left, only while open. */}
        {open && (
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="moments-back"
          >
            <ChevronLeft className="w-3.5 h-3.5" /> Close
          </button>
        )}
      </div>

      {/* Upload affordance — floating in the top-right of the stage. */}
      <UploadButton onUpload={handleUpload} />
    </>
  );
}

function UploadButton({
  onUpload
}: {
  onUpload: (file: File, caption: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [caption, setCaption] = useState("");
  const [busy, setBusy] = useState(false);
  const [cropping, setCropping] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const previewUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => {
    return () => { if (previewUrl) URL.revokeObjectURL(previewUrl); };
  }, [previewUrl]);

  async function submit() {
    if (!file) return;
    setBusy(true);
    try {
      await onUpload(file, caption);
      setOpen(false);
      setFile(null);
      setCaption("");
    } catch { /* toast handled upstream */ } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="moments-upload-fab"
        aria-label="Post a moment"
      >
        <Camera className="w-4 h-4" />
        Post a moment
      </button>

      {cropping && file && (
        <CropDialog
          file={file}
          onCancel={() => setCropping(false)}
          onApply={(cropped) => {
            setFile(cropped);
            setCropping(false);
          }}
        />
      )}

      {open && (
        <div className="moments-modal-overlay" onClick={() => !busy && setOpen(false)}>
          <div className="moments-modal" onClick={(e) => e.stopPropagation()}>
            <header className="moments-modal-header">
              <div className="flex items-center gap-2">
                <Upload className="w-4 h-4 text-accent" />
                <span className="text-sm font-semibold text-ink">Post a moment</span>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="p-1 rounded-lg text-ink/60 hover:text-ink hover:bg-slate-100"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </header>
            <div className="moments-modal-body">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="moments-drop"
              >
                {previewUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={previewUrl} alt="" className="moments-drop-preview" />
                ) : (
                  <div className="text-center">
                    <Camera className="w-8 h-8 mx-auto opacity-50" />
                    <div className="text-sm mt-2 text-ink/70">Click to choose a photo</div>
                    <div className="text-[11px] text-ink/45 mt-0.5">
                      Anything from your day — coffee, the view, a meme
                    </div>
                  </div>
                )}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) setFile(f);
                  if (fileRef.current) fileRef.current.value = "";
                }}
              />
              {file && (
                <div className="flex items-center gap-2 -mt-1">
                  <button
                    type="button"
                    onClick={() => setCropping(true)}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[11px] font-medium bg-white border border-slate-200 text-ink/70 hover:text-accent hover:border-accent/40 transition-colors"
                  >
                    <Crop className="w-3 h-3" /> Crop & rotate
                  </button>
                  <span className="text-[10px] text-ink/45">
                    or leave as-is — bars will fill the frame
                  </span>
                </div>
              )}
              <textarea
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                placeholder="What's the moment? (optional)"
                maxLength={240}
                rows={2}
                className="moments-caption-input"
              />
              <div className="text-[10px] text-ink/45 text-right pr-1">{caption.length}/240</div>
            </div>
            <footer className="moments-modal-footer">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="px-3 py-1.5 rounded-full text-xs font-medium text-ink/70 hover:text-ink hover:bg-slate-100"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={!file || busy}
                className={cn(
                  "inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 active:scale-95",
                  (!file || busy) && "opacity-60 cursor-not-allowed hover:translate-y-0"
                )}
                style={{ background: "linear-gradient(135deg, #2563EB 0%, #1e63ff 100%)" }}
              >
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                {busy ? "Posting…" : "Post"}
              </button>
            </footer>
          </div>
        </div>
      )}
    </>
  );
}

// Square pan-and-zoom cropper with 90° rotation. Renders a 320px
// viewport with the image positioned inside; user drags to pan,
// slider zooms, Left/Right rotate by quarter-turns. "Apply"
// rasterizes the visible region to a 1080×1080 JPEG and returns it
// as a File.
//
// Rotation is implemented by pre-rendering the original image into
// an offscreen canvas at the chosen angle and using the resulting
// blob as the "working" image — that way pan/zoom math stays simple
// (always operating on a naturally-oriented bitmap) and the export
// path doesn't need any rotation logic of its own.
function CropDialog({
  file, onCancel, onApply
}: {
  file: File;
  onCancel: () => void;
  onApply: (cropped: File) => void;
}) {
  const VIEWPORT = 320;
  const OUTPUT = 1080;

  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [natW, setNatW] = useState(0);
  const [natH, setNatH] = useState(0);
  const [rotation, setRotation] = useState(0); // 0 | 90 | 180 | 270
  const [scale, setScale] = useState(1);       // user multiplier on baseScale
  const [tx, setTx] = useState(0);              // viewport-pixel offset
  const [ty, setTy] = useState(0);
  const [busy, setBusy] = useState(false);
  const dragRef = useRef<{ x: number; y: number; startTx: number; startTy: number } | null>(null);
  // The unmodified original — every rotation is computed from this so
  // we don't accumulate jpeg-recompression artifacts across turns.
  const originalRef = useRef<HTMLImageElement | null>(null);
  const originalUrlRef = useRef<string | null>(null);
  // Tracks the most recently generated blob URL so we can revoke the
  // previous one when rotation changes (and on unmount).
  const generatedUrlRef = useRef<string | null>(null);

  function recenter(w: number, h: number) {
    const cover = Math.max(VIEWPORT / w, VIEWPORT / h);
    setTx((VIEWPORT - w * cover) / 2);
    setTy((VIEWPORT - h * cover) / 2);
    setScale(1);
  }

  useEffect(() => {
    const url = URL.createObjectURL(file);
    originalUrlRef.current = url;
    setImgUrl(url);
    const img = new Image();
    img.onload = () => {
      originalRef.current = img;
      setNatW(img.naturalWidth);
      setNatH(img.naturalHeight);
      recenter(img.naturalWidth, img.naturalHeight);
    };
    img.src = url;
    return () => {
      URL.revokeObjectURL(url);
      if (generatedUrlRef.current) {
        URL.revokeObjectURL(generatedUrlRef.current);
        generatedUrlRef.current = null;
      }
    };
  }, [file]);

  async function rotateBy(delta: 90 | -90) {
    const img = originalRef.current;
    if (!img || busy) return;
    const next = (((rotation + delta) % 360) + 360) % 360;
    setRotation(next);
    if (next === 0) {
      // Back to the original orientation — drop the working blob and
      // point at the source URL directly.
      if (generatedUrlRef.current) {
        URL.revokeObjectURL(generatedUrlRef.current);
        generatedUrlRef.current = null;
      }
      const url = originalUrlRef.current!;
      setImgUrl(url);
      setNatW(img.naturalWidth);
      setNatH(img.naturalHeight);
      recenter(img.naturalWidth, img.naturalHeight);
      return;
    }
    const oW = img.naturalWidth;
    const oH = img.naturalHeight;
    const isQuarter = next % 180 !== 0;
    const w = isQuarter ? oH : oW;
    const h = isQuarter ? oW : oH;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.translate(w / 2, h / 2);
    ctx.rotate((next * Math.PI) / 180);
    ctx.drawImage(img, -oW / 2, -oH / 2);
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), "image/jpeg", 0.95);
    });
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    if (generatedUrlRef.current) URL.revokeObjectURL(generatedUrlRef.current);
    generatedUrlRef.current = url;
    setImgUrl(url);
    setNatW(w);
    setNatH(h);
    recenter(w, h);
  }

  const baseScale = natW > 0 && natH > 0
    ? Math.max(VIEWPORT / natW, VIEWPORT / natH)
    : 1;
  const displayScale = baseScale * scale;

  // Clamp tx/ty so the image always covers the viewport (no gaps).
  function clamp(nextTx: number, nextTy: number) {
    const imgW = natW * displayScale;
    const imgH = natH * displayScale;
    const minTx = Math.min(0, VIEWPORT - imgW);
    const minTy = Math.min(0, VIEWPORT - imgH);
    const maxTx = Math.max(0, VIEWPORT - imgW);
    const maxTy = Math.max(0, VIEWPORT - imgH);
    // If image is smaller than viewport on an axis, center it.
    const clampedX = imgW <= VIEWPORT
      ? (VIEWPORT - imgW) / 2
      : Math.min(maxTx, Math.max(minTx, nextTx));
    const clampedY = imgH <= VIEWPORT
      ? (VIEWPORT - imgH) / 2
      : Math.min(maxTy, Math.max(minTy, nextTy));
    return { x: clampedX, y: clampedY };
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, startTx: tx, startTy: ty };
  }
  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const d = dragRef.current;
    if (!d) return;
    const next = clamp(d.startTx + (e.clientX - d.x), d.startTy + (e.clientY - d.y));
    setTx(next.x);
    setTy(next.y);
  }
  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    dragRef.current = null;
  }

  function onScaleChange(nextScale: number) {
    // Zoom toward the viewport center so the user's framing stays roughly stable.
    const oldDisplay = baseScale * scale;
    const newDisplay = baseScale * nextScale;
    const cx = VIEWPORT / 2;
    const cy = VIEWPORT / 2;
    // Image point currently under (cx, cy): ((cx - tx) / oldDisplay, ...)
    const ix = (cx - tx) / oldDisplay;
    const iy = (cy - ty) / oldDisplay;
    const newTx = cx - ix * newDisplay;
    const newTy = cy - iy * newDisplay;
    const clamped = clamp(newTx, newTy);
    setScale(nextScale);
    setTx(clamped.x);
    setTy(clamped.y);
  }

  async function apply() {
    if (!imgUrl) return;
    setBusy(true);
    try {
      // Map the viewport to source-image coords:
      //   viewport pixel (vx, vy) → image pixel ((vx - tx)/S, (vy - ty)/S)
      const sx = -tx / displayScale;
      const sy = -ty / displayScale;
      const sSize = VIEWPORT / displayScale;
      const canvas = document.createElement("canvas");
      canvas.width = OUTPUT;
      canvas.height = OUTPUT;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("canvas not available");
      const img = new Image();
      img.src = imgUrl;
      await new Promise<void>((resolve, reject) => {
        if (img.complete) return resolve();
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("image load failed"));
      });
      ctx.fillStyle = "#0f172a";
      ctx.fillRect(0, 0, OUTPUT, OUTPUT);
      ctx.drawImage(img, sx, sy, sSize, sSize, 0, 0, OUTPUT, OUTPUT);
      const blob: Blob | null = await new Promise((resolve) => {
        canvas.toBlob((b) => resolve(b), "image/jpeg", 0.9);
      });
      if (!blob) throw new Error("export failed");
      const cropped = new File([blob], file.name.replace(/\.[^.]+$/, "") + "-cropped.jpg", {
        type: "image/jpeg"
      });
      onApply(cropped);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "crop failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="moments-modal-overlay"
      style={{ zIndex: 100 }}
      onClick={() => !busy && onCancel()}
    >
      <div
        className="moments-modal"
        style={{ width: 380 }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="moments-modal-header">
          <div className="flex items-center gap-2">
            <Crop className="w-4 h-4 text-accent" />
            <span className="text-sm font-semibold text-ink">Crop & rotate</span>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="p-1 rounded-lg text-ink/60 hover:text-ink hover:bg-slate-100"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </header>
        <div className="moments-modal-body" style={{ alignItems: "center" }}>
          <div
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            style={{
              width: VIEWPORT,
              height: VIEWPORT,
              borderRadius: 12,
              overflow: "hidden",
              position: "relative",
              background: "#0f172a",
              cursor: dragRef.current ? "grabbing" : "grab",
              touchAction: "none"
            }}
          >
            {imgUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={imgUrl}
                alt=""
                draggable={false}
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  width: natW,
                  height: natH,
                  // Tailwind preflight applies max-width:100% to every <img>;
                  // we render the image at natural size and shrink via
                  // transform, so we have to opt out of that clamp.
                  maxWidth: "none",
                  maxHeight: "none",
                  transform: `translate(${tx}px, ${ty}px) scale(${displayScale})`,
                  transformOrigin: "0 0",
                  userSelect: "none",
                  pointerEvents: "none"
                }}
              />
            )}
          </div>
          <div className="flex items-center gap-2 w-full">
            <span className="text-[11px] text-ink/55 w-10">Rotate</span>
            <div className="flex items-center gap-1.5 flex-1">
              <button
                type="button"
                onClick={() => rotateBy(-90)}
                disabled={busy || natW === 0}
                aria-label="Rotate 90° counter-clockwise"
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-full text-[11px] font-medium bg-white border border-slate-200 text-ink/70 hover:text-accent hover:border-accent/40 transition-colors disabled:opacity-50"
              >
                <RotateCcw className="w-3 h-3" /> Left
              </button>
              <button
                type="button"
                onClick={() => rotateBy(90)}
                disabled={busy || natW === 0}
                aria-label="Rotate 90° clockwise"
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-full text-[11px] font-medium bg-white border border-slate-200 text-ink/70 hover:text-accent hover:border-accent/40 transition-colors disabled:opacity-50"
              >
                <RotateCw className="w-3 h-3" /> Right
              </button>
            </div>
          </div>
          <label className="flex items-center gap-2 w-full">
            <span className="text-[11px] text-ink/55 w-10">Zoom</span>
            <input
              type="range"
              min={1}
              max={4}
              step={0.01}
              value={scale}
              onChange={(e) => onScaleChange(parseFloat(e.target.value))}
              className="flex-1 accent-accent"
            />
          </label>
          <div className="text-[10px] text-ink/45 text-center w-full">
            Drag to position · slide to zoom · Left/Right to rotate
          </div>
        </div>
        <footer className="moments-modal-footer">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 rounded-full text-xs font-medium text-ink/70 hover:text-ink hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={apply}
            disabled={busy || natW === 0}
            className={cn(
              "inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 active:scale-95",
              (busy || natW === 0) && "opacity-60 cursor-not-allowed hover:translate-y-0"
            )}
            style={{ background: "linear-gradient(135deg, #2563EB 0%, #1e63ff 100%)" }}
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
            {busy ? "Cropping…" : "Apply crop"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function timeAgo(iso: string): string {
  const now = Date.now();
  const t = new Date(iso).getTime();
  const s = Math.floor((now - t) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const stageCss = `
.moments-stage {
  position: relative;
  width: 100%;
  height: calc(100vh - 140px);
  border-radius: 24px;
  overflow: hidden;
  border: 1px solid rgba(15, 23, 42, 0.08);
  background:
    radial-gradient(1200px 600px at 80% -10%, rgba(30, 99, 255, 0.10), transparent 60%),
    radial-gradient(800px 600px at 10% 110%, rgba(168, 85, 247, 0.06), transparent 60%),
    #ffffff;
  box-shadow: 0 8px 24px -12px rgba(15, 23, 42, 0.10);
  container-type: size;
  container-name: stage;
  color: #0f172a;
  user-select: none;
  --ease-snap: cubic-bezier(0.32, 0, 0.67, 0);
  --ease-glide: cubic-bezier(0.33, 1, 0.68, 1);
  --ease-inout: cubic-bezier(0.65, 0, 0.35, 1);
}

.moments-viewport {
  position: absolute;
  inset: 0;
  transform: scale(var(--zoom));
  transform-origin: center;
  transition: transform 1s var(--ease-inout);
  z-index: 4;
}

.moments-canvas {
  position: absolute;
  display: grid;
  grid-template-columns: repeat(var(--grid-size), 100cqw);
  width: fit-content;
  gap: 2rem;
  transform: translate3d(
    calc((-100cqw * var(--x)) - (2rem * var(--x))),
    calc((-100cqh * var(--y)) - (2rem * var(--y))),
    0
  );
  transition: transform 0.9s var(--ease-inout);
  transform-origin: left top;
  z-index: 5;
}

.moments-cell {
  position: relative;
  width: 100cqw;
  height: 100cqh;
  border-radius: 28px;
  overflow: hidden;
  background-color: #f1f5f9;
  opacity: 0.4;
  transition: opacity 0.6s var(--ease-inout), filter 0.6s var(--ease-inout);
  filter: saturate(0.4) brightness(0.92);
  cursor: pointer;
  padding: 0;
  border: 0;
  color: inherit;
  outline: none;
}

.moments-cell.is-selected {
  opacity: 1;
  filter: none;
  box-shadow:
    0 0 0 2px rgba(30, 99, 255, 0.35),
    0 30px 60px -20px rgba(15, 23, 42, 0.25);
}

.moments-cell.is-empty {
  background:
    repeating-linear-gradient(
      45deg,
      rgba(15, 23, 42, 0.03) 0 12px,
      rgba(15, 23, 42, 0.06) 12px 24px
    );
  filter: none;
  opacity: 0.7;
}

.moments-empty {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: rgba(15, 23, 42, 0.35);
}

.moments-cell img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  /* Show the whole photo with letterbox bars instead of cropping the
     edges off. The cell background paints the bars. */
  object-fit: contain;
  background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
  transform: scale3d(1.4, 1.4, 1);
  transition: transform 1s var(--ease-inout);
  pointer-events: none;
}

.moments-stage.is-open .moments-viewport {
  transform: scale3d(1, 1, 1);
}

.moments-stage.is-open .moments-cell.is-selected img {
  transform: scale3d(1, 1, 1);
}

.moments-meta {
  position: absolute;
  inset: auto 0 0 0;
  padding: 20px 24px 24px;
  background: linear-gradient(to top, rgba(15, 23, 42, 0.92), rgba(15, 23, 42, 0));
  color: white;
  z-index: 2;
  opacity: 0;
  transform: translateY(8px);
  transition: opacity 0.5s var(--ease-inout) 0.2s, transform 0.5s var(--ease-inout) 0.2s;
}

.moments-stage.is-open .moments-cell.is-selected .moments-meta {
  opacity: 1;
  transform: translateY(0);
}

.moments-author {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.moments-avatar {
  width: 28px;
  height: 28px;
  border-radius: 999px;
  object-fit: cover;
  background: linear-gradient(135deg, #93c5fd, #c4b5fd);
  display: grid;
  place-items: center;
  font-weight: 700;
  font-size: 11px;
  color: #1e3a8a;
  ring: 2px white;
  box-shadow: 0 0 0 2px white;
}

.moments-name {
  font-weight: 600;
}

.moments-time {
  font-size: 11px;
  opacity: 0.7;
  margin-left: 4px;
}

.moments-del {
  margin-left: 8px;
  padding: 4px 6px;
  border-radius: 8px;
  background: rgba(255,255,255,0.1);
  color: rgba(255,255,255,0.85);
  cursor: pointer;
  border: 0;
}
.moments-del:hover { background: rgba(244, 63, 94, 0.85); color: white; }

.moments-caption {
  margin-top: 8px;
  font-size: 14px;
  line-height: 1.45;
  max-width: 60ch;
}

/* Mini-map navigator */
.moments-map {
  position: absolute;
  right: 1.25rem;
  bottom: 1.25rem;
  width: 7.5rem;
  height: 7.5rem;
  padding: 0.5rem;
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.7);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border: 1px solid rgba(15, 23, 42, 0.08);
  box-shadow: 0 8px 24px -12px rgba(15, 23, 42, 0.18);
  z-index: 7;
  transition: opacity 0.5s var(--ease-glide);
}
.moments-stage.is-open .moments-map { opacity: 0; pointer-events: none; }

.moments-map-grid {
  display: grid;
  grid-template: repeat(var(--grid-size), 1fr) / repeat(var(--grid-size), 1fr);
  width: 100%;
  height: 100%;
  gap: 4px;
}

.moments-map-cell {
  background: rgba(15, 23, 42, 0.10);
  border-radius: 4px;
  opacity: 0.85;
  border: 0;
  cursor: pointer;
  padding: 0;
  transition: opacity 0.25s var(--ease-inout), background 0.25s var(--ease-inout), transform 0.25s var(--ease-inout);
}
.moments-map-cell:hover {
  opacity: 1;
  background: rgba(15, 23, 42, 0.25);
}
.moments-map-cell.is-selected {
  background: linear-gradient(135deg, #2563EB, #1e63ff);
  opacity: 1;
  transform: scale(1.05);
}

/* Zoom rail */
.moments-zoom {
  position: absolute;
  right: 1.25rem;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  flex-direction: column;
  gap: 6px;
  z-index: 7;
  transition: opacity 0.5s var(--ease-glide);
}
.moments-stage.is-open .moments-zoom { opacity: 0; pointer-events: none; }

.moments-zoom-pill {
  font-size: 10px;
  font-family: ui-monospace, SFMono-Regular, monospace;
  letter-spacing: 0.04em;
  padding: 5px 9px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.85);
  color: rgba(15, 23, 42, 0.6);
  border: 1px solid rgba(15, 23, 42, 0.08);
  cursor: pointer;
  box-shadow: 0 4px 12px -6px rgba(15, 23, 42, 0.15);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
}
.moments-zoom-pill:hover { color: #0f172a; background: white; }
.moments-zoom-pill.is-active {
  background: linear-gradient(135deg, #2563EB, #1e63ff);
  color: white;
  border-color: transparent;
}

/* Crosshair reticle */
.moments-reticle {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  pointer-events: none;
  z-index: 6;
  transition: opacity 0.5s var(--ease-glide);
}
.moments-stage.is-open .moments-reticle { opacity: 0; }
.moments-reticle > span:nth-child(1) {
  position: absolute;
  width: 1px;
  height: 28px;
  background: rgba(30, 99, 255, 0.7);
}
.moments-reticle > span:nth-child(2) {
  position: absolute;
  width: 28px;
  height: 1px;
  background: rgba(30, 99, 255, 0.7);
}
.moments-reticle > span:nth-child(3) {
  position: absolute;
  width: 6px;
  height: 6px;
  background: #1e63ff;
  border-radius: 999px;
  box-shadow: 0 0 12px rgba(30, 99, 255, 0.55);
}

/* Focus button = center hit-target */
.moments-focus {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 56px;
  height: 56px;
  transform: translate(-50%, -50%);
  border: 2px solid rgba(30, 99, 255, 0.55);
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.4);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
  cursor: zoom-in;
  z-index: 7;
  transition: opacity 0.5s var(--ease-glide), transform 0.2s var(--ease-glide), border-color 0.2s var(--ease-glide);
}
.moments-focus:hover {
  border-color: #1e63ff;
  transform: translate(-50%, -50%) scale(1.06);
}
.moments-stage.is-open .moments-focus { opacity: 0; pointer-events: none; }

/* Close pill */
.moments-back {
  position: absolute;
  top: 1.25rem;
  left: 1.25rem;
  padding: 8px 14px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.9);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border: 1px solid rgba(15, 23, 42, 0.08);
  color: #0f172a;
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.02em;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  z-index: 8;
  box-shadow: 0 4px 12px -6px rgba(15, 23, 42, 0.15);
}
.moments-back:hover { background: white; }

/* Upload FAB — sits outside the stage at the page level via portal-ish */
.moments-upload-fab {
  position: absolute;
  top: 1.25rem;
  right: 1.25rem;
  padding: 8px 16px;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 600;
  color: white;
  background: linear-gradient(135deg, #2563EB, #1e63ff);
  box-shadow: 0 12px 28px -10px rgba(30, 99, 255, 0.55);
  border: 0;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  z-index: 9;
  transition: transform 0.2s var(--ease-glide), box-shadow 0.2s var(--ease-glide);
}
.moments-upload-fab:hover { transform: translateY(-2px); box-shadow: 0 16px 32px -10px rgba(30, 99, 255, 0.75); }
.moments-upload-fab:active { transform: translateY(0) scale(0.97); }

/* Upload modal */
.moments-modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.55);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  display: grid;
  place-items: center;
  z-index: 50;
  animation: fadeIn 0.18s ease;
}
.moments-modal {
  width: 480px;
  max-width: calc(100vw - 32px);
  background: white;
  border-radius: 20px;
  overflow: hidden;
  box-shadow: 0 30px 60px -20px rgba(15,23,42,0.45);
  animation: scaleIn 0.22s cubic-bezier(0.2, 0.8, 0.2, 1);
}
.moments-modal-header {
  padding: 12px 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid rgba(15, 23, 42, 0.06);
  background: linear-gradient(120deg, #DBEAFE 0%, #EEF2FF 100%);
}
.moments-modal-body {
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.moments-modal-footer {
  padding: 12px 14px;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  border-top: 1px solid rgba(15, 23, 42, 0.06);
  background: rgba(248, 250, 252, 0.5);
}
.moments-drop {
  width: 100%;
  height: 220px;
  border-radius: 14px;
  border: 2px dashed rgba(15, 23, 42, 0.15);
  background: rgba(248, 250, 252, 0.7);
  display: grid;
  place-items: center;
  color: rgba(15, 23, 42, 0.6);
  cursor: pointer;
  overflow: hidden;
  padding: 0;
  transition: border-color 0.2s, background 0.2s;
}
.moments-drop:hover {
  border-color: rgba(30, 99, 255, 0.4);
  background: rgba(219, 234, 254, 0.4);
}
.moments-drop-preview {
  width: 100%;
  height: 100%;
  /* Match the grid: show the whole image with bars rather than crop. */
  object-fit: contain;
  background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
}
.moments-caption-input {
  width: 100%;
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px solid rgba(15, 23, 42, 0.12);
  background: white;
  font-size: 13px;
  resize: none;
  outline: none;
  transition: border-color 0.2s, box-shadow 0.2s;
}
.moments-caption-input:focus {
  border-color: rgba(30, 99, 255, 0.4);
  box-shadow: 0 0 0 3px rgba(30, 99, 255, 0.12);
}

@keyframes fadeIn {
  from { opacity: 0 }
  to   { opacity: 1 }
}
@keyframes scaleIn {
  from { opacity: 0; transform: scale(0.96) translateY(6px); }
  to   { opacity: 1; transform: scale(1) translateY(0); }
}

@media (max-width: 900px) {
  .moments-zoom, .moments-map { display: none; }
}
`;

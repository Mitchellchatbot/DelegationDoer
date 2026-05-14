"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Sparkles, Film, Tv, Music, Gamepad2, Image as ImageIcon, Youtube, Wand2,
  Search, Loader2, X, Upload, Plus, Bold, Type, Palette, Trash2, Check
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { RecommendationCanvas, type Overlay, type CanvasLayout } from "./RecommendationCanvas";

type Kind = "movie" | "tv" | "album" | "art" | "game" | "video" | "custom";

interface SearchResult {
  id: string;
  title: string;
  subtitle: string;
  imageUrl: string | null;
  backdropUrl?: string | null;
  body?: string | null;
  externalUrl?: string | null;
}

const KINDS: { value: Kind; label: string; icon: typeof Film; api: string | null }[] = [
  { value: "movie",  label: "Movie",  icon: Film,     api: "/api/recommendations/search/tmdb?kind=movie" },
  { value: "tv",     label: "TV",     icon: Tv,       api: "/api/recommendations/search/tmdb?kind=tv" },
  { value: "album",  label: "Album",  icon: Music,    api: null }, // free entry
  { value: "game",   label: "Game",   icon: Gamepad2, api: "/api/recommendations/search/rawg" },
  { value: "video",  label: "Video",  icon: Youtube,  api: "/api/recommendations/search/youtube" },
  { value: "art",    label: "Art",    icon: ImageIcon, api: null },
  { value: "custom", label: "Custom", icon: Wand2,    api: null }
];

const SWATCHES = ["#ffffff", "#0F172A", "#FDE047", "#F472B6", "#60A5FA", "#34D399", "#F97316", "#A855F7"];

// Modal flow: kind picker → search/upload → preview canvas with editor →
// publish. The current EoM is the only person allowed to submit, but
// we render the dialog for everyone (with a friendly note when they
// can't).
export function AddRecommendationDialog({
  trigger, canPost, onCreated
}: {
  trigger: React.ReactNode;
  canPost: boolean;
  onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>("movie");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  const [title, setTitle] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [body, setBody] = useState("");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [externalUrl, setExternalUrl] = useState<string | null>(null);
  const [externalId, setExternalId] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [layout, setLayout] = useState<CanvasLayout>({ overlays: [] });
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fileImageRef = useRef<HTMLInputElement>(null);
  const fileAudioRef = useRef<HTMLInputElement>(null);

  function reset() {
    setKind("movie");
    setQuery("");
    setResults([]);
    setTitle("");
    setSubtitle("");
    setBody("");
    setImageUrl(null);
    setExternalUrl(null);
    setExternalId(null);
    setAudioUrl(null);
    setLayout({ overlays: [] });
    setSelectedOverlayId(null);
  }

  // Debounced search.
  useEffect(() => {
    const k = KINDS.find((x) => x.value === kind);
    if (!k?.api || !query.trim()) {
      setResults([]);
      return;
    }
    setSearching(true);
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`${k.api}&q=${encodeURIComponent(query)}`.replace("?&", "?"), {
          signal: ctrl.signal
        });
        const data = await res.json();
        if (!res.ok) {
          toast.error(data?.error ?? "search failed");
          setResults([]);
          return;
        }
        setResults(data.results ?? []);
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setResults([]);
        }
      } finally {
        setSearching(false);
      }
    }, 200);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [query, kind]);

  function pickResult(r: SearchResult) {
    setTitle(r.title);
    setSubtitle(r.subtitle ?? "");
    setBody(r.body ?? "");
    setImageUrl(r.backdropUrl ?? r.imageUrl);
    setExternalUrl(r.externalUrl ?? null);
    setExternalId(r.id);
  }

  async function uploadFile(file: File, kind: "image" | "audio"): Promise<string | null> {
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("taskId", `recommendations/${kind}`);
      const res = await fetch("/api/upload", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `upload failed (${res.status})`);
      return data.url as string;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "upload failed");
      return null;
    }
  }

  async function onPickImage(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const url = await uploadFile(f, "image");
    if (url) {
      setImageUrl(url);
      setExternalId(null);
      setExternalUrl(null);
    }
    if (fileImageRef.current) fileImageRef.current.value = "";
  }

  async function onPickAudio(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const url = await uploadFile(f, "audio");
    if (url) setAudioUrl(url);
    if (fileAudioRef.current) fileAudioRef.current.value = "";
  }

  function addOverlay() {
    const id = `ov_${Date.now().toString(36)}`;
    const ov: Overlay = {
      id,
      text: "Your text",
      xPct: 50, yPct: 50,
      sizePx: 48, weight: 700,
      color: "#ffffff", shadow: true,
      align: "center"
    };
    setLayout((l) => ({ ...l, overlays: [...(l.overlays ?? []), ov] }));
    setSelectedOverlayId(id);
  }
  function updateOverlay(id: string, patch: Partial<Overlay>) {
    setLayout((l) => ({
      ...l,
      overlays: (l.overlays ?? []).map((o) => o.id === id ? { ...o, ...patch } : o)
    }));
  }
  function deleteOverlay(id: string) {
    setLayout((l) => ({
      ...l,
      overlays: (l.overlays ?? []).filter((o) => o.id !== id)
    }));
    setSelectedOverlayId(null);
  }

  async function submit() {
    if (!title.trim()) {
      toast.error("Add a title");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/recommendations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          title: title.trim(),
          subtitle: subtitle.trim() || null,
          body: body.trim() || null,
          externalId,
          externalUrl,
          imageUrl,
          audioUrl,
          layout
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      toast.success("Recommendation posted ✨");
      reset();
      setOpen(false);
      onCreated();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "couldn't publish");
    } finally {
      setBusy(false);
    }
  }

  const selectedOverlay =
    selectedOverlayId ? (layout.overlays ?? []).find((o) => o.id === selectedOverlayId) : null;
  const usesSearch = !!KINDS.find((k) => k.value === kind)?.api;

  return (
    <Dialog.Root open={open} onOpenChange={(v) => { setOpen(v); if (!v) reset(); }}>
      <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild>
              <motion.div
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-md"
              />
            </Dialog.Overlay>
            <Dialog.Content asChild>
              <motion.div
                initial={{ opacity: 0, y: 24, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 24, scale: 0.96 }}
                transition={{ duration: 0.24, ease: [0.2, 0.8, 0.2, 1] }}
                className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[980px] max-w-[95vw] max-h-[92vh] overflow-hidden rounded-3xl border border-slate-200/80 bg-white shadow-[0_30px_80px_-20px_rgba(15,23,42,0.45)] flex flex-col"
              >
                <header className="px-5 py-3 flex items-center justify-between border-b border-slate-100">
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-fuchsia-500" />
                    <Dialog.Title className="text-sm font-semibold">Post a recommendation</Dialog.Title>
                    {!canPost && (
                      <span className="text-[10px] uppercase tracking-wide font-semibold text-rose-700 bg-rose-50 border border-rose-200/60 px-2 py-0.5 rounded-full">
                        EoM only
                      </span>
                    )}
                  </div>
                  <Dialog.Close asChild>
                    <button className="p-1 rounded-lg text-ink/60 hover:text-ink hover:bg-slate-100 transition-colors">
                      <X className="w-4 h-4" />
                    </button>
                  </Dialog.Close>
                </header>

                <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[420px_1fr] overflow-hidden">
                  {/* LEFT: source + form */}
                  <div className="overflow-y-auto p-4 space-y-4 border-r border-slate-100">
                    {/* Kind picker */}
                    <div className="flex flex-wrap gap-1">
                      {KINDS.map((k) => {
                        const Icon = k.icon;
                        const active = kind === k.value;
                        return (
                          <button
                            key={k.value}
                            type="button"
                            onClick={() => { setKind(k.value); setResults([]); }}
                            className={cn(
                              "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors",
                              active
                                ? "bg-accent text-white border-accent"
                                : "bg-white text-ink/70 border-slate-200 hover:border-accent/40 hover:text-accent"
                            )}
                          >
                            <Icon className="w-3 h-3" />
                            {k.label}
                          </button>
                        );
                      })}
                    </div>

                    {/* Search (if applicable) */}
                    {usesSearch && (
                      <div>
                        <div className="relative">
                          <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-ink/45" />
                          {searching && (
                            <Loader2 className="w-3.5 h-3.5 absolute right-3 top-1/2 -translate-y-1/2 text-ink/45 animate-spin" />
                          )}
                          <input
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder={`Search ${KINDS.find((k) => k.value === kind)?.label.toLowerCase()}…`}
                            className="w-full pl-9 pr-9 py-2 rounded-lg bg-slate-50 border border-slate-200 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-accent/30"
                          />
                        </div>
                        {results.length > 0 && (
                          <div className="mt-2 max-h-64 overflow-y-auto rounded-xl border border-slate-200 bg-slate-50/40 p-1.5 grid grid-cols-1 gap-1">
                            {results.map((r) => (
                              <button
                                key={r.id}
                                type="button"
                                onClick={() => pickResult(r)}
                                className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-white hover:bg-blue-50 border border-slate-200/70 transition-colors text-left"
                              >
                                {r.imageUrl && (
                                  // eslint-disable-next-line @next/next/no-img-element
                                  <img src={r.imageUrl} alt="" className="w-10 h-14 object-cover rounded shrink-0" />
                                )}
                                <div className="min-w-0 flex-1">
                                  <div className="text-[12px] font-semibold truncate">{r.title}</div>
                                  <div className="text-[10px] text-ink/55 truncate">{r.subtitle}</div>
                                </div>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Title / subtitle / body */}
                    <FormSection label="Title">
                      <input
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        placeholder="What are you recommending?"
                        className="w-full px-3 py-2 rounded-lg bg-slate-50 border border-slate-200 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-accent/30"
                      />
                    </FormSection>
                    <FormSection label="Subtitle">
                      <input
                        value={subtitle}
                        onChange={(e) => setSubtitle(e.target.value)}
                        placeholder="Year / artist / channel (optional)"
                        className="w-full px-3 py-2 rounded-lg bg-slate-50 border border-slate-200 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-accent/30"
                      />
                    </FormSection>
                    <FormSection label="Why I love it">
                      <textarea
                        value={body}
                        onChange={(e) => setBody(e.target.value)}
                        rows={3}
                        placeholder="Your pitch (optional, shows on the card)"
                        className="w-full px-3 py-2 rounded-lg bg-slate-50 border border-slate-200 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-accent/30 resize-none"
                      />
                    </FormSection>

                    {/* Image source */}
                    <FormSection label="Background image">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => fileImageRef.current?.click()}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border border-slate-200 bg-white hover:border-accent/40 hover:text-accent transition-colors"
                        >
                          <Upload className="w-3.5 h-3.5" />
                          {imageUrl ? "Replace" : "Upload"}
                        </button>
                        {imageUrl && (
                          <button
                            type="button"
                            onClick={() => setImageUrl(null)}
                            className="text-[11px] text-ink/55 hover:text-rose-600 transition-colors"
                          >
                            Clear
                          </button>
                        )}
                        <input ref={fileImageRef} type="file" accept="image/*" className="hidden" onChange={onPickImage} />
                      </div>
                    </FormSection>

                    {/* Audio */}
                    <FormSection label="Audio (optional)">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => fileAudioRef.current?.click()}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border border-slate-200 bg-white hover:border-accent/40 hover:text-accent transition-colors"
                        >
                          <Music className="w-3.5 h-3.5" />
                          {audioUrl ? "Replace audio" : "Upload audio"}
                        </button>
                        {audioUrl && (
                          <button
                            type="button"
                            onClick={() => setAudioUrl(null)}
                            className="text-[11px] text-ink/55 hover:text-rose-600 transition-colors"
                          >
                            Clear
                          </button>
                        )}
                        <input ref={fileAudioRef} type="file" accept="audio/*" className="hidden" onChange={onPickAudio} />
                      </div>
                    </FormSection>
                  </div>

                  {/* RIGHT: canvas + overlay tools */}
                  <div className="overflow-y-auto p-4 space-y-3 bg-slate-50/40">
                    <RecommendationCanvas
                      imageUrl={imageUrl}
                      audioUrl={audioUrl}
                      layout={layout}
                      editing
                      onLayoutChange={setLayout}
                      onOverlayClick={setSelectedOverlayId}
                      selectedOverlayId={selectedOverlayId}
                    />

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={addOverlay}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-white border border-slate-200 hover:border-accent/40 hover:text-accent transition-colors"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        Add text overlay
                      </button>
                      <span className="text-[11px] text-ink/55">
                        Drag the text on the poster to position it anywhere.
                      </span>
                    </div>

                    {selectedOverlay && (
                      <div className="rounded-xl border border-slate-200 bg-white p-3 space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-[10px] uppercase tracking-wide font-semibold text-ink/55 inline-flex items-center gap-1">
                            <Type className="w-3 h-3" /> Selected overlay
                          </div>
                          <button
                            type="button"
                            onClick={() => deleteOverlay(selectedOverlay.id)}
                            className="text-rose-600 hover:bg-rose-50 p-1 rounded transition-colors"
                            title="Delete this text"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                        <textarea
                          rows={2}
                          value={selectedOverlay.text}
                          onChange={(e) => updateOverlay(selectedOverlay.id, { text: e.target.value })}
                          placeholder="Type here"
                          className="w-full px-2 py-1.5 rounded bg-slate-50 border border-slate-200 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-accent/30 resize-none"
                        />
                        <div className="flex items-center gap-3 flex-wrap">
                          <label className="inline-flex items-center gap-1 text-[10px] text-ink/55">
                            Size
                            <input
                              type="range"
                              min={12} max={120} step={1}
                              value={selectedOverlay.sizePx}
                              onChange={(e) => updateOverlay(selectedOverlay.id, { sizePx: Number(e.target.value) })}
                              className="w-24"
                            />
                            <span className="tabular-nums w-6 text-right">{selectedOverlay.sizePx}</span>
                          </label>
                          <button
                            type="button"
                            onClick={() => updateOverlay(selectedOverlay.id, {
                              weight: selectedOverlay.weight >= 700 ? 400 : 700
                            })}
                            className={cn(
                              "inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium border",
                              selectedOverlay.weight >= 700
                                ? "bg-ink text-white border-ink"
                                : "bg-white border-slate-200"
                            )}
                          >
                            <Bold className="w-3 h-3" />
                            Bold
                          </button>
                          <button
                            type="button"
                            onClick={() => updateOverlay(selectedOverlay.id, { shadow: !selectedOverlay.shadow })}
                            className={cn(
                              "inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium border",
                              selectedOverlay.shadow
                                ? "bg-ink text-white border-ink"
                                : "bg-white border-slate-200"
                            )}
                          >
                            Shadow
                          </button>
                          <div className="inline-flex items-center gap-0.5">
                            {(["left", "center", "right"] as const).map((al) => (
                              <button
                                key={al}
                                type="button"
                                onClick={() => updateOverlay(selectedOverlay.id, { align: al })}
                                className={cn(
                                  "px-1.5 py-0.5 text-[10px] rounded border",
                                  selectedOverlay.align === al
                                    ? "bg-ink text-white border-ink"
                                    : "bg-white border-slate-200"
                                )}
                              >
                                {al}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-[10px] text-ink/55 inline-flex items-center gap-1">
                            <Palette className="w-3 h-3" /> Color
                          </span>
                          {SWATCHES.map((c) => (
                            <button
                              key={c}
                              type="button"
                              onClick={() => updateOverlay(selectedOverlay.id, { color: c })}
                              className={cn(
                                "w-5 h-5 rounded-full border",
                                selectedOverlay.color === c ? "border-ink ring-2 ring-offset-1 ring-ink/30 scale-110" : "border-white"
                              )}
                              style={{ background: c }}
                              title={c}
                            />
                          ))}
                          <input
                            type="color"
                            value={selectedOverlay.color}
                            onChange={(e) => updateOverlay(selectedOverlay.id, { color: e.target.value })}
                            className="w-5 h-5 rounded-full border border-slate-200 cursor-pointer"
                            title="Custom color"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <footer className="px-5 py-3 border-t border-slate-100 flex items-center justify-between gap-2 bg-slate-50/60">
                  <div className="text-[11px] text-ink/55">
                    {canPost
                      ? "Visible to the whole team the moment you publish."
                      : "Only this month's Employee of the Month can publish."}
                  </div>
                  <div className="flex items-center gap-2">
                    <Dialog.Close asChild>
                      <button className="px-3 py-1.5 rounded-full text-xs font-medium text-ink/70 hover:text-ink hover:bg-white">Cancel</button>
                    </Dialog.Close>
                    <button
                      type="button"
                      onClick={submit}
                      disabled={busy || !canPost}
                      className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 disabled:opacity-60 disabled:cursor-not-allowed disabled:translate-y-0"
                      style={{ background: "linear-gradient(135deg, #c026d3 0%, #ec4899 100%)" }}
                    >
                      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                      {busy ? "Publishing…" : "Publish"}
                    </button>
                  </div>
                </footer>
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}

function FormSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide font-semibold text-ink/45 px-1 mb-1">
        {label}
      </div>
      {children}
    </div>
  );
}

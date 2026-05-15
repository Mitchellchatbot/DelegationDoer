"use client";

import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Sparkles, Film, Tv, Music, Gamepad2, Image as ImageIcon, Youtube, Wand2,
  ExternalLink, Plus, Trash2, Loader2
} from "lucide-react";
import { PageHero } from "@/components/PageHero";
import { useCurrentUser } from "@/lib/user-context";
import { PersonAvatar } from "@/components/PersonAvatar";
import { RecommendationCanvas, type CanvasLayout } from "@/components/RecommendationCanvas";
import { AddRecommendationDialog } from "@/components/AddRecommendationDialog";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

type Kind = "movie" | "tv" | "album" | "art" | "game" | "video" | "custom";

interface Recommendation {
  id: string;
  userId: string;
  month: string;
  kind: Kind;
  title: string;
  subtitle: string | null;
  body: string | null;
  externalId: string | null;
  externalUrl: string | null;
  imageUrl: string | null;
  audioUrl: string | null;
  layout: CanvasLayout;
  createdAt: string;
}
interface AuthorRef { id: string; name: string; avatarUrl: string | null }

const KIND_META: Record<Kind, { label: string; icon: typeof Film; tone: string }> = {
  movie:  { label: "Movie",  icon: Film,      tone: "from-rose-500 to-fuchsia-500" },
  tv:     { label: "TV",     icon: Tv,        tone: "from-violet-500 to-indigo-500" },
  album:  { label: "Album",  icon: Music,     tone: "from-emerald-500 to-teal-500" },
  game:   { label: "Game",   icon: Gamepad2,  tone: "from-amber-500 to-orange-500" },
  art:    { label: "Art",    icon: ImageIcon, tone: "from-pink-500 to-rose-500" },
  video:  { label: "Video",  icon: Youtube,   tone: "from-rose-600 to-red-500" },
  custom: { label: "Custom", icon: Wand2,     tone: "from-blue-500 to-indigo-500" }
};

// /updates/recommendations
//
// The current EoM's pick is revealed full-bleed at the top — image
// covers the frame, overlay text sits on top, audio control floats
// bottom-right. Older picks render as a history grid below.
//
// Anyone can view. Only the active EoM (or leader) can publish, and
// that gate is enforced server-side; the "+ Recommend" button hides
// for everyone else.
export default function RecommendationsPage() {
  const me = useCurrentUser();
  const [recs, setRecs] = useState<Recommendation[] | null>(null);
  const [authors, setAuthors] = useState<Record<string, AuthorRef>>({});
  const [eomUserId, setEomUserId] = useState<string | null>(null);
  const [eomMonth, setEomMonth] = useState<string | null>(null);
  const [selected, setSelected] = useState<Recommendation | null>(null);

  async function load() {
    try {
      const [recsRes, eomRes] = await Promise.all([
        fetch("/api/recommendations", { cache: "no-store" }).then((r) => r.json()),
        fetch("/api/eom", { cache: "no-store" }).then((r) => r.json()).catch(() => null)
      ]);
      setRecs(recsRes.recommendations ?? []);
      setAuthors(recsRes.userById ?? {});
      setEomUserId(eomRes?.eom?.userId ?? null);
      setEomMonth(eomRes?.month ?? null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "couldn't load");
    }
  }
  useEffect(() => { load(); }, []);

  const canPost = me.role === "leader" || !!me.isAdmin || (eomUserId !== null && me.id === eomUserId);

  const sorted = useMemo(() => recs ? [...recs].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  ) : null, [recs]);
  const featured = sorted?.[0] ?? null;
  const history = sorted?.slice(1) ?? [];

  async function deleteRec(r: Recommendation) {
    if (!confirm(`Take down "${r.title}"? Anyone can see it until you do.`)) return;
    try {
      const res = await fetch(`/api/recommendations?id=${encodeURIComponent(r.id)}`, {
        method: "DELETE"
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        throw new Error(d?.error ?? `failed (${res.status})`);
      }
      toast.success("Removed");
      await load();
      if (selected?.id === r.id) setSelected(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "couldn't remove");
    }
  }

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <PageHero
        eyebrow="Recommendations"
        headline={[
          { accent: "Crowned" },
          " picks · what to watch, hear, play"
        ]}
        subtitle="The Employee of the Month gets the mic. Movies, albums, games, art — whatever caught their eye this cycle."
        icon={<Sparkles />}
        iconTone="fuchsia"
        trailing={
          canPost ? (
            <AddRecommendationDialog
              canPost={canPost}
              onCreated={load}
              trigger={
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5"
                  style={{ background: "linear-gradient(135deg, #c026d3 0%, #ec4899 100%)" }}
                >
                  <Plus className="w-4 h-4" /> Recommend
                </button>
              }
            />
          ) : null
        }
      />

      {recs === null && (
        <div className="rounded-2xl border border-slate-200/70 bg-white p-8 text-center text-sm text-ink/55 inline-flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading recommendations…
        </div>
      )}

      {recs && recs.length === 0 && (
        <div className="rounded-3xl border border-dashed border-slate-300 bg-white p-12 text-center">
          <Sparkles className="w-8 h-8 text-fuchsia-400 mx-auto mb-2" />
          <div className="text-base font-semibold">Nothing here yet</div>
          <div className="text-sm text-ink/55 mt-1 max-w-md mx-auto">
            {canPost
              ? "You're up — pick something you've loved this month and post it for the team."
              : "Nothing's been recommended yet. The Employee of the Month will drop something here."}
          </div>
        </div>
      )}

      {featured && (
        <FeaturedReveal
          rec={featured}
          author={authors[featured.userId] ?? null}
          canDelete={me.id === featured.userId || me.role === "leader"}
          onDelete={() => deleteRec(featured)}
          onOpen={() => setSelected(featured)}
        />
      )}

      {history.length > 0 && (
        <section>
          <div className="text-[11px] uppercase tracking-wide font-semibold text-ink/55 mb-3">
            Earlier picks · {history.length}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {history.map((r) => (
              <HistoryCard
                key={r.id}
                rec={r}
                author={authors[r.userId] ?? null}
                onOpen={() => setSelected(r)}
              />
            ))}
          </div>
        </section>
      )}

      <AnimatePresence>
        {selected && (
          <FullScreenReveal
            rec={selected}
            author={authors[selected.userId] ?? null}
            canDelete={me.id === selected.userId || me.role === "leader"}
            onClose={() => setSelected(null)}
            onDelete={() => deleteRec(selected)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function FeaturedReveal({
  rec, author, canDelete, onDelete, onOpen
}: {
  rec: Recommendation;
  author: AuthorRef | null;
  canDelete: boolean;
  onDelete: () => void;
  onOpen: () => void;
}) {
  const meta = KIND_META[rec.kind];
  const Icon = meta.icon;
  return (
    <motion.section
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="relative rounded-3xl overflow-hidden shadow-[0_30px_80px_-20px_rgba(15,23,42,0.45)]"
    >
      <div className="relative cursor-zoom-in" onClick={onOpen}>
        <RecommendationCanvas
          imageUrl={rec.imageUrl}
          audioUrl={rec.audioUrl}
          layout={rec.layout ?? {}}
        />
      </div>
      <div className="bg-white p-5 sm:p-6 flex items-start gap-4 flex-wrap">
        <div
          className={cn(
            "w-12 h-12 rounded-2xl grid place-items-center text-white shadow-sm bg-gradient-to-br shrink-0",
            meta.tone
          )}
        >
          <Icon className="w-5 h-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-wide font-semibold text-ink/55">
            {meta.label} · {new Date(rec.createdAt).toLocaleString(undefined, {
              month: "long", day: "numeric", year: "numeric"
            })}
          </div>
          <div className="text-xl sm:text-2xl font-bold mt-1 leading-tight">{rec.title}</div>
          {rec.subtitle && <div className="text-sm text-ink/55 mt-0.5">{rec.subtitle}</div>}
          {rec.body && (
            <p className="text-sm text-ink/75 mt-3 max-w-prose whitespace-pre-wrap">{rec.body}</p>
          )}
          <div className="mt-3 flex items-center gap-3 flex-wrap">
            {author && (
              <div className="inline-flex items-center gap-2 text-[12px] text-ink/65">
                <PersonAvatar
                  userId={author.id}
                  name={author.name}
                  imageUrl={author.avatarUrl}
                  size={22}
                />
                Picked by <span className="font-semibold text-ink">{author.name}</span>
              </div>
            )}
            {rec.externalUrl && (
              <a
                href={rec.externalUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="inline-flex items-center gap-1 text-[12px] text-accent hover:underline"
              >
                Source <ExternalLink className="w-3 h-3" />
              </a>
            )}
            {canDelete && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onDelete(); }}
                className="ml-auto inline-flex items-center gap-1 text-[11px] text-ink/45 hover:text-rose-600 transition-colors"
              >
                <Trash2 className="w-3 h-3" /> Remove
              </button>
            )}
          </div>
        </div>
      </div>
    </motion.section>
  );
}

function HistoryCard({
  rec, author, onOpen
}: {
  rec: Recommendation;
  author: AuthorRef | null;
  onOpen: () => void;
}) {
  const meta = KIND_META[rec.kind];
  const Icon = meta.icon;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="text-left rounded-2xl bg-white border border-slate-200/70 shadow-soft overflow-hidden transition-all hover:-translate-y-0.5 hover:shadow-lift group"
    >
      <div className="relative">
        <RecommendationCanvas
          imageUrl={rec.imageUrl}
          audioUrl={null}
          layout={rec.layout ?? {}}
          small
        />
        <div
          className={cn(
            "absolute top-2 left-2 w-7 h-7 rounded-lg grid place-items-center text-white shadow-sm bg-gradient-to-br",
            meta.tone
          )}
        >
          <Icon className="w-3.5 h-3.5" />
        </div>
      </div>
      <div className="p-3">
        <div className="text-sm font-semibold truncate group-hover:text-accent transition-colors">
          {rec.title}
        </div>
        {rec.subtitle && (
          <div className="text-[11px] text-ink/55 truncate mt-0.5">{rec.subtitle}</div>
        )}
        {author && (
          <div className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-ink/55">
            <PersonAvatar userId={author.id} name={author.name} imageUrl={author.avatarUrl} size={16} noCrown />
            {author.name.split(" ")[0]} · {new Date(rec.createdAt).toLocaleDateString(undefined, {
              month: "short", day: "numeric"
            })}
          </div>
        )}
      </div>
    </button>
  );
}

function FullScreenReveal({
  rec, author, canDelete, onClose, onDelete
}: {
  rec: Recommendation;
  author: AuthorRef | null;
  canDelete: boolean;
  onClose: () => void;
  onDelete: () => void;
}) {
  const meta = KIND_META[rec.kind];
  const Icon = meta.icon;
  // Lock body scroll while open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
      onClick={onClose}
      className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-6 cursor-zoom-out"
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 12 }}
        transition={{ duration: 0.28, ease: [0.2, 0.8, 0.2, 1] }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-5xl max-h-full overflow-y-auto rounded-3xl bg-white shadow-[0_30px_80px_-15px_rgba(0,0,0,0.6)]"
      >
        <RecommendationCanvas
          imageUrl={rec.imageUrl}
          audioUrl={rec.audioUrl}
          layout={rec.layout ?? {}}
        />
        <div className="p-6 flex items-start gap-4 flex-wrap">
          <div className={cn(
            "w-12 h-12 rounded-2xl grid place-items-center text-white shadow-sm bg-gradient-to-br shrink-0",
            meta.tone
          )}>
            <Icon className="w-5 h-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] uppercase tracking-wide font-semibold text-ink/55">
              {meta.label}
            </div>
            <div className="text-2xl font-bold mt-1">{rec.title}</div>
            {rec.subtitle && <div className="text-sm text-ink/55 mt-0.5">{rec.subtitle}</div>}
            {rec.body && (
              <p className="text-base text-ink/75 mt-4 whitespace-pre-wrap leading-relaxed">{rec.body}</p>
            )}
            <div className="mt-4 flex items-center gap-3 flex-wrap">
              {author && (
                <div className="inline-flex items-center gap-2 text-[13px] text-ink/65">
                  <PersonAvatar
                    userId={author.id}
                    name={author.name}
                    imageUrl={author.avatarUrl}
                    size={24}
                  />
                  Recommended by <span className="font-semibold text-ink">{author.name}</span>
                </div>
              )}
              {rec.externalUrl && (
                <a
                  href={rec.externalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-[13px] text-accent hover:underline"
                >
                  Source <ExternalLink className="w-3.5 h-3.5" />
                </a>
              )}
              {canDelete && (
                <button
                  type="button"
                  onClick={onDelete}
                  className="ml-auto inline-flex items-center gap-1 text-[12px] text-ink/55 hover:text-rose-600 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Remove
                </button>
              )}
            </div>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Smile, Send, MessageCircle, Sparkles, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { PersonAvatar } from "./PersonAvatar";
import { useCurrentUser } from "@/lib/user-context";

// Team-recognition surface for an "update" (an EOD submission today;
// designed to drop on project updates / completed tasks later via the
// polymorphic targetType prop).
//
// Three things in one component:
//   1. Reaction chip row — quick emoji (👏 🔥 💯 …) toggled per user.
//   2. Quick-recognition buttons — preset "Great work!" replies that
//      land as kudos-flagged comments (with a ribbon in the thread).
//   3. Thread of replies — open-ended encouragement / feedback.
//
// Data model: posts to /api/updates/reactions + /api/updates/replies.
// The author of the update can NOT recognize themselves (no self-kudos)
// — the buttons hide for `isSelf`. They can still see their own thread.

export interface ReactionSummary {
  emoji: string;
  count: number;
  userIds: string[];
  userNames: string[];
  mine: boolean;
}

export interface ReplyEntry {
  id: string;
  userId: string;
  userName: string;
  avatarUrl: string | null;
  body: string;
  isKudos: boolean;
  kudosEmoji: string | null;
  createdAt: string;
  editedAt: string | null;
  mine: boolean;
}

// Curated reaction palette. Keep this short — too many options dilutes
// the signal. Order is the order shown in the picker.
const REACTION_PALETTE = ["👏", "🔥", "💯", "🚀", "🏆", "🙌", "⭐️", "❤️"];

// Preset positive messages. Clicking one sends a kudos-flagged reply
// with the leading emoji as kudos_emoji, body as the rest.
const QUICK_RECOGNITION: Array<{ emoji: string; text: string }> = [
  { emoji: "👏", text: "Great work!" },
  { emoji: "🔥", text: "You're killing it" },
  { emoji: "💯", text: "Awesome job" },
  { emoji: "🚀", text: "Crushed it" },
  { emoji: "🙌", text: "Well done" },
  { emoji: "🏆", text: "MVP move" }
];

interface UpdateFeedbackProps {
  targetType: string;
  targetId: string;
  // Whether the viewer is the author of the update. Self-kudos hidden
  // when true, but the author can still see and reply in their thread.
  isSelf: boolean;
  // Initial data passed in by the parent's bulk-fetch, so the component
  // can render synchronously without its own GET round-trip.
  initialReactions?: ReactionSummary[];
  initialReplies?: ReplyEntry[];
}

export function UpdateFeedback({
  targetType, targetId, isSelf, initialReactions, initialReplies
}: UpdateFeedbackProps) {
  const me = useCurrentUser();
  const [reactions, setReactions] = useState<ReactionSummary[]>(initialReactions ?? []);
  const [replies, setReplies] = useState<ReplyEntry[]>(initialReplies ?? []);
  const [threadOpen, setThreadOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement | null>(null);

  // Keep state in sync when the parent re-fetches (e.g. after the
  // /updates/eod page reloads after a submit). Object identity changes
  // — fine to use the array refs as the dep.
  useEffect(() => {
    if (initialReactions) setReactions(initialReactions);
  }, [initialReactions]);
  useEffect(() => {
    if (initialReplies) setReplies(initialReplies);
  }, [initialReplies]);

  // Close the emoji picker on outside click.
  useEffect(() => {
    if (!pickerOpen) return;
    function onClick(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    }
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [pickerOpen]);

  async function toggleReaction(emoji: string) {
    // Optimistic: flip in-place. If the server rejects, the catch
    // reverts.
    const prev = reactions;
    setReactions((cur) => {
      const existing = cur.find((r) => r.emoji === emoji);
      if (existing && existing.mine) {
        const nextCount = existing.count - 1;
        if (nextCount <= 0) return cur.filter((r) => r.emoji !== emoji);
        return cur.map((r) =>
          r.emoji === emoji
            ? {
                ...r,
                count: nextCount,
                userIds: r.userIds.filter((id) => id !== me.id),
                userNames: r.userNames.filter((_, i) => r.userIds[i] !== me.id),
                mine: false
              }
            : r
        );
      }
      if (existing) {
        return cur.map((r) =>
          r.emoji === emoji
            ? {
                ...r,
                count: r.count + 1,
                userIds: [...r.userIds, me.id],
                userNames: [...r.userNames, me.name],
                mine: true
              }
            : r
        );
      }
      return [...cur, { emoji, count: 1, userIds: [me.id], userNames: [me.name], mine: true }];
    });

    try {
      const res = await fetch("/api/updates/reactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetType, targetId, emoji })
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        throw new Error(d?.error ?? `status ${res.status}`);
      }
    } catch (err) {
      setReactions(prev);
      toast.error(`Couldn't react: ${err instanceof Error ? err.message : "unknown"}`);
    }
    setPickerOpen(false);
  }

  async function sendReply(body: string, opts?: { isKudos?: boolean; kudosEmoji?: string }) {
    const trimmed = body.trim();
    if (!trimmed) return;
    try {
      const res = await fetch("/api/updates/replies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetType,
          targetId,
          body: trimmed,
          isKudos: !!opts?.isKudos,
          kudosEmoji: opts?.kudosEmoji ?? null
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `status ${res.status}`);
      setReplies((cur) => [...cur, data.reply as ReplyEntry]);
      setThreadOpen(true);
      if (opts?.isKudos) {
        toast.success(`${opts.kudosEmoji ?? "👏"} Recognition sent`);
      }
    } catch (err) {
      toast.error(`Couldn't post: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }

  async function deleteReply(id: string) {
    const prev = replies;
    setReplies((cur) => cur.filter((r) => r.id !== id));
    try {
      const res = await fetch(`/api/updates/replies/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        throw new Error(d?.error ?? `status ${res.status}`);
      }
    } catch (err) {
      setReplies(prev);
      toast.error(`Couldn't remove: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }

  function sendQuickRecognition(preset: { emoji: string; text: string }) {
    void sendReply(preset.text, { isKudos: true, kudosEmoji: preset.emoji });
  }

  const replyCount = replies.length;
  const kudosCount = useMemo(() => replies.filter((r) => r.isKudos).length, [replies]);

  return (
    <div className="mt-3 pt-3 border-t border-slate-100">
      {/* Top row: reactions + reply toggle + quick-recognition (when
          someone else is viewing). */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {reactions.map((r) => (
          <button
            key={r.emoji}
            type="button"
            onClick={() => toggleReaction(r.emoji)}
            title={r.userNames.join(", ")}
            className={
              "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs transition-colors " +
              (r.mine
                ? "bg-accent/10 border border-accent/40 text-ink"
                : "bg-white border border-slate-200 text-ink/75 hover:border-accent/30")
            }
          >
            <span className="leading-none">{r.emoji}</span>
            <span className="font-medium">{r.count}</span>
          </button>
        ))}

        {/* Add-reaction picker */}
        <div className="relative" ref={pickerRef}>
          <button
            type="button"
            onClick={() => setPickerOpen((o) => !o)}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-white border border-dashed border-slate-300 text-ink/55 hover:text-ink hover:border-accent/40 transition-colors"
            title="Add a reaction"
          >
            <Smile className="w-3.5 h-3.5" />
            React
          </button>
          {pickerOpen && (
            <div className="absolute z-30 mt-1 left-0 flex gap-1 bg-white rounded-2xl border border-slate-200 shadow-lift px-2 py-1.5 anim-fade-in">
              {REACTION_PALETTE.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => toggleReaction(e)}
                  className="w-8 h-8 grid place-items-center rounded-lg text-lg hover:bg-slate-100 transition-colors"
                >
                  {e}
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={() => setThreadOpen((o) => !o)}
          className={
            "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs transition-colors " +
            (replyCount > 0
              ? "bg-white border border-slate-200 text-ink/75 hover:border-accent/30"
              : "bg-white border border-dashed border-slate-300 text-ink/55 hover:text-ink hover:border-accent/40")
          }
          title={replyCount > 0 ? `${replyCount} repl${replyCount === 1 ? "y" : "ies"}` : "Reply"}
        >
          <MessageCircle className="w-3.5 h-3.5" />
          {replyCount > 0 ? `${replyCount} repl${replyCount === 1 ? "y" : "ies"}` : "Reply"}
          {kudosCount > 0 && (
            <span className="ml-0.5 text-[10px] inline-flex items-center gap-0.5 px-1 rounded-full bg-amber-100 text-amber-800">
              <Sparkles className="w-2.5 h-2.5" />
              {kudosCount}
            </span>
          )}
        </button>

        {!isSelf && (
          <>
            <div className="h-4 w-px bg-slate-200 mx-1" />
            <div className="flex items-center gap-1 flex-wrap">
              {QUICK_RECOGNITION.slice(0, 3).map((preset) => (
                <button
                  key={preset.text}
                  type="button"
                  onClick={() => sendQuickRecognition(preset)}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] bg-gradient-to-r from-amber-50 to-rose-50 border border-amber-200/70 text-amber-800 hover:from-amber-100 hover:to-rose-100 transition-colors"
                  title={`Send "${preset.text}" as recognition`}
                >
                  <span>{preset.emoji}</span>
                  <span className="font-medium">{preset.text}</span>
                </button>
              ))}
              {/* "More" dropdown for the rest, hidden until clicked to
                  keep the row tidy on dense feeds. */}
              <MoreRecognition presets={QUICK_RECOGNITION.slice(3)} onPick={sendQuickRecognition} />
            </div>
          </>
        )}
      </div>

      {/* Replies thread — collapsible. Opens automatically when a reply
          is posted, or when the user clicks the reply count. */}
      {threadOpen && (
        <div className="mt-3 space-y-2">
          {replies.length === 0 ? (
            <div className="text-[12px] text-ink/45 italic">
              No replies yet — be the first to share encouragement.
            </div>
          ) : (
            <ul className="space-y-2">
              {replies.map((r) => (
                <ReplyRow key={r.id} reply={r} canModerate={me.role === "leader" || me.isAdmin === true} onDelete={() => void deleteReply(r.id)} />
              ))}
            </ul>
          )}
          <ReplyComposer onSend={(body) => void sendReply(body)} />
        </div>
      )}
    </div>
  );
}

function MoreRecognition({
  presets, onPick
}: {
  presets: Array<{ emoji: string; text: string }>;
  onPick: (p: { emoji: string; text: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);
  if (presets.length === 0) return null;
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] bg-white border border-slate-200 text-ink/65 hover:border-accent/30 transition-colors"
        title="More recognition presets"
      >
        +{presets.length}
      </button>
      {open && (
        <div className="absolute z-30 mt-1 left-0 flex flex-col gap-1 bg-white rounded-2xl border border-slate-200 shadow-lift p-1.5 min-w-[180px] anim-fade-in">
          {presets.map((p) => (
            <button
              key={p.text}
              type="button"
              onClick={() => { onPick(p); setOpen(false); }}
              className="flex items-center gap-2 px-2 py-1 rounded-lg text-[12px] text-left hover:bg-amber-50 transition-colors"
            >
              <span>{p.emoji}</span>
              <span>{p.text}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ReplyRow({
  reply, canModerate, onDelete
}: {
  reply: ReplyEntry;
  canModerate: boolean;
  onDelete: () => void;
}) {
  return (
    <li
      className={
        "flex items-start gap-2 rounded-2xl border px-3 py-2 " +
        (reply.isKudos
          ? "bg-gradient-to-r from-amber-50/70 via-rose-50/40 to-white border-amber-200/70"
          : "bg-white border-slate-200/60")
      }
    >
      <PersonAvatar userId={reply.userId} name={reply.userName} imageUrl={reply.avatarUrl ?? undefined} size={28} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[12px] font-semibold text-ink">{reply.userName}</span>
          {reply.isKudos && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0 rounded-full bg-amber-100 text-amber-800 text-[10px] font-medium">
              <Sparkles className="w-2.5 h-2.5" />
              Recognition
            </span>
          )}
          <span className="text-[10px] text-ink/45">{relativeTime(reply.createdAt)}</span>
          {(reply.mine || canModerate) && (
            <button
              type="button"
              onClick={onDelete}
              className="ml-auto text-ink/35 hover:text-rose-500 transition-colors"
              title="Delete this reply"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          )}
        </div>
        <div className="text-[13px] text-ink/85 whitespace-pre-wrap leading-snug mt-0.5">
          {reply.isKudos && reply.kudosEmoji ? (
            <>
              <span className="mr-1">{reply.kudosEmoji}</span>
              {reply.body}
            </>
          ) : (
            reply.body
          )}
        </div>
      </div>
    </li>
  );
}

function ReplyComposer({ onSend }: { onSend: (body: string) => void }) {
  const [draft, setDraft] = useState("");
  const me = useCurrentUser();
  function submit() {
    const t = draft.trim();
    if (!t) return;
    onSend(t);
    setDraft("");
  }
  return (
    <div className="flex items-start gap-2">
      <PersonAvatar userId={me.id} name={me.name} imageUrl={me.avatarUrl ?? undefined} size={28} />
      <div className="flex-1 flex items-start gap-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value.slice(0, 2000))}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
          rows={1}
          placeholder="Write a reply…  (⌘/Ctrl+Enter to send)"
          className="flex-1 text-[12px] rounded-xl border border-slate-200 px-3 py-1.5 outline-none focus:border-accent/50 focus:ring-2 focus:ring-accent/20 resize-y min-h-[34px]"
        />
        <button
          type="button"
          onClick={submit}
          disabled={!draft.trim()}
          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-full text-[11px] font-semibold text-white shadow-sm disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ background: "linear-gradient(135deg, #0a4099 0%, #063270 100%)" }}
        >
          <Send className="w-3 h-3" />
          Send
        </button>
      </div>
    </div>
  );
}

// Compact relative-time formatter — keeps the reply meta tight. Falls
// back to a short date once the post is older than a week.
function relativeTime(iso: string): string {
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return "";
  const diff = Date.now() - d;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}


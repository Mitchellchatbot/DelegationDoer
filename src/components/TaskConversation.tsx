"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PersonAvatar } from "./PersonAvatar";
import { Send, AtSign, X, ImagePlus } from "lucide-react";
import { toast } from "sonner";
import { relativeTime } from "@/lib/utils";

interface StreamEntry {
  id: string;
  kind: "log" | "message";
  action: string;
  userId: string | null;
  detail: string | null;
  imageUrl: string | null;
  mentionedUserIds: string[];
  createdAt: string;
}

interface UserLite {
  id: string;
  name: string;
  avatarUrl?: string | null;
  email?: string | null;
  role?: string;
}

// Single conversation feed for a task. Merges activity_logs (creation,
// status changes, handoffs, comments, mentions) with the legacy
// task_messages rows so older threads aren't orphaned. Polls every 8s
// while mounted; bumps to the bottom on new entries.
//
// Composer supports @-mentions via a popdown that surfaces matching
// teammates. Picking one inserts "@Name " and remembers the user id;
// on send those ids ride alongside the text so the server can fan out
// Slack DMs + widget notifications.
export function TaskConversation({
  taskId, currentUserId, users
}: {
  taskId: string;
  currentUserId: string;
  users: UserLite[];
}) {
  const [entries, setEntries] = useState<StreamEntry[] | null>(null);
  const [draft, setDraft] = useState("");
  const [mentioned, setMentioned] = useState<Record<string, UserLite>>({});
  const [sending, setSending] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const userById = useMemo(() => {
    const m = new Map<string, UserLite>();
    for (const u of users) m.set(u.id, u);
    return m;
  }, [users]);

  async function load() {
    try {
      const res = await fetch(`/api/tasks/${taskId}/stream`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setEntries(data.entries ?? []);
    } catch { /* ignore */ }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries?.length]);

  // Mention dropdown logic — surfaces when the cursor sits in a "@…"
  // token. The query is the partial name typed so far; picking pushes
  // the resolved chip into `mentioned` and replaces the partial with
  // "@FullName ".
  function handleDraftChange(value: string) {
    setDraft(value);
    const upToCursor = value.slice(0, inputRef.current?.selectionStart ?? value.length);
    const m = /@([^\s@]*)$/.exec(upToCursor);
    setMentionQuery(m ? m[1] : null);
  }

  const mentionMatches = useMemo(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.toLowerCase();
    const pool = users
      .filter((u) => u.id !== currentUserId)
      // Drop anyone already chipped so the dropdown isn't a duplicate
      // list — they're already in the draft.
      .filter((u) => !mentioned[u.id]);
    if (!q) return pool.slice(0, 6);
    return pool
      .filter((u) => u.name.toLowerCase().includes(q))
      .slice(0, 6);
  }, [mentionQuery, users, mentioned, currentUserId]);

  function applyMention(user: UserLite) {
    const ta = inputRef.current;
    if (!ta) return;
    const cursor = ta.selectionStart ?? draft.length;
    const before = draft.slice(0, cursor);
    const after = draft.slice(cursor);
    // Replace the trailing "@partial" with "@Name "
    const replaced = before.replace(/@([^\s@]*)$/, `@${user.name} `);
    const next = replaced + after;
    setDraft(next);
    setMentioned((cur) => ({ ...cur, [user.id]: user }));
    setMentionQuery(null);
    // Keep focus + place cursor right after the inserted mention.
    requestAnimationFrame(() => {
      ta.focus();
      const pos = replaced.length;
      ta.setSelectionRange(pos, pos);
    });
  }

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    // Only count mentions whose chip-name still appears in the text —
    // if the user backspaced past it, drop the id so we don't ping
    // someone for a comment that no longer references them.
    const mentionedUserIds = Object.values(mentioned)
      .filter((u) => text.includes(`@${u.name}`))
      .map((u) => u.id);
    try {
      const res = await fetch(`/api/tasks/${taskId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text, mentionedUserIds })
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        throw new Error(d?.error ?? `failed (${res.status})`);
      }
      setDraft("");
      setMentioned({});
      setMentionQuery(null);
      await load();
      if (mentionedUserIds.length > 0) {
        toast.success(`Pinged ${mentionedUserIds.length} teammate${mentionedUserIds.length === 1 ? "" : "s"}`);
      }
    } catch (e) {
      toast.error(`Send failed: ${e instanceof Error ? e.message : "network error"}`);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-3">
      <div
        ref={scrollerRef}
        className="space-y-3 max-h-[420px] overflow-y-auto pr-1"
      >
        {entries === null && (
          <div className="text-xs text-muted">Loading conversation…</div>
        )}
        {entries !== null && entries.length === 0 && (
          <div className="text-xs text-muted italic">
            No activity yet — start the conversation.
          </div>
        )}
        {(entries ?? []).map((e) => (
          <Entry key={e.id} entry={e} userById={userById} currentUserId={currentUserId} />
        ))}
      </div>

      <div className="relative">
        {/* Mention popdown — anchored above the composer when the user
            is mid-token. */}
        {mentionQuery !== null && mentionMatches.length > 0 && (
          <div className="absolute bottom-full left-0 right-0 mb-1 z-20 rounded-xl border border-slate-200 bg-white shadow-lift overflow-hidden">
            {mentionMatches.map((u) => (
              <button
                key={u.id}
                type="button"
                onClick={() => applyMention(u)}
                className="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-violet-50 transition-colors"
              >
                <PersonAvatar userId={u.id} name={u.name} imageUrl={u.avatarUrl} size={22} />
                <span className="text-sm">{u.name}</span>
                {u.role && (
                  <span className="text-[10px] uppercase tracking-wide text-ink/45 ml-auto">{u.role.replace("_", " ")}</span>
                )}
              </button>
            ))}
          </div>
        )}

        <form
          onSubmit={(ev) => { ev.preventDefault(); void send(); }}
          className="rounded-2xl border border-slate-200/70 bg-white shadow-sm focus-within:border-accent/60 focus-within:ring-2 focus-within:ring-accent/15 transition-colors"
        >
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(ev) => handleDraftChange(ev.target.value)}
            onKeyDown={(ev) => {
              if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
                ev.preventDefault();
                void send();
              }
              if (ev.key === "Escape") setMentionQuery(null);
            }}
            placeholder="Comment… use @ to ping a teammate. ⌘↵ to send."
            rows={2}
            className="w-full px-3 py-2.5 text-sm outline-none bg-transparent resize-none placeholder:text-ink/40"
          />
          {Object.keys(mentioned).length > 0 && (
            <div className="px-3 pb-1 flex flex-wrap gap-1">
              {Object.values(mentioned)
                .filter((u) => draft.includes(`@${u.name}`))
                .map((u) => (
                  <span
                    key={u.id}
                    className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-violet-100 text-violet-700 border border-violet-200"
                  >
                    <AtSign className="w-2.5 h-2.5" />
                    {u.name}
                    <button
                      type="button"
                      onClick={() => {
                        setMentioned((cur) => {
                          const next = { ...cur };
                          delete next[u.id];
                          return next;
                        });
                        // Strip the chip from the draft so the message
                        // body matches the chip state.
                        setDraft((d) => d.replace(new RegExp(`@${u.name}\\s?`, "g"), ""));
                      }}
                      className="hover:text-rose-600"
                      title="Remove mention"
                    >
                      <X className="w-2.5 h-2.5" />
                    </button>
                  </span>
                ))}
            </div>
          )}
          <div className="flex items-center justify-between gap-2 px-2 py-1.5 border-t border-slate-100">
            <span className="text-[10px] text-ink/45 pl-1">
              <kbd className="font-mono">@</kbd> to mention · <kbd className="font-mono">⌘↵</kbd> to send
            </span>
            <button
              type="submit"
              disabled={!draft.trim() || sending}
              className="btn-primary disabled:opacity-50"
            >
              <Send className="w-3.5 h-3.5" />
              {sending ? "…" : "Send"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Entry({
  entry, userById, currentUserId
}: {
  entry: StreamEntry;
  userById: Map<string, UserLite>;
  currentUserId: string;
}) {
  const u = entry.userId ? userById.get(entry.userId) ?? null : null;
  const mine = entry.userId === currentUserId;

  // System events (status_change, handoff, created) get a compact
  // single-line treatment so they don't dominate the stream visually.
  // Comments + messages get a chat-bubble treatment.
  const isSystem = entry.action === "status_change" || entry.action === "handoff" || entry.action === "created";

  if (isSystem) {
    return (
      <div className="flex items-center gap-2 text-[11px] text-ink/55 px-1">
        {u && <PersonAvatar userId={u.id} name={u.name} imageUrl={u.avatarUrl} size={16} />}
        <span>
          <span className="font-medium text-ink/75">{u?.name ?? "Someone"}</span>{" "}
          {entry.action === "status_change" ? "moved status" : entry.action === "handoff" ? "handed off" : "created the task"}
          {entry.detail && <>: <span className="text-ink/70">{entry.detail}</span></>}
        </span>
        <span className="ml-auto shrink-0">{relativeTime(entry.createdAt)}</span>
      </div>
    );
  }

  return (
    <div className={`flex items-start gap-2 ${mine ? "flex-row-reverse" : ""}`}>
      {u && <PersonAvatar userId={u.id} name={u.name} imageUrl={u.avatarUrl} size={26} />}
      <div className={`max-w-[80%] flex flex-col ${mine ? "items-end" : ""}`}>
        <div className="text-[10px] text-muted px-1">
          <span className="font-medium text-ink/75">{u?.name ?? "—"}</span>
          <span className="ml-1.5">{relativeTime(entry.createdAt)}</span>
        </div>
        <div
          className={`mt-0.5 inline-block rounded-2xl px-3 py-1.5 text-sm whitespace-pre-wrap text-left ${
            mine
              ? "bg-gradient-to-br from-blue-500 to-indigo-500 text-white"
              : "bg-white/85 border border-slate-200/80 text-ink"
          }`}
        >
          {renderWithMentions(entry.detail ?? "", entry.mentionedUserIds, userById, mine)}
        </div>
        {entry.imageUrl && (
          <a href={entry.imageUrl} target="_blank" rel="noreferrer" className="mt-1.5 block">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={entry.imageUrl}
              alt="attachment"
              className="rounded-xl border border-white/60 max-h-40"
            />
          </a>
        )}
      </div>
    </div>
  );
}

// Highlight any "@Name" substring whose name maps to a known mentioned
// user id. Renders the bubble color-on-bubble for "mine" rows so the
// chip stays legible on the gradient.
function renderWithMentions(
  text: string,
  mentionedIds: string[],
  userById: Map<string, UserLite>,
  mine: boolean
): React.ReactNode {
  if (!mentionedIds || mentionedIds.length === 0 || !text) return text;
  const names = mentionedIds
    .map((id) => userById.get(id)?.name)
    .filter((n): n is string => !!n)
    // Sort by length desc so "@Alice Cooper" matches before "@Alice".
    .sort((a, b) => b.length - a.length);
  if (names.length === 0) return text;
  const pattern = new RegExp(
    `@(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
    "g"
  );
  const parts: React.ReactNode[] = [];
  let last = 0;
  let m;
  let i = 0;
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(
      <span
        key={`m-${i++}`}
        className={
          "inline-flex items-baseline px-1 rounded font-medium " +
          (mine
            ? "bg-white/25 text-white"
            : "bg-violet-100 text-violet-700")
        }
      >
        @{m[1]}
      </span>
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

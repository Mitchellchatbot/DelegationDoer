"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  MessageCircle, AlertTriangle, Send, Loader2, CheckCircle2,
  ArrowRightCircle, LifeBuoy, RefreshCw
} from "lucide-react";
import { cn } from "@/lib/utils";

// Client inbox for /customer-support. Two sub-tabs:
//   - Conversations : open customer_support threads (reply-enabled).
//   - Needs Review  : uncertain classifications, with reclassify (→ Support /
//                     → Lead) actions.
// Vanilla fetch + useState/useEffect (house pattern — no SWR); Sonner toasts.
// Talks only to /api/support/* (never imports a server lib).

type Bucket = "support" | "review";
type Category = "customer_support" | "meta_or_lead" | "uncertain";

interface Conversation {
  id: string;
  blooioChatId: string;
  phone: string;
  contactName: string | null;
  category: Category | null;
  status: "open" | "closed";
  needsReview: boolean;
  linkedLeadId: string | null;
  classifierOutput: { category?: Category; confidence?: string; reason?: string } | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
}

interface Message {
  id: string;
  direction: "inbound" | "outbound";
  body: string;
  sentAt: string;
}

function fmtWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString([], {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
  });
}

function displayName(c: Conversation): string {
  return c.contactName?.trim() || c.phone || "Unknown";
}

export function CustomerSupportInbox() {
  const [tab, setTab] = useState<Bucket>("support");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [reviewCount, setReviewCount] = useState<number>(0);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [thread, setThread] = useState<{ conversation: Conversation; messages: Message[] } | null>(null);
  const [loadingThread, setLoadingThread] = useState(false);

  const [replyText, setReplyText] = useState("");
  const [sending, setSending] = useState(false);
  const [acting, setActing] = useState(false);

  const loadList = useCallback(async (bucket: Bucket) => {
    setLoadingList(true);
    try {
      const res = await fetch(`/api/support/conversations?bucket=${bucket}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();
      const list: Conversation[] = data.conversations ?? [];
      setConversations(list);
    } catch (err) {
      toast.error(`Couldn't load conversations: ${err instanceof Error ? err.message : "unknown"}`);
      setConversations([]);
    } finally {
      setLoadingList(false);
    }
  }, []);

  // Always know the Needs Review count for the tab badge, regardless of which
  // tab is active.
  const refreshReviewCount = useCallback(async () => {
    try {
      const res = await fetch(`/api/support/conversations?bucket=review`, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setReviewCount((data.conversations ?? []).length);
      }
    } catch { /* non-fatal */ }
  }, []);

  useEffect(() => {
    setSelectedId(null);
    setThread(null);
    void loadList(tab);
    // refreshReviewCount is the single writer of the badge count — refresh it on
    // mount and every tab switch so it never disagrees with a dual writer.
    void refreshReviewCount();
  }, [tab, loadList, refreshReviewCount]);

  const loadThread = useCallback(async (id: string) => {
    setLoadingThread(true);
    try {
      const res = await fetch(`/api/support/conversations/${id}/messages`, { cache: "no-store" });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();
      setThread({ conversation: data.conversation, messages: data.messages ?? [] });
    } catch (err) {
      toast.error(`Couldn't load thread: ${err instanceof Error ? err.message : "unknown"}`);
      setThread(null);
    } finally {
      setLoadingThread(false);
    }
  }, []);

  useEffect(() => {
    if (selectedId) void loadThread(selectedId);
  }, [selectedId, loadThread]);

  async function sendReply() {
    if (!selectedId || !replyText.trim()) return;
    setSending(true);
    try {
      const res = await fetch(`/api/support/conversations/${selectedId}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: replyText.trim() })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `status ${res.status}`);
      }
      setReplyText("");
      await loadThread(selectedId);
      toast.success("Sent");
    } catch (err) {
      toast.error(`Send failed: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setSending(false);
    }
  }

  async function reclassify(to: "support" | "lead") {
    if (!selectedId) return;
    setActing(true);
    try {
      const res = await fetch(`/api/support/conversations/${selectedId}/reclassify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `status ${res.status}`);
      }
      toast.success(to === "lead" ? "Routed to the lead funnel" : "Moved to Support");
      // It leaves the current (review) list; refresh both list + counts.
      setSelectedId(null);
      setThread(null);
      await Promise.all([loadList(tab), refreshReviewCount()]);
    } catch (err) {
      toast.error(`Reclassify failed: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setActing(false);
    }
  }

  async function resolve() {
    if (!selectedId) return;
    setActing(true);
    try {
      const res = await fetch(`/api/support/conversations/${selectedId}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `status ${res.status}`);
      }
      toast.success("Conversation closed");
      setSelectedId(null);
      setThread(null);
      await loadList(tab);
    } catch (err) {
      toast.error(`Couldn't close: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setActing(false);
    }
  }

  return (
    <div className="space-y-4">
      <SubTabBar tab={tab} onChange={setTab} reviewCount={reviewCount} />

      <div className="grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-4">
        {/* Conversation list */}
        <div className="rounded-2xl border border-slate-200/70 bg-white shadow-soft overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-100">
            <span className="text-[13px] font-medium text-ink/70">
              {tab === "support" ? "Open conversations" : "Awaiting review"}
            </span>
            <button
              onClick={() => void loadList(tab)}
              className="text-ink/40 hover:text-ink/70 transition-colors"
              title="Refresh"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="max-h-[60vh] overflow-y-auto divide-y divide-slate-100">
            {loadingList ? (
              <div className="p-6 text-center text-ink/40 text-sm">
                <Loader2 className="w-4 h-4 animate-spin mx-auto" />
              </div>
            ) : conversations.length === 0 ? (
              <div className="p-8 text-center text-ink/45 text-sm">
                {tab === "support" ? "No open conversations." : "Nothing to review — all clear."}
              </div>
            ) : (
              conversations.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setSelectedId(c.id)}
                  className={cn(
                    "w-full text-left px-4 py-3 transition-colors hover:bg-slate-50",
                    selectedId === c.id && "bg-teal-50/70"
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[14px] font-medium text-ink truncate">{displayName(c)}</span>
                    <span className="text-[11px] text-ink/40 shrink-0">{fmtWhen(c.lastMessageAt)}</span>
                  </div>
                  <div className="mt-0.5 text-[12.5px] text-ink/55 truncate">
                    {c.lastMessagePreview ?? "—"}
                  </div>
                  {tab === "review" && c.classifierOutput?.reason && (
                    <div className="mt-1 text-[11px] text-amber-700/80 truncate" title={c.classifierOutput.reason}>
                      {c.classifierOutput.reason}
                    </div>
                  )}
                </button>
              ))
            )}
          </div>
        </div>

        {/* Thread pane */}
        <div className="rounded-2xl border border-slate-200/70 bg-white shadow-soft flex flex-col min-h-[60vh]">
          {!selectedId ? (
            <div className="flex-1 grid place-items-center text-ink/40 text-sm">
              <div className="text-center">
                <MessageCircle className="w-7 h-7 mx-auto mb-2 text-ink/25" />
                Select a conversation to view the thread.
              </div>
            </div>
          ) : loadingThread || !thread ? (
            <div className="flex-1 grid place-items-center text-ink/40">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
          ) : (
            <>
              <ThreadHeader
                conversation={thread.conversation}
                acting={acting}
                onReclassify={reclassify}
                onResolve={resolve}
              />
              <div className="flex-1 overflow-y-auto px-4 py-4 space-y-2.5 bg-slate-50/40">
                {thread.messages.length === 0 ? (
                  <div className="text-center text-ink/40 text-sm py-8">No messages yet.</div>
                ) : (
                  thread.messages.map((m) => <Bubble key={m.id} m={m} />)
                )}
              </div>
              <ReplyBox
                value={replyText}
                onChange={setReplyText}
                onSend={sendReply}
                sending={sending}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function SubTabBar({
  tab, onChange, reviewCount
}: { tab: Bucket; onChange: (t: Bucket) => void; reviewCount: number }) {
  const tabs: Array<{ id: Bucket; label: string; icon: typeof LifeBuoy; badge?: number }> = [
    { id: "support", label: "Conversations", icon: LifeBuoy },
    { id: "review", label: "Needs Review", icon: AlertTriangle, badge: reviewCount }
  ];
  return (
    <div className="inline-flex items-center rounded-2xl border border-slate-200/70 bg-white p-1 shadow-soft">
      {tabs.map((t) => {
        const Icon = t.icon;
        const active = t.id === tab;
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            className={cn(
              "inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-[12px] font-medium transition-colors whitespace-nowrap",
              active ? "bg-accent/10 text-accent" : "text-ink/65 hover:text-ink hover:bg-slate-50"
            )}
          >
            <Icon className="w-3.5 h-3.5" />
            {t.label}
            {t.badge != null && t.badge > 0 && (
              <span className="ml-1 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-amber-500 text-white text-[10px] font-bold tabular-nums">
                {t.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

const CATEGORY_LABEL: Record<Category, { label: string; cls: string }> = {
  customer_support: { label: "Customer support", cls: "bg-teal-50 text-teal-700" },
  meta_or_lead: { label: "Lead", cls: "bg-indigo-50 text-indigo-700" },
  uncertain: { label: "Uncertain", cls: "bg-amber-50 text-amber-700" }
};

function ThreadHeader({
  conversation, acting, onReclassify, onResolve
}: {
  conversation: Conversation;
  acting: boolean;
  onReclassify: (to: "support" | "lead") => void;
  onResolve: () => void;
}) {
  const cat = conversation.category ? CATEGORY_LABEL[conversation.category] : null;
  const isReview = conversation.needsReview;
  return (
    <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between gap-3 flex-wrap">
      <div className="min-w-0">
        <div className="text-[15px] font-semibold text-ink truncate">{displayName(conversation)}</div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-[12px] text-ink/50">{conversation.phone}</span>
          {cat && (
            <span className={cn("text-[10.5px] px-1.5 py-0.5 rounded-full font-medium", cat.cls)}>
              {cat.label}
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2">
        {isReview ? (
          <>
            <button
              disabled={acting}
              onClick={() => onReclassify("support")}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[12px] font-medium border border-teal-200 text-teal-700 hover:bg-teal-50 disabled:opacity-50 transition-colors"
            >
              <LifeBuoy className="w-3.5 h-3.5" /> Support
            </button>
            <button
              disabled={acting}
              onClick={() => onReclassify("lead")}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[12px] font-medium border border-indigo-200 text-indigo-700 hover:bg-indigo-50 disabled:opacity-50 transition-colors"
            >
              <ArrowRightCircle className="w-3.5 h-3.5" /> Lead
            </button>
          </>
        ) : (
          conversation.category === "customer_support" && (
            <button
              disabled={acting}
              onClick={onResolve}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[12px] font-medium border border-slate-200 text-ink/65 hover:bg-slate-50 disabled:opacity-50 transition-colors"
            >
              <CheckCircle2 className="w-3.5 h-3.5" /> Close
            </button>
          )
        )}
      </div>
    </div>
  );
}

function Bubble({ m }: { m: Message }) {
  const inbound = m.direction === "inbound";
  return (
    <div className={cn("flex", inbound ? "justify-start" : "justify-end")}>
      <div
        className={cn(
          "max-w-[78%] rounded-2xl px-3.5 py-2 text-[13.5px] leading-snug shadow-sm whitespace-pre-wrap break-words",
          inbound ? "bg-white border border-slate-200 text-ink" : "bg-accent text-white"
        )}
      >
        <div>{m.body || <span className="opacity-60 italic">(empty)</span>}</div>
        <div className={cn("mt-1 text-[10.5px]", inbound ? "text-ink/40" : "text-white/70")}>
          {fmtWhen(m.sentAt)}
        </div>
      </div>
    </div>
  );
}

function ReplyBox({
  value, onChange, onSend, sending
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  sending: boolean;
}) {
  return (
    <div className="p-3 border-t border-slate-100 flex items-end gap-2">
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // ⌘/Ctrl+Enter sends.
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            if (!sending) onSend();
          }
        }}
        placeholder="Type a reply…  (⌘/Ctrl+Enter to send)"
        rows={2}
        className="flex-1 resize-none rounded-xl border border-slate-200 px-3 py-2 text-[13.5px] focus:outline-none focus:ring-2 focus:ring-accent/30"
      />
      <button
        onClick={onSend}
        disabled={sending || !value.trim()}
        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-[13px] font-medium bg-accent text-white hover:bg-accent/90 disabled:opacity-50 transition-colors shrink-0"
      >
        {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
        Send
      </button>
    </div>
  );
}

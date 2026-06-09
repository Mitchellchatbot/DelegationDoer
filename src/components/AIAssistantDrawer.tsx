"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { motion, AnimatePresence } from "framer-motion";
import {
  Sparkles, Send, X, ArrowUp, Loader2, RefreshCw, Mic, MicOff,
  ClipboardPlus, CheckCircle2, Users, ExternalLink
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// Mirrors the ProposedAction discriminated union in src/lib/ai-tools.ts.
// Redeclared here so the drawer (a client component) doesn't pull in
// the server-only ai-tools module — TypeScript would erase the type
// import, but the import resolution is brittle, and the shape changes
// rarely enough that hand-syncing is cheaper than another module.
type SuggestedAssignee = {
  userId: string;
  name: string;
  score: number;
  topReasons: string[];
  capacityPct: number;
};
type ProposedAction =
  | {
      kind: "create_task";
      id: string;
      title: string;
      description: string;
      priority?: "low" | "medium" | "high" | "critical";
      clientName?: string | null;
      sourceLabel?: string | null;
      sourceUrl?: string | null;
      suggestedAssignees: SuggestedAssignee[];
    };

interface Message {
  role: "user" | "assistant";
  content: string;
  actions?: ProposedAction[];
}

const SUGGESTED = [
  "What's on my plate today?",
  "Who has capacity on the website team this week?",
  "What's overdue across the org and who owns each?",
  "Summarise what shipped this week"
];

// Optional client context passed by the per-client entry point on a
// client's detail page. When present the drawer is branded to the
// client and the assistant defaults its answers to that client.
type ClientContext = { id: string; name: string; iconUrl?: string | null };

// Starter chips tailored to the client being viewed, so the user can
// ask about this client without typing its name into every question.
function clientStarters(name: string): string[] {
  return [
    `How is ${name} doing right now?`,
    `Summarise recent emails with ${name}`,
    `What's open for ${name} and who owns it?`,
    `What did we ship for ${name} lately?`
  ];
}

// White-glass right-rail drawer with the same design language as
// the rest of the app: blue/indigo accents, soft shadows, rounded
// cards, markdown-rendered assistant turns (so tables / headers /
// bold / code blocks render properly instead of showing raw `##`
// and `**`).
export function AIAssistantDrawer({
  open, onOpenChange, starter, client
}: {
  open: boolean;
  onOpenChange: (b: boolean) => void;
  // Optional text to pre-fill the composer with when the drawer is
  // opened on a fresh conversation. Used by the /sops "Ask AI" card
  // to seed "How do I…" so the user just keeps typing.
  starter?: string;
  // Optional client context — when set, the drawer is branded to this
  // client and each turn POSTs a clientContext so the assistant scopes
  // its answers + tool calls to this client (see /api/ai/chat).
  client?: ClientContext;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Stick to the bottom as new content streams in.
  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, loading]);

  useEffect(() => {
    if (open) {
      // Pre-fill the input only on a fresh open (no in-flight draft,
      // no existing conversation) — never stomp text the user has
      // already typed or a thread that's already going.
      if (starter && !input && messages.length === 0) {
        setInput(starter);
      }
      setTimeout(() => {
        const ta = inputRef.current;
        if (!ta) return;
        ta.focus();
        // Put the cursor at the end so the user can start typing
        // immediately after the starter phrase.
        const end = ta.value.length;
        ta.setSelectionRange(end, end);
      }, 150);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function send(text?: string) {
    const content = (text ?? input).trim();
    if (!content || loading) return;

    const next: Message[] = [...messages, { role: "user", content }];
    setMessages(next);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: next,
          clientContext: client ? { id: client.id, name: client.name } : undefined
        })
      });
      const data = await res.json();
      if (!res.ok) {
        setMessages((m) => [...m, {
          role: "assistant",
          content: `⚠ Couldn't reach Claude — ${data?.error ?? res.statusText}`
        }]);
      } else {
        const incoming: Message = {
          role: "assistant",
          content: data.reply ?? "(no reply)",
          actions: Array.isArray(data.actions) ? (data.actions as ProposedAction[]) : undefined
        };
        setMessages((m) => [...m, incoming]);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "network error";
      setMessages((m) => [...m, { role: "assistant", content: `⚠ Couldn't reach Claude — ${msg}` }]);
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    setMessages([]);
    setInput("");
    inputRef.current?.focus();
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
                className="fixed inset-0 z-50 bg-slate-950/35 backdrop-blur-sm"
              />
            </Dialog.Overlay>
            <Dialog.Content
              aria-describedby={undefined}
              className="fixed inset-y-3 right-3 z-50 outline-none flex"
            >
              <motion.div
                initial={{ opacity: 0, x: 40 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 40 }}
                transition={{ duration: 0.24, ease: [0.2, 0.8, 0.2, 1] }}
                className="w-[460px] max-w-[95vw] flex flex-col rounded-3xl border border-slate-200/70 bg-white/90 backdrop-blur-xl shadow-[0_30px_80px_-20px_rgba(15,23,42,0.45)] overflow-hidden"
              >
                {/* Header — frosted, gradient strip on top edge */}
                <header
                  className="relative h-14 flex items-center gap-2.5 px-4 border-b border-slate-200/60"
                  style={{
                    background:
                      "linear-gradient(120deg, rgba(219,234,254,0.55) 0%, rgba(238,242,255,0.55) 50%, rgba(252,231,243,0.45) 100%)"
                  }}
                >
                  <div className="w-9 h-9 rounded-xl bg-white/70 border border-white/80 grid place-items-center shadow-sm shrink-0 overflow-hidden">
                    {client?.iconUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={client.iconUrl} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <Sparkles className="w-4 h-4 text-accent" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <Dialog.Title className="text-sm font-semibold leading-tight truncate">
                      {client ? `Ask AI · ${client.name}` : "Ask AI"}
                    </Dialog.Title>
                    <div className="text-[10px] text-ink/55 leading-tight truncate">
                      {client
                        ? `Scoped to ${client.name}`
                        : "Live access to tasks, people, calendar, more"}
                    </div>
                  </div>
                  <div className="ml-auto flex items-center gap-1">
                    {messages.length > 0 && (
                      <button
                        type="button"
                        onClick={reset}
                        className="p-1.5 rounded-lg text-ink/55 hover:text-ink hover:bg-white/70 transition-colors"
                        title="Start a fresh conversation"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <Dialog.Close asChild>
                      <button
                        aria-label="Close"
                        className="p-1.5 rounded-lg text-ink/55 hover:text-ink hover:bg-white/70 transition-colors"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </Dialog.Close>
                  </div>
                </header>

                {/* Conversation */}
                <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
                  {messages.length === 0 && (
                    <EmptyState
                      onPick={send}
                      starters={client ? clientStarters(client.name) : SUGGESTED}
                      client={client}
                    />
                  )}
                  {messages.map((m, i) => (
                    <MessageBubble key={i} message={m} />
                  ))}
                  {loading && <ThinkingBubble />}
                </div>

                {/* Composer */}
                <Composer
                  inputRef={inputRef}
                  value={input}
                  setValue={setInput}
                  loading={loading}
                  onSubmit={() => send()}
                />
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}

function EmptyState({
  onPick, starters, client
}: {
  onPick: (s: string) => void;
  starters: string[];
  client?: ClientContext;
}) {
  return (
    <div className="space-y-4 anim-fade-in">
      <div className="rounded-2xl border border-slate-200/70 bg-gradient-to-br from-blue-50/60 via-white to-fuchsia-50/40 p-4">
        <div className="text-[12px] font-semibold text-ink mb-1 inline-flex items-center gap-1.5">
          <Sparkles className="w-3.5 h-3.5 text-accent" />
          {client ? `Ask me about ${client.name}` : "What can I help you with?"}
        </div>
        <div className="text-[12px] text-ink/65 leading-snug">
          {client
            ? `I'll keep this conversation focused on ${client.name} — its emails, tasks, and history. Pick a starter or ask anything about them.`
            : "I can read live data from your workspace — tasks, people, projects, clients, calendar, kudos, and more. Pick a starter or ask anything."}
        </div>
      </div>
      <div className="space-y-1.5">
        {starters.map((s, idx) => (
          <motion.button
            key={s}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.05 + idx * 0.04 }}
            onClick={() => onPick(s)}
            className="w-full text-left text-[13px] px-3 py-2 rounded-xl border border-slate-200/70 bg-white hover:border-accent/40 hover:bg-blue-50/40 hover:text-accent transition-colors inline-flex items-center gap-2 group"
          >
            <span className="flex-1">{s}</span>
            <ArrowUp className="w-3 h-3 text-ink/35 rotate-45 group-hover:text-accent transition-colors" />
          </motion.button>
        ))}
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className={cn("flex flex-col gap-1", isUser ? "items-end" : "items-start")}
    >
      <div className="text-[10px] text-ink/45 px-2">
        {isUser ? "You" : "Claude"}
      </div>
      <div
        className={cn(
          "max-w-[90%] rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed shadow-sm",
          isUser
            ? "bg-gradient-to-br from-blue-500 to-blue-600 text-white"
            : "bg-white border border-slate-200/70 text-ink"
        )}
      >
        {isUser ? (
          <div className="whitespace-pre-wrap">{message.content}</div>
        ) : (
          <MarkdownBody content={message.content} />
        )}
      </div>
      {!isUser && message.actions && message.actions.length > 0 && (
        <div className="w-full max-w-[90%] space-y-2 mt-1">
          {message.actions.map((a) =>
            a.kind === "create_task" ? <CreateTaskCard key={a.id} action={a} /> : null
          )}
        </div>
      )}
    </motion.div>
  );
}

// Inline "Create task" card the assistant emits when it spots an action
// item. Defaults to the top-ranked assignee but the user can switch
// to any of the suggested alternates with a click before committing.
function CreateTaskCard({
  action
}: {
  action: Extract<ProposedAction, { kind: "create_task" }>;
}) {
  const fallbackAssignee = action.suggestedAssignees[0]?.userId ?? null;
  const [picked, setPicked] = useState<string | null>(fallbackAssignee);
  const [creating, setCreating] = useState(false);
  const [createdTaskId, setCreatedTaskId] = useState<string | null>(null);

  async function commit() {
    if (creating || createdTaskId) return;
    setCreating(true);
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: action.title,
          description: action.description,
          priority: action.priority ?? "medium",
          assigneeId: picked ?? null,
          clientName: action.clientName ?? null,
          missiveThreadUrl: action.sourceUrl ?? null
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      setCreatedTaskId(data?.task?.id ?? "ok");
      toast.success("Task created.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "couldn't create task");
    } finally {
      setCreating(false);
    }
  }

  const pickedAssignee = action.suggestedAssignees.find((a) => a.userId === picked);

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className={cn(
        "rounded-2xl border bg-gradient-to-br shadow-sm overflow-hidden",
        createdTaskId
          ? "border-emerald-200/70 from-emerald-50/70 to-white"
          : "border-blue-200/60 from-blue-50/60 via-white to-indigo-50/40"
      )}
    >
      <div className="px-3.5 py-2.5 space-y-2">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide font-semibold">
          {createdTaskId ? (
            <span className="text-emerald-700 inline-flex items-center gap-1">
              <CheckCircle2 className="w-3 h-3" /> Task created
            </span>
          ) : (
            <span className="text-blue-700 inline-flex items-center gap-1">
              <ClipboardPlus className="w-3 h-3" /> Suggested task
            </span>
          )}
          {action.priority && (
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-white/80 border border-slate-200/70 text-ink/65 capitalize">
              {action.priority}
            </span>
          )}
          {action.clientName && (
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-white/80 border border-indigo-200/70 text-indigo-700">
              {action.clientName}
            </span>
          )}
        </div>

        <div className="text-[13px] font-semibold text-ink leading-tight">
          {action.title}
        </div>
        <div className="text-[11.5px] text-ink/70 leading-snug whitespace-pre-wrap line-clamp-3">
          {action.description}
        </div>

        {action.sourceLabel && (
          <div className="text-[10px] text-ink/55 inline-flex items-center gap-1">
            {action.sourceUrl ? (
              <a
                href={action.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 hover:text-accent hover:underline"
              >
                <ExternalLink className="w-3 h-3" /> {action.sourceLabel}
              </a>
            ) : (
              <span>{action.sourceLabel}</span>
            )}
          </div>
        )}

        {action.suggestedAssignees.length > 0 && !createdTaskId && (
          <div className="space-y-1.5">
            <div className="text-[10px] uppercase tracking-wide font-semibold text-ink/55 inline-flex items-center gap-1">
              <Users className="w-3 h-3" /> Suggested assignee
            </div>
            <div className="flex flex-wrap gap-1.5">
              {action.suggestedAssignees.map((a) => (
                <button
                  key={a.userId}
                  type="button"
                  onClick={() => setPicked(a.userId)}
                  className={cn(
                    "inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-[11px] border transition-colors",
                    picked === a.userId
                      ? "bg-blue-600 text-white border-blue-600 shadow-sm"
                      : "bg-white text-ink/80 border-slate-200/70 hover:border-blue-300 hover:text-blue-700"
                  )}
                  title={a.topReasons.length ? a.topReasons.join(" · ") : undefined}
                >
                  <span className="font-medium">{a.name}</span>
                  <span className={cn("text-[9px] tabular-nums", picked === a.userId ? "opacity-80" : "opacity-60")}>
                    {a.score}
                  </span>
                </button>
              ))}
            </div>
            {pickedAssignee && pickedAssignee.topReasons.length > 0 && (
              <div className="text-[10px] text-ink/55 leading-snug">
                Why: {pickedAssignee.topReasons.join(" · ")} · {pickedAssignee.capacityPct}% capacity
              </div>
            )}
          </div>
        )}
      </div>

      {!createdTaskId && (
        <div className="px-3.5 py-2 bg-white/60 border-t border-slate-200/60 flex items-center justify-end">
          <button
            type="button"
            onClick={commit}
            disabled={creating}
            className={cn(
              "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11.5px] font-semibold text-white shadow-sm transition-all",
              creating ? "opacity-60 cursor-not-allowed" : "hover:-translate-y-0.5 active:scale-95"
            )}
            style={{ background: "linear-gradient(135deg, #0a4099 0%, #063270 100%)" }}
          >
            {creating ? <Loader2 className="w-3 h-3 animate-spin" /> : <ClipboardPlus className="w-3 h-3" />}
            Create task
          </button>
        </div>
      )}
    </motion.div>
  );
}

function ThinkingBubble() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-col gap-1 items-start"
    >
      <div className="text-[10px] text-ink/45 px-2">Claude</div>
      <div className="rounded-2xl px-3.5 py-2.5 bg-white border border-slate-200/70 shadow-sm inline-flex items-center gap-2">
        <Loader2 className="w-3.5 h-3.5 animate-spin text-accent" />
        <span className="text-[12px] text-ink/55">Thinking…</span>
      </div>
    </motion.div>
  );
}

function Composer({
  inputRef, value, setValue, loading, onSubmit
}: {
  inputRef: React.RefObject<HTMLTextAreaElement>;
  value: string;
  setValue: (v: string) => void;
  loading: boolean;
  onSubmit: () => void;
}) {
  // Autosize the textarea — up to ~5 rows.
  useEffect(() => {
    const ta = inputRef.current;
    if (!ta) return;
    ta.style.height = "0px";
    ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
  }, [value, inputRef]);

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !loading) {
      e.preventDefault();
      onSubmit();
    }
  }

  const { supported, listening, transcribing, toggle } = useDictation({
    onTranscript: (next) => setValue(next),
    baselineValue: value
  });

  const canSend = value.trim().length > 0 && !loading && !transcribing;
  return (
    <div className="p-3 border-t border-slate-200/60 bg-white/60">
      <div className="flex items-end gap-2 rounded-2xl border border-slate-200/70 bg-white pl-3 pr-1.5 py-1.5 shadow-sm focus-within:border-accent/50 focus-within:ring-2 focus-within:ring-accent/20 transition-all">
        <textarea
          ref={inputRef}
          rows={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={loading}
          placeholder={
            loading
              ? "Claude is thinking…"
              : transcribing
                ? "Transcribing…"
                : listening
                  ? "Recording… click the mic again to stop"
                  : "Ask anything…"
          }
          className="flex-1 min-w-0 resize-none bg-transparent text-[13px] leading-snug outline-none placeholder:text-ink/40 py-1.5"
        />
        <button
          type="button"
          onClick={toggle}
          disabled={loading || transcribing}
          aria-label={listening ? "Stop dictation" : "Start dictation"}
          title={
            supported
              ? listening ? "Stop and transcribe" : "Dictate with your mic"
              : "Voice input isn't supported in this browser"
          }
          className={cn(
            "w-8 h-8 rounded-full grid place-items-center shrink-0 transition-all border",
            listening
              ? "bg-red-50 text-red-600 border-red-200 shadow-[0_0_0_3px_rgba(239,68,68,0.18)] animate-pulse"
              : "bg-white text-ink/60 border-slate-200 hover:text-accent hover:border-accent/40",
            (loading || transcribing) && "opacity-40 cursor-not-allowed",
            !supported && !listening && "opacity-70"
          )}
        >
          {transcribing
            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
            : listening
              ? <MicOff className="w-3.5 h-3.5" />
              : <Mic className="w-3.5 h-3.5" />}
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={!canSend}
          aria-label="Send"
          className={cn(
            "w-8 h-8 rounded-full grid place-items-center shrink-0 transition-all shadow-sm",
            canSend
              ? "text-white hover:-translate-y-0.5 active:scale-95"
              : "bg-slate-100 text-ink/35 cursor-not-allowed"
          )}
          style={canSend ? { background: "linear-gradient(135deg, #0a4099 0%, #063270 100%)" } : {}}
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
        </button>
      </div>
      <div className="text-[10px] text-ink/40 px-2 pt-1.5">
        Enter to send · Shift+Enter for a new line
        {supported && (
          <span className="text-ink/45">
            {" · "}
            {transcribing
              ? "transcribing…"
              : listening
                ? "🎙 recording — click mic to stop"
                : "Mic to dictate"}
          </span>
        )}
      </div>
    </div>
  );
}

// Click-to-start / click-to-stop dictation backed by OpenAI
// gpt-4o-mini-transcribe. We record the mic with MediaRecorder, then
// POST the audio blob to /api/transcribe on stop and splice the
// returned text onto whatever the user had already typed.
//
// The OpenAI endpoint is request/response (not streaming), so there's
// a 1–2s "transcribing…" window between the user clicking stop and
// the text appearing. The Composer surfaces that state on the mic
// button so it's visible.
function useDictation({
  onTranscript, baselineValue
}: {
  onTranscript: (next: string) => void;
  baselineValue: string;
}) {
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [supported, setSupported] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const baselineRef = useRef<string>("");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const ok =
      !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";
    setSupported(ok);
    return () => {
      try { recorderRef.current?.stop(); } catch { /* */ }
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  async function start() {
    baselineRef.current = baselineValue;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      // Permission denied, extension intercept, no mic device, etc.
      // Surface the reason so users know why nothing happened. The
      // common cases: NotAllowedError (denied by user or by system
      // permission), NotFoundError (no mic), NotReadableError (mic
      // in use by another app or browser extension).
      const name = err instanceof Error ? err.name : "";
      const msg =
        name === "NotAllowedError"
          ? "Microphone permission was denied. Allow it in the browser address bar (lock icon) and try again."
          : name === "NotFoundError"
            ? "No microphone detected on this device."
            : name === "NotReadableError"
              ? "Mic is busy — another app or browser extension (Scribe / Loom / etc.) might be using it. Close those and retry."
              : `Couldn't access mic: ${err instanceof Error ? err.message : "unknown"}`;
      // eslint-disable-next-line no-console
      console.warn("[mic] getUserMedia failed:", err);
      toast.error(msg);
      return;
    }
    streamRef.current = stream;
    // Chrome/Firefox produce webm/opus, Safari produces mp4/aac. Both
    // are accepted by the OpenAI transcription endpoint.
    const preferred = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : MediaRecorder.isTypeSupported("audio/mp4")
          ? "audio/mp4"
          : "";
    const rec = preferred
      ? new MediaRecorder(stream, { mimeType: preferred })
      : new MediaRecorder(stream);
    chunksRef.current = [];
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      const type = rec.mimeType || "audio/webm";
      const blob = new Blob(chunksRef.current, { type });
      chunksRef.current = [];
      void transcribe(blob, type);
    };
    recorderRef.current = rec;
    rec.start();
    setListening(true);
  }

  async function transcribe(blob: Blob, mime: string) {
    if (blob.size === 0) {
      toast.error("Mic captured no audio — try again and speak after the red pulse appears.");
      return;
    }
    setTranscribing(true);
    try {
      const ext = mime.includes("mp4") || mime.includes("m4a") ? "m4a"
        : mime.includes("ogg") ? "ogg"
        : mime.includes("wav") ? "wav"
        : "webm";
      const fd = new FormData();
      fd.append("file", blob, `dictation.${ext}`);
      const res = await fetch("/api/transcribe", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Server-side failure — most often OPENAI_API_KEY missing/wrong
        // or rate-limit. The route returns { error } in either case.
        const detail = typeof data?.error === "string" ? data.error : `HTTP ${res.status}`;
        // eslint-disable-next-line no-console
        console.warn("[mic] /api/transcribe failed:", detail);
        toast.error(`Transcription failed: ${detail}`);
        return;
      }
      const text = typeof data.text === "string" ? data.text.trim() : "";
      if (!text) {
        toast.error("Transcription came back empty — try a longer recording or speak more clearly.");
        return;
      }
      const base = baselineRef.current;
      const joined = base
        ? base + (base.endsWith(" ") || base.endsWith("\n") ? "" : " ") + text
        : text;
      onTranscript(joined);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[mic] /api/transcribe threw:", err);
      toast.error(`Transcription network error: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setTranscribing(false);
    }
  }

  function stop() {
    const rec = recorderRef.current;
    if (!rec) return;
    try { rec.stop(); } catch { /* */ }
    recorderRef.current = null;
    setListening(false);
  }

  function toggle() {
    if (transcribing) return;
    if (listening) stop();
    else void start();
  }

  return { supported, listening, transcribing, toggle };
}

// Markdown renderer styled to match the app's design language.
// All elements get tight spacing + the brand color palette so the
// assistant output reads like part of the UI, not a default
// react-markdown dump.
function MarkdownBody({ content }: { content: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          h1: ({ node, ...props }) => (
            <h3 {...props} className="text-[15px] font-bold text-ink mt-3 mb-1.5 first:mt-0" />
          ),
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          h2: ({ node, ...props }) => (
            <h4 {...props} className="text-[14px] font-bold text-ink mt-3 mb-1.5 first:mt-0" />
          ),
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          h3: ({ node, ...props }) => (
            <h5 {...props} className="text-[13px] font-bold text-ink mt-2.5 mb-1 first:mt-0 inline-flex items-center gap-1" />
          ),
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          p: ({ node, ...props }) => (
            <p {...props} className="my-1.5 first:mt-0 last:mb-0" />
          ),
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          ul: ({ node, ...props }) => (
            <ul {...props} className="my-1.5 ml-4 list-disc space-y-0.5" />
          ),
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          ol: ({ node, ...props }) => (
            <ol {...props} className="my-1.5 ml-4 list-decimal space-y-0.5" />
          ),
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          li: ({ node, ...props }) => (
            <li {...props} className="leading-snug" />
          ),
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          strong: ({ node, ...props }) => (
            <strong {...props} className="font-semibold text-ink" />
          ),
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          em: ({ node, ...props }) => (
            <em {...props} className="italic text-ink/85" />
          ),
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          a: ({ node, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer"
              className="text-accent underline-offset-2 hover:underline font-medium" />
          ),
          // SOP answers embed screenshots/diagrams via ![alt](url) so
          // users see the actual picture, not just a description. Cap
          // the rendered width to the drawer's content area, lazy-load,
          // and dim the border so the image reads as a citation, not
          // a hero.
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          img: ({ node, alt, src, ...props }) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              {...props}
              src={src}
              alt={alt ?? ""}
              loading="lazy"
              className="block my-2 max-w-full h-auto rounded-lg border border-slate-200/70 shadow-sm"
            />
          ),
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          code: ({ node, inline, ...props }: any) => inline ? (
            <code {...props} className="px-1 py-0.5 rounded bg-slate-100 text-[11.5px] font-mono text-ink/85" />
          ) : (
            <code {...props} className="block px-3 py-2 rounded-lg bg-slate-50 border border-slate-200/70 text-[11.5px] font-mono overflow-x-auto whitespace-pre" />
          ),
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          pre: ({ node, ...props }) => (
            <pre {...props} className="my-2" />
          ),
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          blockquote: ({ node, ...props }) => (
            <blockquote {...props} className="border-l-2 border-accent/40 pl-3 my-2 text-ink/70 italic" />
          ),
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          hr: () => <hr className="my-3 border-slate-200" />,
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          table: ({ node, ...props }) => (
            <div className="my-2 overflow-x-auto rounded-lg border border-slate-200/70">
              <table {...props} className="w-full text-[12px] border-collapse" />
            </div>
          ),
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          thead: ({ node, ...props }) => (
            <thead {...props} className="bg-slate-50 text-ink/65 font-semibold" />
          ),
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          th: ({ node, ...props }) => (
            <th {...props} className="text-left px-2.5 py-1.5 border-b border-slate-200/70 font-semibold" />
          ),
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          td: ({ node, ...props }) => (
            <td {...props} className="px-2.5 py-1.5 border-b border-slate-100 last:border-0 align-top" />
          ),
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          tr: ({ node, ...props }) => (
            <tr {...props} className="hover:bg-slate-50/40" />
          )
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles, Send, Loader2, RefreshCw, Mail, CheckCircle2, ArrowUp, Mic, MicOff } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Inline "talk to your brain" box for the Scale Room. Same backend as the
// Ask AI drawer (/api/ai/chat — owner tools: finances, outbound, Meta,
// memory, email drafting), but rendered inline at the top of the page so
// Mitchell can ask "what do I do today?" without opening a modal. The Scale
// page is already owner-gated, so this is his alone.

type ProposedEmail = { kind: "send_email"; id: string; to: string; subject: string; body: string; purpose?: string | null };
type ProposedAction = { kind: string; id: string } & Record<string, unknown>;
interface Message { role: "user" | "assistant"; content: string; actions?: ProposedAction[] }

const STARTERS = [
  "What should I do today to grow?",
  "Which clients are most at risk right now?",
  "Where's my next new client coming from?",
  "Draft me a LinkedIn post about a recent client win",
  "Who should I follow up with this week?"
];

export function ScaleChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, loading]);

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
        body: JSON.stringify({ messages: next })
      });
      const data = await res.json();
      if (!res.ok) {
        setMessages((m) => [...m, { role: "assistant", content: `⚠ Couldn't reach the brain — ${data?.error ?? res.statusText}` }]);
      } else {
        setMessages((m) => [...m, {
          role: "assistant",
          content: data.reply ?? "(no reply)",
          actions: Array.isArray(data.actions) ? (data.actions as ProposedAction[]) : undefined
        }]);
      }
    } catch (err) {
      setMessages((m) => [...m, { role: "assistant", content: `⚠ Couldn't reach the brain — ${err instanceof Error ? err.message : "network error"}` }]);
    } finally {
      setLoading(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !loading) {
      e.preventDefault();
      void send();
    }
  }

  // Voice: hold-to-talk to the brain. Records the mic, transcribes via
  // /api/transcribe, and drops the text into the input to send or edit.
  const { supported, listening, transcribing, toggle } = useDictation((text) =>
    setInput((v) => (v ? v + (v.endsWith(" ") ? "" : " ") + text : text))
  );

  const hasThread = messages.length > 0;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-4 border-b border-slate-100">
        <div className="w-9 h-9 rounded-xl bg-slate-900 text-white grid place-items-center shrink-0">
          <Sparkles className="w-4 h-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold text-slate-900 leading-tight">Ask your brain</div>
          <div className="text-[12px] text-slate-500 leading-tight">What should you do next? It reads your clients, pipeline, ads, and memory.</div>
        </div>
        {hasThread && (
          <button type="button" onClick={() => { setMessages([]); setInput(""); inputRef.current?.focus(); }}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-900 hover:bg-slate-100 transition-colors shrink-0" title="Start over">
            <RefreshCw className="w-4 h-4" />
          </button>
        )}
      </div>

      {hasThread && (
        <div ref={scrollRef} className="max-h-[420px] overflow-y-auto p-4 space-y-3">
          {messages.map((m, i) => <Bubble key={i} message={m} />)}
          {loading && (
            <div className="flex items-center gap-2 text-[12px] text-muted">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-500" /> Thinking…
            </div>
          )}
        </div>
      )}

      {!hasThread && (
        <div className="p-4 grid sm:grid-cols-2 gap-2">
          {STARTERS.map((s) => (
            <button key={s} type="button" onClick={() => send(s)}
              className="w-full text-left text-[13px] px-3 py-2.5 rounded-xl border border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50 transition-colors inline-flex items-center gap-2 group">
              <span className="flex-1 text-slate-700">{s}</span>
              <ArrowUp className="w-3 h-3 text-slate-300 rotate-45 group-hover:text-slate-500 transition-colors" />
            </button>
          ))}
        </div>
      )}

      <div className="p-4 border-t border-slate-100 bg-slate-50/50">
        <div className="flex items-end gap-2 rounded-2xl border border-slate-200 bg-white pl-4 pr-2 py-2 shadow-sm focus-within:border-slate-400 focus-within:ring-2 focus-within:ring-slate-100 transition-all">
          <textarea
            ref={inputRef}
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={loading}
            placeholder={loading ? "Thinking…" : transcribing ? "Transcribing…" : listening ? "Listening… tap the mic to stop" : "Ask your brain anything…"}
            className="flex-1 min-w-0 resize-none bg-transparent text-[14px] leading-snug outline-none placeholder:text-slate-400 py-1.5 max-h-32"
          />
          {supported && (
            <button type="button" onClick={toggle} disabled={loading || transcribing} aria-label={listening ? "Stop" : "Speak to your brain"}
              title={listening ? "Stop and transcribe" : "Speak to your brain"}
              className={"w-9 h-9 rounded-full grid place-items-center shrink-0 transition-all border " + (listening ? "bg-rose-50 text-rose-600 border-rose-200 animate-pulse" : "bg-white text-slate-500 border-slate-200 hover:text-slate-900 hover:border-slate-300") + ((loading || transcribing) ? " opacity-40 cursor-not-allowed" : "")}>
              {transcribing ? <Loader2 className="w-4 h-4 animate-spin" /> : listening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
            </button>
          )}
          <button type="button" onClick={() => send()} disabled={!input.trim() || loading} aria-label="Send"
            className={"w-9 h-9 rounded-full grid place-items-center shrink-0 transition-all " + (input.trim() && !loading ? "bg-slate-900 text-white hover:bg-slate-800 active:scale-95" : "bg-slate-100 text-slate-400 cursor-not-allowed")}>
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </div>
        {supported && <div className="text-[10px] text-slate-400 px-1 pt-1.5">Tap the mic to talk to your brain, or type. Enter to send.</div>}
      </div>
    </div>
  );
}

function Bubble({ message }: { message: Message }) {
  const isUser = message.role === "user";
  const emails = (message.actions ?? []).filter((a): a is ProposedEmail => a.kind === "send_email");
  return (
    <div className={"flex flex-col gap-1 " + (isUser ? "items-end" : "items-start")}>
      <div className="text-[10px] text-slate-400 px-1">{isUser ? "You" : "Brain"}</div>
      <div className={"max-w-[92%] rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed " + (isUser ? "bg-slate-900 text-white" : "bg-slate-50 border border-slate-200 text-slate-800")}>
        {isUser ? <div className="whitespace-pre-wrap">{message.content}</div> : <Markdown content={message.content} />}
      </div>
      {emails.length > 0 && (
        <div className="w-full max-w-[92%] space-y-2 mt-1">
          {emails.map((e) => <SendEmailCard key={e.id} action={e} />)}
        </div>
      )}
    </div>
  );
}

// Compact inline draft-email card. Same contract as the drawer: nothing sends
// until Mitchell clicks Send; it posts to /api/brain/compose (sends as him).
function SendEmailCard({ action }: { action: ProposedEmail }) {
  const [to, setTo] = useState(action.to);
  const [subject, setSubject] = useState(action.subject);
  const [body, setBody] = useState(action.body);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    if (sending || sent) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/brain/compose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to, subject, bodyText: body })
      });
      const j = await res.json();
      if (j.ok) setSent(true);
      else setError(j.error || "send failed");
    } catch {
      setError("send failed");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="rounded-xl border border-indigo-200 bg-indigo-50/50 p-3 text-[13px]">
      <div className="flex items-center gap-1.5 text-[12px] font-semibold text-indigo-700 mb-2">
        <Mail className="w-3.5 h-3.5" /> Draft email{action.purpose ? ` · ${action.purpose}` : ""}
      </div>
      {sent ? (
        <div className="flex items-center gap-1.5 text-[13px] text-emerald-700"><CheckCircle2 className="w-4 h-4" /> Sent to {to}.</div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-muted w-12 shrink-0">To</span>
            <input value={to} onChange={(e) => setTo(e.target.value)} className="flex-1 text-[12px] rounded-lg border border-slate-200 px-2 py-1 bg-white focus:outline-none focus:border-indigo-300" />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-muted w-12 shrink-0">Subject</span>
            <input value={subject} onChange={(e) => setSubject(e.target.value)} className="flex-1 text-[12px] rounded-lg border border-slate-200 px-2 py-1 bg-white focus:outline-none focus:border-indigo-300" />
          </div>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={Math.min(16, Math.max(6, body.split("\n").length + 1))}
            className="w-full text-[13px] leading-relaxed rounded-lg border border-slate-200 p-2.5 bg-white focus:outline-none focus:border-indigo-300 resize-y" />
          <div className="flex items-center gap-2">
            <button type="button" onClick={send} disabled={sending}
              className="flex items-center gap-1.5 text-[12px] font-medium text-white bg-ink rounded-lg px-3 py-1.5 hover:opacity-90 disabled:opacity-50">
              {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
              {sending ? "Sending…" : "Send as me"}
            </button>
            {error && <span className="text-[12px] text-rose-600">{error}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

// Click-to-talk dictation: record the mic, POST the audio to /api/transcribe on
// stop, and hand the text back. Same endpoint the Ask AI drawer uses.
function useDictation(onText: (t: string) => void) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setSupported(!!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined");
    return () => { try { recRef.current?.stop(); } catch { /* */ } };
  }, []);

  async function start() {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return; // permission denied / no mic — stay silent, user can type
    }
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus"
      : MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm"
      : MediaRecorder.isTypeSupported("audio/mp4") ? "audio/mp4" : "";
    const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    chunksRef.current = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunksRef.current.push(e.data); };
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      const type = rec.mimeType || "audio/webm";
      const blob = new Blob(chunksRef.current, { type });
      chunksRef.current = [];
      if (blob.size === 0) return;
      setTranscribing(true);
      try {
        const ext = type.includes("mp4") ? "m4a" : "webm";
        const fd = new FormData();
        fd.append("file", blob, `dictation.${ext}`);
        const res = await fetch("/api/transcribe", { method: "POST", body: fd });
        const data = await res.json().catch(() => ({}));
        const text = typeof data.text === "string" ? data.text.trim() : "";
        if (text) onText(text);
      } catch {
        /* transcription failed — user can type instead */
      } finally {
        setTranscribing(false);
      }
    };
    recRef.current = rec;
    rec.start();
    setListening(true);
  }

  function stop() {
    try { recRef.current?.stop(); } catch { /* */ }
    recRef.current = null;
    setListening(false);
  }

  return { supported, listening, transcribing, toggle: () => (listening ? stop() : void start()) };
}

function Markdown({ content }: { content: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          p: ({ node, ...props }) => <p {...props} className="my-1.5 first:mt-0 last:mb-0" />,
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          ul: ({ node, ...props }) => <ul {...props} className="my-1.5 ml-4 list-disc space-y-0.5" />,
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          ol: ({ node, ...props }) => <ol {...props} className="my-1.5 ml-4 list-decimal space-y-0.5" />,
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          li: ({ node, ...props }) => <li {...props} className="leading-snug" />,
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          strong: ({ node, ...props }) => <strong {...props} className="font-semibold text-ink" />,
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" className="text-indigo-600 underline-offset-2 hover:underline font-medium" />,
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          h1: ({ node, ...props }) => <h3 {...props} className="text-[14px] font-bold text-ink mt-3 mb-1.5 first:mt-0" />,
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          h2: ({ node, ...props }) => <h4 {...props} className="text-[13px] font-bold text-ink mt-2.5 mb-1 first:mt-0" />,
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          h3: ({ node, ...props }) => <h5 {...props} className="text-[13px] font-bold text-ink mt-2.5 mb-1 first:mt-0" />,
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          code: ({ node, inline, ...props }: any) => inline
            ? <code {...props} className="px-1 py-0.5 rounded bg-slate-100 text-[11.5px] font-mono text-ink/85" />
            : <code {...props} className="block px-3 py-2 rounded-lg bg-white border border-slate-200 text-[11.5px] font-mono overflow-x-auto whitespace-pre" />,
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          table: ({ node, ...props }) => <div className="my-2 overflow-x-auto rounded-lg border border-slate-200"><table {...props} className="w-full text-[12px] border-collapse" /></div>,
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          th: ({ node, ...props }) => <th {...props} className="text-left px-2.5 py-1.5 border-b border-slate-200 font-semibold bg-slate-50" />,
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          td: ({ node, ...props }) => <td {...props} className="px-2.5 py-1.5 border-b border-slate-100 last:border-0 align-top" />
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

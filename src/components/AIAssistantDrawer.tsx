"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { motion, AnimatePresence } from "framer-motion";
import { Sparkles, Send, X, ArrowUp, Loader2, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

interface Message { role: "user" | "assistant"; content: string }

const SUGGESTED = [
  "What's on my plate today?",
  "Who has capacity on the website team this week?",
  "What's overdue across the org and who owns each?",
  "Summarise what shipped this week"
];

// White-glass right-rail drawer with the same design language as
// the rest of the app: blue/indigo accents, soft shadows, rounded
// cards, markdown-rendered assistant turns (so tables / headers /
// bold / code blocks render properly instead of showing raw `##`
// and `**`).
export function AIAssistantDrawer({
  open, onOpenChange
}: { open: boolean; onOpenChange: (b: boolean) => void }) {
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
    if (open) setTimeout(() => inputRef.current?.focus(), 150);
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
        body: JSON.stringify({ messages: next })
      });
      const data = await res.json();
      if (!res.ok) {
        setMessages((m) => [...m, {
          role: "assistant",
          content: `⚠ Couldn't reach Claude — ${data?.error ?? res.statusText}`
        }]);
      } else {
        setMessages((m) => [...m, { role: "assistant", content: data.reply ?? "(no reply)" }]);
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
                  <div className="w-9 h-9 rounded-xl bg-white/70 border border-white/80 grid place-items-center shadow-sm shrink-0">
                    <Sparkles className="w-4 h-4 text-accent" />
                  </div>
                  <div className="min-w-0">
                    <Dialog.Title className="text-sm font-semibold leading-tight">
                      Ask AI
                    </Dialog.Title>
                    <div className="text-[10px] text-ink/55 leading-tight">
                      Live access to tasks, people, calendar, more
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
                  {messages.length === 0 && <EmptyState onPick={send} />}
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

function EmptyState({ onPick }: { onPick: (s: string) => void }) {
  return (
    <div className="space-y-4 anim-fade-in">
      <div className="rounded-2xl border border-slate-200/70 bg-gradient-to-br from-blue-50/60 via-white to-fuchsia-50/40 p-4">
        <div className="text-[12px] font-semibold text-ink mb-1 inline-flex items-center gap-1.5">
          <Sparkles className="w-3.5 h-3.5 text-accent" />
          What can I help you with?
        </div>
        <div className="text-[12px] text-ink/65 leading-snug">
          I can read live data from your workspace — tasks, people,
          projects, clients, calendar, kudos, and more. Pick a starter
          or ask anything.
        </div>
      </div>
      <div className="space-y-1.5">
        {SUGGESTED.map((s, idx) => (
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

  const canSend = value.trim().length > 0 && !loading;
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
          placeholder={loading ? "Claude is thinking…" : "Ask anything…"}
          className="flex-1 min-w-0 resize-none bg-transparent text-[13px] leading-snug outline-none placeholder:text-ink/40 py-1.5"
        />
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
          style={canSend ? { background: "linear-gradient(135deg, #2563EB 0%, #1e63ff 100%)" } : {}}
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
        </button>
      </div>
      <div className="text-[10px] text-ink/40 px-2 pt-1.5">
        Enter to send · Shift+Enter for a new line
      </div>
    </div>
  );
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

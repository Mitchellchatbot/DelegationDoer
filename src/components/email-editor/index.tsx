"use client";

import dynamic from "next/dynamic";
import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ALargeSmall, Link2, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { bodyFromDoc, EMPTY_EMAIL_BODY, plainTextToDoc, type EmailBody } from "@/lib/email-doc";
import { emailHtmlToText } from "@/lib/email-html-to-text";
import type { EmailBodySeed, EmailEditorApi, EmailEditorProps } from "./types";

export type { EmailBodySeed, EmailEditorApi, EmailEditorProps } from "./types";

// Rich email body for the inbox composers (links + Gmail's formatting bar).
// The editor (TipTap) is a separate chunk, loaded when a composer mounts.
//
// Typical use:
//   const body = useEmailBody();
//   const [toolbarOpen, toggleToolbar] = useFormattingBar();
//   <EmailEditor {...body.editorProps} toolbarOpen={toolbarOpen} placeholder=… ariaLabel=… />
//   <EmailFormatButtons toolbarOpen={toolbarOpen} onToggleToolbar={toggleToolbar}
//                       onInsertLink={() => body.apiRef.current?.openLinkDialog()} />

const loadEditor = () => import("./EmailEditorImpl");

const EmailEditorImpl = dynamic(loadEditor, {
  ssr: false,
  loading: () => <div className="min-h-[120px] animate-pulse rounded-xl border border-slate-200/70 bg-slate-50/60" />
});

export function preloadEmailEditor(): void {
  loadEditor().catch(() => {
    /* surfaced by the error boundary when the editor renders */
  });
}

export function EmailEditor(props: EmailEditorProps) {
  return (
    <EditorBoundary fallback={(error) => <PlainBodyFallback {...props} error={error} />}>
      <EmailEditorImpl {...props} />
    </EditorBoundary>
  );
}

class EditorBoundary extends Component<
  { fallback: (error: Error) => ReactNode; children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("[email-editor] falling back to plain text:", error);
  }

  render() {
    return this.state.error ? this.props.fallback(this.state.error) : this.props.children;
  }
}

function bodyForFallback(seed: EmailBodySeed | null): EmailBody {
  if (!seed) return EMPTY_EMAIL_BODY;
  if (seed.kind === "text") return bodyFromDoc(plainTextToDoc(seed.text));
  if (seed.kind === "doc") return bodyFromDoc(seed.doc);
  const text = emailHtmlToText(seed.html);
  return { doc: null, html: seed.html, text, isEmpty: !text.trim(), isPlain: false };
}

// Shown when the editor chunk can't load — typically a tab left open across a
// deploy, whose old chunk no longer exists — or the editor crashes. Plain
// bodies stay editable as text. A formatted body is left untouched (so
// autosave doesn't strip its links) unless the user chooses to edit it as text.
function PlainBodyFallback(props: EmailEditorProps & { error: Error }) {
  const { apiRef, initial, placeholder, ariaLabel, contentClassName, fill, error } = props;
  const propsRef = useRef(props);
  propsRef.current = props;
  const [body, setBody] = useState(() => bodyForFallback(initial));
  const bodyRef = useRef(body);
  // Exactly what's typed; body.text drops trailing blank lines, and feeding
  // it back would swallow Enter at the end of the text.
  const [raw, setRaw] = useState(body.text);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const show = (next: EmailBody) => {
      bodyRef.current = next;
      setBody(next);
      setRaw(next.text);
      return next;
    };
    const api: EmailEditorApi = {
      getBody: () => bodyRef.current,
      load: (seed) => propsRef.current.onLoad(show(bodyForFallback(seed))),
      replace: (seed) => propsRef.current.onChange(show(bodyForFallback(seed))),
      focus: () => textareaRef.current?.focus(),
      openLinkDialog: () => {}
    };
    apiRef.current = api;
    propsRef.current.onLoad(bodyRef.current);
    return () => {
      if (apiRef.current === api) apiRef.current = null;
    };
  }, [apiRef]);

  const staleChunk = error.name === "ChunkLoadError" || /loading (css )?chunk/i.test(error.message);

  function editAsText(text: string) {
    const next = bodyFromDoc(plainTextToDoc(text));
    bodyRef.current = next;
    setBody(next);
    setRaw(text);
    propsRef.current.onChange(next);
  }

  return (
    <div className={cn("flex flex-col rounded-xl border border-amber-200 bg-amber-50/40", fill && "flex-1 min-h-0")}>
      <div className="flex items-center gap-2 px-3 py-1.5 text-[11.5px] text-amber-900 border-b border-amber-200/70">
        <span className="flex-1">
          {staleChunk
            ? "DelegationDoer was updated — reload to use links and formatting."
            : "Links and formatting aren't available right now."}
        </span>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="inline-flex items-center gap-1 font-semibold text-amber-800 hover:text-amber-950"
        >
          <RefreshCw className="w-3 h-3" /> Reload
        </button>
      </div>
      {body.isPlain ? (
        <textarea
          ref={textareaRef}
          aria-label={ariaLabel}
          value={raw}
          onChange={(e) => editAsText(e.target.value)}
          placeholder={placeholder}
          className={cn(
            "w-full resize-none bg-white/60 px-3 py-2.5 text-sm outline-none rounded-b-xl",
            contentClassName,
            fill && "flex-1 min-h-0"
          )}
        />
      ) : (
        <div className={cn("px-3 py-2.5 text-sm space-y-2", fill && "flex-1 min-h-0 overflow-y-auto")}>
          <p className="whitespace-pre-wrap text-ink/70">{body.text}</p>
          <button
            type="button"
            onClick={() => {
              if (window.confirm("Edit as plain text? Links and formatting in this message will be removed.")) {
                editAsText(body.text);
              }
            }}
            className="text-[11px] font-semibold text-accent/80 hover:text-accent"
          >
            Edit as plain text
          </button>
        </div>
      )}
    </div>
  );
}

// Parent-side state for an email body. `ready` is false while content handed
// to seed() hasn't reached the editor yet (e.g. a restored draft while the
// editor chunk loads); composers hold autosave, AI drafting and Send until it's
// true, so an empty editor can never overwrite a draft. `loads` counts content
// put in by code — seed() or reset(), not typing and not a remount — so
// autosave can treat that content as already saved.
export function useEmailBody() {
  const apiRef = useRef<EmailEditorApi | null>(null);
  const [body, setBody] = useState<EmailBody>(EMPTY_EMAIL_BODY);
  const bodyRef = useRef(body);
  const pendingRef = useRef<EmailBodySeed | null>(null);
  const loadingRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [loads, setLoads] = useState(0);

  useEffect(() => {
    // Fetch the editor chunk early, so opening a composer is instant and a
    // tab opened before a deploy already has it.
    const w = window as Window & { requestIdleCallback?: (cb: () => void) => number };
    if (w.requestIdleCallback) w.requestIdleCallback(preloadEmailEditor);
    else setTimeout(preloadEmailEditor, 1500);
  }, []);

  const commit = useCallback((next: EmailBody) => {
    bodyRef.current = next;
    setBody(next);
  }, []);

  const onLoad = useCallback(
    (next: EmailBody) => {
      // A plain (re)mount reports content the parent already has; only a
      // pending seed or an explicit load is new content.
      const loaded = loadingRef.current || pendingRef.current !== null;
      loadingRef.current = false;
      pendingRef.current = null;
      commit(next);
      setReady(true);
      if (loaded) setLoads((n) => n + 1);
    },
    [commit]
  );

  // Put content into the editor. Undoable seeds (an AI draft) can be reverted
  // with ⌘Z; the rest (restoring a draft) replace the content outright.
  const seed = useCallback((next: EmailBodySeed, opts?: { undoable?: boolean }) => {
    const api = apiRef.current;
    if (api) {
      if (opts?.undoable) {
        api.replace(next);
      } else {
        loadingRef.current = true;
        api.load(next);
      }
      return;
    }
    pendingRef.current = next;
    setReady(false);
  }, []);

  const reset = useCallback(() => {
    pendingRef.current = null;
    if (apiRef.current) {
      loadingRef.current = true;
      apiRef.current.load(null);
    } else {
      commit(EMPTY_EMAIL_BODY);
      setLoads((n) => n + 1);
    }
  }, [commit]);

  // The body as of right now — use this in send handlers rather than `body`,
  // which a click handler may see one render late.
  const current = useCallback(() => apiRef.current?.getBody() ?? bodyRef.current, []);

  const latest = bodyRef.current;
  const initial: EmailBodySeed | null =
    pendingRef.current ??
    (latest.doc ? { kind: "doc", doc: latest.doc } : latest.html ? { kind: "html", html: latest.html } : null);

  return {
    apiRef,
    body,
    ready,
    loads,
    seed,
    reset,
    current,
    editorProps: { apiRef, initial, onLoad, onChange: commit }
  };
}

const FORMATTING_BAR_KEY = "dd.emailFormattingBar";

// Gmail-style "Formatting options" toggle, remembered across composers.
export function useFormattingBar(): [boolean, () => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    try {
      setOpen(window.localStorage.getItem(FORMATTING_BAR_KEY) === "1");
    } catch {
      /* storage unavailable — default closed */
    }
  }, []);
  const toggle = useCallback(() => {
    setOpen((was) => {
      try {
        window.localStorage.setItem(FORMATTING_BAR_KEY, was ? "0" : "1");
      } catch {
        /* not remembered, still toggles */
      }
      return !was;
    });
  }, []);
  return [open, toggle];
}

// The two footer buttons: formatting bar toggle and insert link.
export function EmailFormatButtons({
  toolbarOpen,
  onToggleToolbar,
  onInsertLink,
  disabled
}: {
  toolbarOpen: boolean;
  onToggleToolbar: () => void;
  onInsertLink: () => void;
  disabled?: boolean;
}) {
  const [mod, setMod] = useState("Ctrl+");
  useEffect(() => {
    if (/Mac|iPhone|iPad/.test(navigator.platform)) setMod("⌘");
  }, []);
  const base =
    "inline-flex items-center justify-center w-7 h-7 rounded-full border transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
  return (
    <>
      <button
        type="button"
        onClick={onToggleToolbar}
        disabled={disabled}
        aria-pressed={toolbarOpen}
        aria-label="Formatting options"
        title="Formatting options"
        className={cn(
          base,
          toolbarOpen
            ? "bg-white border-accent/40 text-accent"
            : "bg-white/60 border-slate-200/70 text-ink/65 hover:text-ink hover:border-accent/40"
        )}
      >
        <ALargeSmall className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        // Keep the editor's selection: the link wraps what's selected.
        onMouseDown={(e) => e.preventDefault()}
        onClick={onInsertLink}
        disabled={disabled}
        aria-label="Insert link"
        title={`Insert link (${mod}K)`}
        className={cn(base, "bg-white/60 border-slate-200/70 text-ink/65 hover:text-ink hover:border-accent/40")}
      >
        <Link2 className="w-3.5 h-3.5" />
      </button>
    </>
  );
}

import Link from "next/link";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { SAFE_MARKDOWN_LINK_REL, SAFE_MARKDOWN_OPTIONS, safeLink } from "@/lib/exec/safe-markdown";
import { cn } from "@/lib/utils";

// Markdown for every piece of model output and untrusted text in the exec UI.
// The policy (no HTML, no images, allowlisted links only) is
// src/lib/exec/safe-markdown.ts; this file adds the house prose styling
// (MarkdownBody's). No "use client": react-markdown's default export has no
// hooks, so this renders in server and client components alike.
//
// Each override passes on only the props it needs, so react-markdown's `node`
// never reaches the DOM.
const components: Components = {
  // urlTransform has already cleared every href that isn't safe, so a link
  // without one is shown as its text. Asking safeLink again (it is idempotent
  // on its own output) decides where it opens: a DD path in place, an
  // allowlisted Outlook/Slack URL in a new tab.
  a: ({ href, title, children }) => {
    const link = safeLink(href);
    if (!link) return <span>{children}</span>;
    const className = "font-medium text-accent underline-offset-2 hover:underline";
    if (!link.external) {
      return (
        <Link href={link.href} title={title} rel={SAFE_MARKDOWN_LINK_REL} prefetch={false} className={className}>
          {children}
        </Link>
      );
    }
    return (
      <a href={link.href} title={title} target="_blank" rel={SAFE_MARKDOWN_LINK_REL} className={className}>
        {children}
      </a>
    );
  },
  h1: ({ children }) => <h3 className="mb-1.5 mt-3 text-[15px] font-bold text-ink first:mt-0">{children}</h3>,
  h2: ({ children }) => <h4 className="mb-1.5 mt-3 text-[14px] font-bold text-ink first:mt-0">{children}</h4>,
  h3: ({ children }) => <h5 className="mb-1 mt-2.5 text-[13px] font-bold text-ink first:mt-0">{children}</h5>,
  h4: ({ children }) => <h6 className="mb-1 mt-2.5 text-[13px] font-semibold text-ink first:mt-0">{children}</h6>,
  h5: ({ children }) => <h6 className="mb-1 mt-2.5 text-[13px] font-semibold text-ink first:mt-0">{children}</h6>,
  h6: ({ children }) => <h6 className="mb-1 mt-2.5 text-[13px] font-semibold text-ink first:mt-0">{children}</h6>,
  p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-1.5 ml-4 list-disc space-y-0.5">{children}</ul>,
  ol: ({ children, start }) => (
    <ol start={start} className="my-1.5 ml-4 list-decimal space-y-0.5">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="leading-snug">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
  em: ({ children }) => <em className="italic text-ink/85">{children}</em>,
  del: ({ children }) => <del className="text-ink/60">{children}</del>,
  blockquote: ({ children }) => <blockquote className="my-2 border-l-2 border-accent/40 pl-3 italic text-ink/70">{children}</blockquote>,
  hr: () => <hr className="my-3 border-slate-200" />,
  // react-markdown 10 no longer says whether code is inline, so code is styled
  // inline by default and a fenced block is styled through its <pre>, which
  // also resets the inline look of the <code> inside it.
  code: ({ children }) => <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[11.5px] text-ink/85">{children}</code>,
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto whitespace-pre rounded-lg border border-slate-200/70 bg-slate-50 px-3 py-2 font-mono text-[11.5px] [&>code]:bg-transparent [&>code]:p-0">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto rounded-lg border border-slate-200/70">
      <table className="w-full border-collapse text-[12px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-slate-50 font-semibold text-ink/65">{children}</thead>,
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => <tr>{children}</tr>,
  th: ({ children, style }) => (
    <th style={style} className="border-b border-slate-200/70 px-2.5 py-1.5 text-left font-semibold">
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td style={style} className="border-b border-slate-100 px-2.5 py-1.5 align-top last:border-0">
      {children}
    </td>
  )
};

export function SafeMarkdown({ content, className }: { content: string; className?: string }) {
  return (
    <div className={cn("min-w-0 break-words text-[13px] leading-relaxed text-ink", className)}>
      <Markdown {...SAFE_MARKDOWN_OPTIONS} remarkPlugins={[remarkGfm]} components={components}>
        {typeof content === "string" ? content : ""}
      </Markdown>
    </div>
  );
}

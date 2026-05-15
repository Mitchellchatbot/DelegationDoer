"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Shared Markdown renderer. Same tight, brand-aligned styling the AI
// assistant uses — extracted so task descriptions, comment threads,
// and anywhere else we render Markdown look identical instead of
// having three slightly-different prose styles.
//
// remark-gfm gives us tables, task lists, strikethrough, autolinks.
// Links open in a new tab; no raw HTML is rendered (react-markdown's
// default skipHtml behavior keeps us safe from inline <script>).
export function MarkdownBody({ content }: { content: string }) {
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

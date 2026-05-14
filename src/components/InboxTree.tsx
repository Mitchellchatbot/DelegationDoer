"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { Inbox, Mail, Settings as SettingsIcon, Layers, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { ConnectInboxDialog } from "./ConnectInboxDialog";

// Left-rail tree for the inbox surface. Sections collapse into:
//   • Smart — All inboxes (combined view, "/inboxes/all")
//   • Inboxes — one entry per Missive account the user can see
//   • Manage — link to /inboxes/manage when the actor is a Leader
//
// Active state slides between rows via framer-motion's `layoutId`, so the
// person reading the inbox always sees which section they're in.

export interface InboxNode {
  id: string;
  label: string;
  email: string | null;
}

interface Props {
  accounts: InboxNode[];
  canManage: boolean;
}

export function InboxTree({ accounts, canManage }: Props) {
  const path = usePathname();

  // Stable hue per account so the same inbox always shows the same dot.
  function hueIndex(seed: string): number {
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
    return Math.abs(h) % DOT_TONES.length;
  }

  return (
    <aside className="w-60 shrink-0">
      <div className="sticky top-3 space-y-4 max-h-[calc(100vh-1.5rem)] overflow-y-auto pr-1">
        <Section label="Smart">
          <Row
            href="/inboxes/all"
            active={path === "/inboxes/all" || path === "/inboxes"}
            icon={<Layers className="w-3.5 h-3.5" />}
            label="All inboxes"
            tone="indigo"
          />
        </Section>

        <Section
          label="Inboxes"
          emptyHint={
            accounts.length === 0
              ? canManage
                ? "Hit + below to link your first one."
                : "Nothing here yet"
              : undefined
          }
          action={
            canManage ? (
              <ConnectInboxDialog
                trigger={
                  <button
                    type="button"
                    className="inline-flex items-center gap-0.5 text-[10px] text-accent hover:text-accent/80 font-medium"
                    title="Connect a new mailbox"
                  >
                    <Plus className="w-3 h-3" />
                    New
                  </button>
                }
              />
            ) : null
          }
        >
          {accounts.map((a) => {
            const href = `/inboxes/${encodeURIComponent(a.id)}`;
            return (
              <Row
                key={a.id}
                href={href}
                active={path.startsWith(href)}
                icon={
                  <span
                    className={cn(
                      "w-2 h-2 rounded-full shrink-0",
                      DOT_TONES[hueIndex(a.id)]
                    )}
                  />
                }
                label={a.label || a.email || a.id}
                subtitle={a.email && a.email !== a.label ? a.email : null}
                tone="blue"
              />
            );
          })}
        </Section>

        {canManage && (
          <Section label="Admin">
            <Row
              href="/inboxes/manage"
              active={path === "/inboxes/manage"}
              icon={<SettingsIcon className="w-3.5 h-3.5" />}
              label="Manage access"
              tone="amber"
            />
            <ConnectInboxDialog
              trigger={
                <button
                  type="button"
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[13px] text-blue-700 hover:bg-blue-50 transition-colors"
                  title="Link a new mailbox over IMAP / OAuth"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Connect new inbox
                </button>
              }
            />
          </Section>
        )}
      </div>
    </aside>
  );
}

const DOT_TONES = [
  "bg-blue-500", "bg-indigo-500", "bg-violet-500", "bg-fuchsia-500",
  "bg-pink-500", "bg-amber-500", "bg-emerald-500", "bg-teal-500"
];

function Section({
  label, children, emptyHint, action
}: {
  label: string;
  children: React.ReactNode;
  emptyHint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center justify-between px-2 mb-1">
        <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-ink/45">
          {label}
        </div>
        {action}
      </div>
      <nav className="space-y-0.5">{children}</nav>
      {emptyHint && (
        <div className="px-2 text-[11px] text-ink/45 italic">{emptyHint}</div>
      )}
    </div>
  );
}

const TONE_BG: Record<string, string> = {
  blue:    "text-blue-700",
  indigo:  "text-indigo-700",
  amber:   "text-amber-700"
};

function Row({
  href, active, icon, label, subtitle, tone
}: {
  href: string;
  active: boolean;
  icon: React.ReactNode;
  label: string;
  subtitle?: string | null;
  tone: "blue" | "indigo" | "amber";
}) {
  return (
    <Link
      href={href}
      className={cn(
        "relative flex items-center gap-2 px-2.5 py-1.5 rounded-xl text-[13px] transition-colors group",
        active
          ? cn("font-semibold", TONE_BG[tone])
          : "text-ink/65 hover:text-ink"
      )}
    >
      {active && (
        <motion.span
          layoutId="inbox-tree-active"
          className="absolute inset-0 -z-10 rounded-xl bg-accent/10 ring-1 ring-accent/25 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.7)]"
          transition={{ type: "spring", stiffness: 500, damping: 36 }}
        />
      )}
      {/* Icon slot — fixed width so labels align even with mixed glyph sizes */}
      <span
        className={cn(
          "w-5 h-5 grid place-items-center shrink-0",
          active ? "text-accent" : "text-ink/45 group-hover:text-ink/70 transition-colors"
        )}
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate leading-tight">{label}</div>
        {subtitle && (
          <div className="text-[10px] text-ink/45 truncate leading-tight mt-0.5">
            {subtitle}
          </div>
        )}
      </div>
    </Link>
  );
}

// Empty + loading hints reused by callers that fetch their own data.
export function InboxTreeSkeleton() {
  return (
    <aside className="w-60 shrink-0">
      <div className="sticky top-3 space-y-4 pr-1">
        {["Smart", "Inboxes"].map((s) => (
          <div key={s}>
            <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-ink/45 px-2 mb-1">
              {s}
            </div>
            <div className="space-y-1">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="h-7 rounded-xl bg-slate-100/70 animate-pulse"
                  style={{ animationDelay: `${i * 80}ms` }}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}

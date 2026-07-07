"use client";

import Link from "next/link";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import { Inbox, Mail, Settings as SettingsIcon, Layers, ListChecks, Plus, ChevronDown, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { cn, initials } from "@/lib/utils";
import { ConnectInboxDialog } from "./ConnectInboxDialog";
import { InboxFavicon } from "./InboxFavicon";
import { useInboxFocus } from "./InboxFocusProvider";
import { useInboxTreeDrawer } from "./InboxTreeDrawerProvider";
import { useIsMobile } from "@/lib/use-is-mobile";

// Left-rail tree for the inbox surface. Sections collapse into:
//   • Smart — All inboxes (combined view, "/inboxes/all")
//   • Spaces — Missive-style team groupings; each space lists the
//     accounts that belong to it
//   • Inboxes — every other account the user can see directly
//   • Admin — link to /inboxes/manage when the actor is a Leader
//
// Active state slides between rows via framer-motion's `layoutId`, so the
// person reading the inbox always sees which section they're in.

export interface InboxNode {
  id: string;
  label: string;
  email: string | null;
}

interface Space {
  id: string;
  name: string;
  color: string;
  accountIds: string[];
}

interface Props {
  accounts: InboxNode[];
  canManage: boolean;
}

const SPACE_COLOR_DOT: Record<string, string> = {
  blue: "bg-blue-500",      indigo: "bg-indigo-500",
  violet: "bg-violet-500",  fuchsia: "bg-fuchsia-500",
  pink: "bg-pink-500",      amber: "bg-amber-500",
  emerald: "bg-emerald-500", teal: "bg-teal-500",
  rose: "bg-rose-500",      sky: "bg-sky-500"
};

export function InboxTree({ accounts, canManage }: Props) {
  const path = usePathname();
  // Focus Mode (driven by the reply composer) collapses the whole rail so the
  // thread + composer can fill the content area. Width/opacity animate to 0;
  // the DD sidebar (outside this provider) is untouched.
  const { focusMode } = useInboxFocus();
  // On phones the rail becomes a left drawer (fixed, off-canvas) toggled from
  // the inbox layout's "Inboxes" button. isMobile gates the framer width.
  const isMobile = useIsMobile();
  const { open: treeOpen } = useInboxTreeDrawer();
  const [spaces, setSpaces] = useState<Space[]>([]);
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/inbox-spaces", { cache: "no-store" });
        if (!res.ok) return;
        const d = await res.json();
        if (cancelled || !d?.spaces) return;
        setSpaces(d.spaces);
      } catch { /* spaces table absent / network issue — ignore */ }
    }
    load();
    // SpacesManager dispatches this when it creates / edits / deletes
    // a space, so the sidebar reflects the change without a reload.
    function onChanged() { load(); }
    window.addEventListener("inbox-spaces:changed", onChanged);
    return () => {
      cancelled = true;
      window.removeEventListener("inbox-spaces:changed", onChanged);
    };
  }, []);

  const accountById = new Map(accounts.map((a) => [a.id, a]));
  // Accounts NOT in any space the user can see — show them under
  // a fallback "Other" section so nothing gets hidden.
  const inSpace = new Set<string>();
  for (const s of spaces) for (const aid of s.accountIds) inSpace.add(aid);
  const orphanAccounts = accounts.filter((a) => !inSpace.has(a.id));
  // Spaces this user actually has any accounts of (don't show empty
  // spaces full of inboxes they can't see).
  const visibleSpaces = spaces
    .map((s) => ({
      ...s,
      accountIds: s.accountIds.filter((aid) => accountById.has(aid))
    }))
    .filter((s) => s.accountIds.length > 0);

  // Stable hue per account so the same inbox always shows the same dot.
  function hueIndex(seed: string): number {
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
    return Math.abs(h) % DOT_TONES.length;
  }

  // Whole-rail collapse → a thin icon strip, so the inbox account tree stops
  // eating a second full nav column (the list + reading pane reclaim the room).
  // Default expanded; persisted in localStorage, read on mount like Section.
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      if (window.localStorage.getItem("inbox-tree:collapsed") === "1") setCollapsed(true);
    } catch { /* localStorage blocked — keep default */ }
  }, []);
  function toggleCollapsed() {
    setCollapsed((cur) => {
      const next = !cur;
      try { window.localStorage.setItem("inbox-tree:collapsed", next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  }

  // Flat account list for the collapsed rail — spaces first (in order), then
  // orphans — so switching inboxes stays available without expanding.
  const railAccounts = [
    ...visibleSpaces.flatMap((sp) => sp.accountIds.map((id) => accountById.get(id)!)),
    ...orphanAccounts
  ];

  // On mobile the tree is always the full drawer (the icon-strip collapse is a
  // desktop space-saver that makes no sense in an off-canvas drawer).
  if (collapsed && !isMobile) {
    return (
      <motion.aside
        initial={false}
        animate={{ width: focusMode ? 0 : 48, opacity: focusMode ? 0 : 1 }}
        transition={{ duration: 0.25, ease: [0.2, 0.8, 0.2, 1] }}
        className={cn("shrink-0 overflow-hidden", focusMode && "pointer-events-none")}
      >
        <div className="sticky top-3 max-h-[calc(100vh-1.5rem)] overflow-y-auto flex flex-col items-center gap-1.5 pb-2">
          <button
            type="button"
            onClick={toggleCollapsed}
            title="Expand inboxes"
            className="w-9 h-9 grid place-items-center rounded-xl text-ink/55 hover:text-accent hover:bg-accent/10 transition-colors"
          >
            <PanelLeftOpen className="w-4 h-4" />
          </button>

          <RailLink
            href="/inboxes/all"
            active={path === "/inboxes/all" || path === "/inboxes"}
            title="All inboxes"
          >
            <Layers className="w-4 h-4" />
          </RailLink>

          <RailLink
            href="/inboxes/selected"
            active={path === "/inboxes/selected"}
            title="Selected inboxes"
          >
            <ListChecks className="w-4 h-4" />
          </RailLink>

          {railAccounts.map((a) => {
            const href = `/inboxes/${encodeURIComponent(a.id)}`;
            return (
              <RailLink key={a.id} href={href} active={path.startsWith(href)} title={a.label || a.email || a.id}>
                <InboxFavicon
                  email={a.email}
                  title={a.label || a.email || a.id}
                  size={30}
                  className="rounded-md"
                  loadedClassName="bg-white ring-1 ring-black/5"
                  fallbackClassName={cn("text-white", DOT_TONES[hueIndex(a.id)])}
                  fallback={
                    <span className="text-[9px] font-semibold leading-none uppercase">
                      {initials(a.label || a.email || a.id) || "@"}
                    </span>
                  }
                />
              </RailLink>
            );
          })}

          {canManage && (
            <RailLink href="/inboxes/manage" active={path === "/inboxes/manage"} title="Manage access">
              <SettingsIcon className="w-4 h-4" />
            </RailLink>
          )}
        </div>
      </motion.aside>
    );
  }

  const drawer = (
    <motion.aside
      initial={false}
      animate={{
        width: isMobile ? 288 : (focusMode ? 0 : 240),
        opacity: isMobile ? 1 : (focusMode ? 0 : 1)
      }}
      transition={{ duration: 0.25, ease: [0.2, 0.8, 0.2, 1] }}
      className={cn(
        "shrink-0 overflow-hidden",
        // Mobile: off-canvas left drawer over a scrim (fixed → out of flow, so
        // the list/pane reclaim the full width). CSS `-translate-x-full` hides
        // it from first paint even before isMobile flips, so no width flash.
        // z-50 (portaled to body below) so it clears the sticky Topbar (z-30).
        "fixed inset-y-0 left-0 z-50 -translate-x-full transition-transform duration-300 bg-white shadow-lift rounded-r-2xl",
        treeOpen && "translate-x-0",
        // md+: restore the original inline static rail.
        "md:static md:inset-auto md:z-auto md:transform-none md:transition-none md:bg-transparent md:shadow-none md:rounded-none",
        focusMode && "pointer-events-none"
      )}
    >
      <div className="sticky top-3 space-y-4 max-h-[calc(100vh-1.5rem)] overflow-y-auto px-3 md:px-0 md:pr-1">
        <div className="hidden md:flex justify-end -mb-2">
          <button
            type="button"
            onClick={toggleCollapsed}
            title="Collapse inboxes"
            className="w-7 h-7 grid place-items-center rounded-lg text-ink/45 hover:text-accent hover:bg-accent/10 transition-colors"
          >
            <PanelLeftClose className="w-4 h-4" />
          </button>
        </div>
        <Section label="Smart">
          <Row
            href="/inboxes/all"
            active={path === "/inboxes/all" || path === "/inboxes"}
            icon={<Layers className="w-3.5 h-3.5" />}
            label="All inboxes"
            tone="indigo"
          />
          <Row
            href="/inboxes/selected"
            active={path === "/inboxes/selected"}
            icon={<ListChecks className="w-3.5 h-3.5" />}
            label="Selected inboxes"
            tone="indigo"
          />
        </Section>

        {/* Team spaces — each one groups a chunk of accounts under
            a leader-defined label (Tech Hub, Marketing, etc.).
            Collapsible so long lists don't blow out the left rail. */}
        {visibleSpaces.map((sp) => {
          // Auto-expand a space when one of its inboxes is the
          // active route, so navigating to that inbox doesn't leave
          // the user staring at a collapsed section.
          const hasActive = sp.accountIds.some((aid) =>
            path.startsWith(`/inboxes/${encodeURIComponent(aid)}`)
          );
          return (
            <Section
              key={sp.id}
              label={sp.name}
              storageKey={`inbox-tree:space:${sp.id}`}
              forceOpen={hasActive}
              collapsible
              count={sp.accountIds.length}
            >
              {sp.accountIds.map((aid) => {
                const a = accountById.get(aid)!;
                const href = `/inboxes/${encodeURIComponent(a.id)}`;
                return (
                  <Row
                    key={a.id}
                    href={href}
                    active={path.startsWith(href)}
                    icon={
                      <InboxFavicon
                        email={a.email}
                        title={a.label || a.email || a.id}
                        className="rounded-md"
                        loadedClassName="bg-white ring-1 ring-black/5"
                        fallbackClassName={cn(
                          "text-white",
                          SPACE_COLOR_DOT[sp.color] ?? DOT_TONES[hueIndex(a.id)]
                        )}
                        fallback={
                          <span className="text-[9px] font-semibold leading-none uppercase">
                            {initials(a.label || a.email || a.id) || "@"}
                          </span>
                        }
                      />
                    }
                    label={a.label || a.email || a.id}
                    subtitle={a.email && a.email !== a.label ? a.email : null}
                    tone="blue"
                  />
                );
              })}
            </Section>
          );
        })}

        <Section
          label={visibleSpaces.length > 0 ? "Other" : "Inboxes"}
          storageKey="inbox-tree:other"
          collapsible={orphanAccounts.length > 0}
          forceOpen={orphanAccounts.some((a) => path.startsWith(`/inboxes/${encodeURIComponent(a.id)}`))}
          count={orphanAccounts.length}
          emptyHint={
            orphanAccounts.length === 0 && visibleSpaces.length === 0
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
          {orphanAccounts.map((a) => {
            const href = `/inboxes/${encodeURIComponent(a.id)}`;
            return (
              <Row
                key={a.id}
                href={href}
                active={path.startsWith(href)}
                icon={
                  <InboxFavicon
                    email={a.email}
                    title={a.label || a.email || a.id}
                    className="rounded-md"
                    loadedClassName="bg-white ring-1 ring-black/5"
                    fallbackClassName={cn("text-white", DOT_TONES[hueIndex(a.id)])}
                    fallback={
                      <span className="text-[9px] font-semibold leading-none uppercase">
                        {initials(a.label || a.email || a.id) || "@"}
                      </span>
                    }
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
    </motion.aside>
  );

  // On mobile, portal the drawer to <body> so its `fixed` positioning escapes
  // the `<main className="relative z-10">` stacking context (otherwise z-50
  // would still paint under the Topbar). On desktop it stays inline as the
  // static rail. isMobile is only ever true after mount (client), so
  // document.body is defined — SSR renders the inline branch.
  return isMobile ? createPortal(drawer, document.body) : drawer;
}

const DOT_TONES = [
  "bg-blue-500", "bg-indigo-500", "bg-violet-500", "bg-fuchsia-500",
  "bg-pink-500", "bg-amber-500", "bg-emerald-500", "bg-teal-500"
];

// Icon-only row for the collapsed rail. Tooltip carries the inbox name; the
// active inbox gets an accent ring so you can still see where you are.
function RailLink({
  href, active, title, children
}: {
  href: string;
  active: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      title={title}
      aria-label={title}
      aria-current={active ? "true" : undefined}
      className={cn(
        "w-9 h-9 grid place-items-center rounded-xl transition-colors",
        active
          ? "bg-accent/10 ring-1 ring-accent/30 text-accent"
          : "text-ink/60 hover:text-ink hover:bg-slate-100"
      )}
    >
      {children}
    </Link>
  );
}

function Section({
  label, children, emptyHint, action, collapsible, forceOpen, storageKey, count
}: {
  label: string;
  children: React.ReactNode;
  emptyHint?: string;
  action?: React.ReactNode;
  // When true, the header becomes a button that toggles the body.
  // Sections that have nothing meaningful to collapse (Smart, Admin)
  // omit this and render statically.
  collapsible?: boolean;
  // Force the section open regardless of stored state — used when one
  // of its rows is the active route, so users don't have to expand a
  // collapsed section to see where they are.
  forceOpen?: boolean;
  // localStorage key. Open/closed state persists per-section so the
  // user's preference survives navigation + reloads.
  storageKey?: string;
  // Optional count shown next to the label.
  count?: number;
}) {
  // Default to open. Read persisted state on mount only — server-side
  // render uses the default, then the effect aligns to localStorage.
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (!collapsible || !storageKey) return;
    try {
      const stored = window.localStorage.getItem(storageKey);
      if (stored === "0") setOpen(false);
      else if (stored === "1") setOpen(true);
    } catch { /* localStorage blocked — keep default */ }
  }, [collapsible, storageKey]);

  function toggle() {
    setOpen((cur) => {
      const next = !cur;
      if (storageKey) {
        try { window.localStorage.setItem(storageKey, next ? "1" : "0"); } catch { /* ignore */ }
      }
      return next;
    });
  }

  const effectiveOpen = forceOpen || open;
  const HeaderEl = collapsible ? "button" : "div";

  return (
    <div>
      <div className="flex items-center justify-between px-2 mb-1">
        <HeaderEl
          type={collapsible ? "button" : undefined}
          onClick={collapsible ? toggle : undefined}
          className={cn(
            "flex items-center gap-1 text-[10px] uppercase tracking-[0.18em] font-semibold text-ink/45",
            collapsible && "hover:text-ink/70 transition-colors"
          )}
          title={collapsible ? (effectiveOpen ? "Collapse" : "Expand") : undefined}
        >
          {collapsible && (
            <ChevronDown
              className={cn(
                "w-3 h-3 transition-transform shrink-0",
                !effectiveOpen && "-rotate-90"
              )}
            />
          )}
          <span>{label}</span>
          {typeof count === "number" && count > 0 && (
            <span className="ml-1 text-[9px] font-medium text-ink/35 tabular-nums">
              {count}
            </span>
          )}
        </HeaderEl>
        {action}
      </div>
      {effectiveOpen && (
        <>
          <nav className="space-y-0.5">{children}</nav>
          {emptyHint && (
            <div className="px-2 text-[11px] text-ink/45 italic">{emptyHint}</div>
          )}
        </>
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

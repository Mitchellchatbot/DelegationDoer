"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useBodyScrollLock } from "@/lib/use-body-scroll-lock";

// Open/close state for the inbox folder/account switcher (InboxTree), which on
// mobile becomes its own left drawer — independent of the app-shell nav drawer
// (NavDrawerProvider) so the two never fight. On md+ the tree is a static rail
// and this state is inert (the scrim below is `md:hidden`).

interface InboxTreeDrawerCtx {
  open: boolean;
  toggle: () => void;
  close: () => void;
}

const Ctx = createContext<InboxTreeDrawerCtx>({
  open: false,
  toggle: () => {},
  close: () => {}
});

export const useInboxTreeDrawer = () => useContext(Ctx);

export function InboxTreeDrawerProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const path = usePathname();

  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((o) => !o), []);

  useEffect(() => setMounted(true), []);

  // Picking an inbox is a <Link> nav → close on any path change.
  useEffect(() => {
    setOpen(false);
  }, [path]);

  // Force-close if the viewport crosses to md+ while open (see NavDrawerProvider
  // — same body-scroll-lock strand hazard on rotate/resize).
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const onChange = () => { if (mq.matches) setOpen(false); };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useBodyScrollLock(open);

  return (
    <Ctx.Provider value={{ open, toggle, close }}>
      {children}
      {/* Scrim behind the tree drawer. Portaled to <body> so it escapes the
          `<main className="relative z-10">` stacking context and can actually
          cover the sticky Topbar (z-30); z-40 sits under the tree's z-50.
          Mobile only — `md:hidden`; the tree is a static rail on md+. */}
      {mounted && createPortal(
        <div
          aria-hidden
          onClick={close}
          className={cn(
            "fixed inset-0 z-40 bg-slate-950/40 backdrop-blur-sm transition-opacity duration-300 md:hidden",
            open ? "opacity-100" : "pointer-events-none opacity-0"
          )}
        />,
        document.body
      )}
    </Ctx.Provider>
  );
}

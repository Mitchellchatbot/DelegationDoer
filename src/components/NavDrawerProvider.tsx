"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode
} from "react";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useBodyScrollLock } from "@/lib/use-body-scroll-lock";

// Shared open/close state for the app-shell nav drawer, so the Topbar hamburger
// (trigger) and the Sidebar (which becomes an off-canvas drawer on mobile) can
// talk across the server-component shell. On desktop the Sidebar is `md:static`
// and this state is inert — the scrim below is `md:hidden`.

interface NavDrawerCtx {
  open: boolean;
  toggle: () => void;
  close: () => void;
}

const Ctx = createContext<NavDrawerCtx>({
  open: false,
  toggle: () => {},
  close: () => {}
});

export const useNavDrawer = () => useContext(Ctx);

export function NavDrawerProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const path = usePathname();

  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((o) => !o), []);

  // Close after any navigation — covers a nav <Link> click, breadcrumb, or a
  // programmatic push, without threading onClick through every row.
  useEffect(() => {
    setOpen(false);
  }, [path]);

  // If the viewport crosses to md+ while open (e.g. a phone rotated to a
  // landscape width ≥768px), the sidebar reverts to its static rail and the
  // scrim hides — so force-close, otherwise the body scroll-lock would strand
  // the now-desktop page unscrollable with no visible dismiss.
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const onChange = () => { if (mq.matches) setOpen(false); };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Escape closes the drawer.
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
      {/* Scrim behind the sidebar drawer (z-40, under the sidebar's z-50).
          Mobile only — the sidebar is `md:static`, so this never shows on
          desktop. Fades in/out; when closed it's non-interactive. */}
      <div
        aria-hidden
        onClick={close}
        className={cn(
          "fixed inset-0 z-40 bg-slate-950/40 backdrop-blur-sm transition-opacity duration-300 md:hidden",
          open ? "opacity-100" : "pointer-events-none opacity-0"
        )}
      />
    </Ctx.Provider>
  );
}

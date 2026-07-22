"use client";

// Status icons for the global Sonner <Toaster>. Passed once via the `icons`
// prop in (main)/layout.tsx, so every existing toast.success/error/warning
// call site across the app picks these up automatically — no call sites
// needed to change. Each icon is a ring that drains over the toast's
// lifetime with a glyph that draws itself in on mount, styled from the
// app's own HSL tokens instead of new colors. See .dd-toast-* in globals.css.

function ToastRing({ colorVar }: { colorVar: string }) {
  return (
    <svg viewBox="0 0 26 26" className="dd-toast-ring" style={{ color: `hsl(var(${colorVar}))` }}>
      <circle cx="13" cy="13" r="11" className="dd-toast-ring-track" />
      <circle cx="13" cy="13" r="11" className="dd-toast-ring-progress" />
    </svg>
  );
}

export function ToastSuccessIcon() {
  return (
    <span className="dd-toast-icon" aria-hidden>
      <ToastRing colorVar="--ok" />
      <svg viewBox="0 0 16 16" className="dd-toast-glyph" style={{ color: "hsl(var(--ok))" }}>
        <path d="M3 8.5L6.5 12L13 4.5" />
      </svg>
    </span>
  );
}

export function ToastErrorIcon() {
  return (
    <span className="dd-toast-icon" aria-hidden>
      <ToastRing colorVar="--urgent" />
      <svg viewBox="0 0 16 16" className="dd-toast-glyph" style={{ color: "hsl(var(--urgent))" }}>
        <path d="M4 4L12 12" />
        <path d="M12 4L4 12" />
      </svg>
    </span>
  );
}

export function ToastWarningIcon() {
  return (
    <span className="dd-toast-icon" aria-hidden>
      <ToastRing colorVar="--warn" />
      <svg viewBox="0 0 16 16" className="dd-toast-glyph" style={{ color: "hsl(var(--warn))" }}>
        <path d="M8 3.5V9.5" />
        <circle cx="8" cy="12.5" r="1" className="dd-toast-dot" />
      </svg>
    </span>
  );
}

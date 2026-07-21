import "./globals.css";
import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "Scaled Operations",
  description: "Intelligent task management & delegation for digital agencies."
};

// Explicit mobile viewport. `width=device-width, initial-scale=1` is what Next
// injects by default, but we pin it so the app renders at device width in
// portrait. Deliberately NO `maximumScale`/`userScalable` — disabling pinch-zoom
// is a WCAG 1.4.4 failure; iOS input auto-zoom is handled in globals.css instead.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1
};

// Minimal root: shared html/body for both the main app and the /widget route.
// Chrome (sidebar/topbar) lives in (main)/layout.tsx so /widget can render bare.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="text-ink antialiased" suppressHydrationWarning>{children}</body>
    </html>
  );
}

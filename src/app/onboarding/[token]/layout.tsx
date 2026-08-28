import type { Metadata } from "next";
import { Toaster } from "sonner";

export const metadata: Metadata = {
  title: "Onboarding · Scaled AI",
  // Nobody should be able to search their way into a client's form, and no
  // preview of one should end up in a link unfurl.
  robots: { index: false, follow: false }
};

// The onboarding form's own shell.
//
// Top-level, outside the (main) route group, so it inherits none of the app
// chrome — no sidebar, no topbar, no "signed in as". The person filling this in
// is the client's practice manager or web developer, and showing them the
// furniture of an internal tool would be confusing at best.
//
// It paints its own background, and that is load-bearing rather than
// decorative: globals.css sets `html, body { background: transparent }` so the
// Electron widget can float, and the light app surface is painted by .app-shell
// inside (main)/layout.tsx. A layout out here that painted nothing would render
// the form on a transparent canvas — which is exactly why /widget ships its own
// style block too.
export default function OnboardingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-bg text-ink">
      {children}
      <Toaster position="top-center" richColors />
    </div>
  );
}

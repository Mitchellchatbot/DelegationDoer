import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "DelegationDoer",
  description: "Intelligent task management & delegation for digital agencies."
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

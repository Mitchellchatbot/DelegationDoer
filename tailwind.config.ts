import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Bright SaaS palette. Off-white page, pure white cards, slate text,
        // vivid blue accent.
        bg: "#F8FAFC",
        surface: "#FFFFFF",
        surface2: "#F1F5F9",
        border: "#E2E8F0",
        ink: "#0F172A",
        muted: "#64748B",
        accent: "#063270",
        warn: "#D97706",
        urgent: "#DC2626",
        ok: "#16A34A",
        stalled: "#CA8A04"
      },
      fontFamily: {
        // Poppins is loaded via @import in globals.css. Keep the system-font
        // fallback so prerender / no-network states still look right.
        sans: ["Poppins", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"]
      },
      borderRadius: { xl: "12px", "2xl": "16px" },
      boxShadow: {
        soft: "0 1px 2px rgba(15,23,42,0.04), 0 4px 12px -6px rgba(15,23,42,0.08)",
        lift: "0 2px 4px rgba(15,23,42,0.06), 0 12px 28px -10px rgba(6,50,112,0.22)"
      }
    }
  },
  plugins: []
};

export default config;

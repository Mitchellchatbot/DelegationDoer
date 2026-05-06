import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Friendly light palette. Warm cream page, pure white cards, warm
        // earth tones for accents — pulls from the icon's #F5EFE3 background.
        bg: "#FAF6EF",
        surface: "#FFFFFF",
        surface2: "#F4EBDA",
        border: "#E5DBC4",
        ink: "#2A2622",
        muted: "#857662",
        accent: "#4D7BD9",
        warn: "#C28344",
        urgent: "#C8504A",
        ok: "#5BA45F",
        stalled: "#D89A4A"
      },
      fontFamily: {
        sans: ["ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"]
      },
      borderRadius: { xl: "12px", "2xl": "16px" },
      boxShadow: {
        // Subtle warm-tinted shadow for elevated cards.
        soft: "0 1px 2px rgba(60,40,20,0.05), 0 4px 12px -6px rgba(60,40,20,0.08)",
        lift: "0 2px 4px rgba(60,40,20,0.06), 0 12px 28px -10px rgba(60,40,20,0.18)"
      }
    }
  },
  plugins: []
};

export default config;

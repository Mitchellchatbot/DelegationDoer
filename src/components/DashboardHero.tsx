"use client";

import { useEffect, useRef, useState } from "react";
import gsap from "gsap";

// Big friendly greeting block. Time-aware (good morning/afternoon/evening),
// with a soft animated gradient background and a floating emoji.
// Animations: GSAP timelines for orb drift + emoji bob; CSS handles the
// underlying gradient.

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return { text: "Good morning", emoji: "☀️" };
  if (h < 18) return { text: "Good afternoon", emoji: "🌤" };
  return { text: "Good evening", emoji: "🌙" };
}

export function DashboardHero({
  firstName, subtitle
}: { firstName: string; subtitle: string }) {
  const [g, setG] = useState({ text: "Hello", emoji: "👋" });
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => setG(greeting()), []);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const ctx = gsap.context(() => {
      // Entry
      gsap.from(root, {
        y: 8,
        opacity: 0,
        duration: 0.55,
        ease: "power3.out"
      });
      // Drifting orbs
      gsap.to(root.querySelector("[data-orb-a]"), {
        x: 12, y: -10, duration: 6, repeat: -1, yoyo: true, ease: "sine.inOut"
      });
      gsap.to(root.querySelector("[data-orb-b]"), {
        x: -10, y: 8, duration: 7, repeat: -1, yoyo: true, ease: "sine.inOut", delay: 1
      });
      // Emoji bob + wobble
      const emoji = root.querySelector("[data-emoji]");
      if (emoji) {
        gsap.to(emoji, {
          y: -4, duration: 1.6, repeat: -1, yoyo: true, ease: "sine.inOut"
        });
        gsap.to(emoji, {
          rotate: 8, duration: 2.2, repeat: -1, yoyo: true, ease: "sine.inOut"
        });
      }
    }, root);
    return () => ctx.revert();
  }, [g.emoji]);

  return (
    <div
      ref={containerRef}
      className="relative overflow-hidden rounded-2xl border border-border shadow-soft p-6"
      style={{
        background:
          "linear-gradient(120deg, #DBEAFE 0%, #C7D2FE 35%, #DDD6FE 70%, #E9D5FF 100%)"
      }}
    >
      {/* drifting gradient orbs */}
      <div
        data-orb-a
        aria-hidden
        className="absolute -top-12 -right-10 w-56 h-56 rounded-full"
        style={{ background: "radial-gradient(circle, rgba(99,102,241,0.28), transparent 70%)" }}
      />
      <div
        data-orb-b
        aria-hidden
        className="absolute -bottom-10 -left-10 w-48 h-48 rounded-full"
        style={{ background: "radial-gradient(circle, rgba(167,139,250,0.30), transparent 70%)" }}
      />

      <div className="relative flex items-center gap-3">
        <span data-emoji className="text-3xl inline-block">
          {g.emoji}
        </span>
        <div>
          <h1 className="text-2xl font-semibold text-ink">
            {g.text}, {firstName}.
          </h1>
          <p className="text-sm text-ink/60 mt-1">{subtitle}</p>
        </div>
      </div>
    </div>
  );
}

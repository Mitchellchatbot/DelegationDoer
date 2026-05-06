"use client";

import { useEffect, useRef, useState } from "react";

const STORAGE_KEY = "dd:raise-count:v3";

// Easter egg. Renders as nearly-invisible text by default; brightens on hover.
// Click increments a counter persisted to localStorage and shows a tiny
// confirmation that fades out.
export function RaiseLink() {
  const [count, setCount] = useState(0);
  const [pop, setPop] = useState(false);
  // Track the active fade-out timer so rapid clicks restart it instead of
  // letting an old timeout hide the popup early.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    try { setCount(Number(localStorage.getItem(STORAGE_KEY) ?? 0)); } catch {}
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, []);

  function approve() {
    const next = count + 1;
    setCount(next);
    try { localStorage.setItem(STORAGE_KEY, String(next)); } catch {}
    setPop(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setPop(false), 2500);
  }

  // Escalating absurdity. Highest threshold the count clears wins.
  const TIERS: { at: number; text: string }[] = [
    { at: 1,   text: "approved" },
    { at: 3,   text: "noted" },
    { at: 5,   text: "ok this is getting suspicious" },
    { at: 8,   text: "HR has questions" },
    { at: 10,  text: "the dev is now upper-middle-class" },
    { at: 15,  text: "the developer has bought your company" },
    { at: 20,  text: "you now report to the developer" },
    { at: 25,  text: "the developer has acquired your competitors" },
    { at: 35,  text: "the developer is on the cover of Forbes" },
    { at: 50,  text: "the developer named a yacht after this button" },
    { at: 75,  text: "the developer has achieved escape velocity" },
    { at: 100, text: "transmission from the developer's space station: 'thx'" },
    { at: 150, text: "the developer is now a country" },
    { at: 250, text: "you've ascended. there is only the developer." }
  ];
  const flavor = [...TIERS].reverse().find((t) => count >= t.at)?.text ?? "";

  return (
    <button
      onClick={approve}
      title="A small kindness."
      aria-label="Give the developer a raise"
      className="group block w-full text-left text-[12px] tracking-tight text-muted/60 hover:text-warn transition-colors leading-tight"
    >
      <span className="opacity-80 group-hover:opacity-100 transition-opacity">give the developer a raise</span>
      {count > 0 && (
        <span className="opacity-0 group-hover:opacity-100 transition-opacity"> · ×{count}</span>
      )}
      {pop && (
        <span className="ml-1 text-warn animate-pulse">✦ {flavor}</span>
      )}
    </button>
  );
}

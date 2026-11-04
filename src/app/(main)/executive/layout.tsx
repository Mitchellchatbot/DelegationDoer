import type { ReactNode } from "react";

// The owner-only segment's layout: a plain width wrapper and nothing else.
// A layout is sent to the browser before its page runs, and it isn't re-run
// when he moves between sibling pages, so it can't be the gate and must not
// show anything a teammate could read. Every page here checks who is asking
// first and renders its own header after that check.
//
// force-dynamic: rendered per request, never prerendered, and the supabase-js
// reads underneath stay out of Next's data cache.
export const dynamic = "force-dynamic";

export default function OwnerSegmentLayout({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-7xl text-slate-900">{children}</div>;
}

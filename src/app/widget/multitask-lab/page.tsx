import { notFound } from "next/navigation";
import { MultitaskBubbles } from "@/components/multitask/MultitaskBubbles";

/**
 * Dev-only sandbox for the multitask bubbles.
 *
 * It lives under /widget because that prefix is already public in
 * middleware.ts, which lets the physics be exercised without a Supabase
 * session. 404s in production so it never ships as a real route.
 */
export default function MultitaskLabPage() {
  if (process.env.NODE_ENV === "production") notFound();

  return (
    <div className="app-shell relative min-h-screen p-8">
      <div className="max-w-lg space-y-2">
        <h1 className="text-lg font-semibold text-ink">Multitask bubbles — lab</h1>
        <p className="text-[13px] leading-relaxed text-muted">
          Press <kbd className="rounded bg-surface2 px-1.5 py-0.5 text-[11px]">⌥M</kbd>{" "}
          to summon the stack. Drag it around, fling it at an edge, drop it on the
          dismiss target, or tap it to expand.
        </p>
      </div>
      <MultitaskBubbles />
    </div>
  );
}

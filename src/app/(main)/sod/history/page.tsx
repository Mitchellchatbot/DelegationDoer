"use client";

import { SodHistoryView } from "@/components/SodHistoryView";

// Standalone route — renders the full SOD history view with its page
// hero. The same view is mounted (embedded) in the leader console's
// "Day reports" tab; see src/components/SodHistoryView.tsx.
export default function SodHistoryPage() {
  return <SodHistoryView />;
}

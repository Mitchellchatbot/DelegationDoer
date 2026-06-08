"use client";

import { EodHistoryView } from "@/components/EodHistoryView";

// Standalone route — renders the full EOD history view with its page
// hero. The same view is mounted (embedded) in the leader console's
// "Day reports" tab; see src/components/EodHistoryView.tsx.
export default function EodHistoryPage() {
  return <EodHistoryView />;
}

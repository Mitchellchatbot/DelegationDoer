import type { TaskMedia } from "@/lib/types";

// Shared client-side helpers for the "Analyze attachment with AI" feature.
// Both the browser New-task form (NewTaskForm) and the Electron widget's
// CreateTaskView call the same POST /api/tasks/analyze-attachment endpoint
// and apply the result the same way, so the image detection, request
// plumbing, response shape, and the user-facing notice text all live here
// instead of being duplicated per surface. Field application stays in each
// form (the available setters / permission gates differ per surface).

// The fields the endpoint extracts from the image. Everything is nullable —
// the endpoint returns null for anything it can't read confidently, and the
// caller only applies what's present.
export interface AnalyzedTaskFields {
  title?: string | null;
  description?: string | null;
  department?: string | null;
  priority?: string | null;
  estimatedHours?: number | null;
  tags?: string[] | null;
  clientName?: string | null;
  website?: string | null;
}

export interface AnalyzeAttachmentResult {
  fields: AnalyzedTaskFields;
  // True when the image was ambiguous/unreadable or a suggested value had to
  // be dropped (e.g. a department outside the worker's team) — the caller
  // surfaces a "please review" notice in that case.
  needsReview: boolean;
  notes: string | null;
}

// The first image attachment, if any — what "Analyze attachment with AI"
// reads. We bucket by content-type with a filename-extension fallback
// (matches MediaPicker's own categorize()), since clipboard/drag sources
// sometimes ship no content-type.
export function findFirstImage(media: TaskMedia[]): TaskMedia | null {
  return (
    media.find((m) =>
      (m.contentType ?? "").toLowerCase().startsWith("image/") ||
      /\.(png|jpe?g|gif|webp)$/i.test(m.name ?? m.url)
    ) ?? null
  );
}

// POST the (already-uploaded) attachment to the shared analyze endpoint and
// return the validated fields. Throws an Error carrying the server's message
// on a non-OK response so callers can handle both that and a network failure
// in a single catch.
export async function requestAttachmentAnalysis(image: TaskMedia): Promise<AnalyzeAttachmentResult> {
  const res = await fetch("/api/tasks/analyze-attachment", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageUrl: image.url, contentType: image.contentType })
  });
  const data = await res.json().catch(() => ({} as Record<string, unknown>));
  if (!res.ok) {
    throw new Error((data as { error?: string })?.error ?? `Failed (${res.status})`);
  }
  return {
    fields: ((data as { fields?: AnalyzedTaskFields }).fields ?? {}) as AnalyzedTaskFields,
    needsReview: (data as { needsReview?: unknown }).needsReview === true,
    notes: typeof (data as { notes?: unknown }).notes === "string" ? (data as { notes: string }).notes : null
  };
}

// Build the post-run notice ("filled X / needs review / nothing new"), given
// which fields actually landed on the form. Identical copy across surfaces.
export function buildAnalyzeNotice(filled: string[], result: AnalyzeAttachmentResult): string {
  const notesSuffix = result.notes ? ` ${result.notes}` : "";
  if (result.needsReview) {
    return (
      (filled.length > 0
        ? `Filled ${filled.join(", ")} from the image — please review before creating.`
        : "AI couldn't confidently read this image — fill the form in manually.") + notesSuffix
    );
  }
  if (filled.length > 0) {
    return `Filled ${filled.join(", ")} from the image — review, then create.${notesSuffix}`;
  }
  return `Nothing new to fill — the form already has those fields.${notesSuffix}`;
}

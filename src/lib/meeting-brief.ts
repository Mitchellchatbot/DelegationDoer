// Team-brief shaping. The meeting classifier (meeting-classifier.ts)
// extracts the raw brief fields from a transcript; this module turns a
// ClassifiedMeeting into the canonical `MeetingBrief` record we persist
// in client_meetings.brief (jsonb) and hand to the Ask-AI tool.
//
// Kept separate from the classifier so the storage shape can evolve
// without touching the prompt, and so the client page + AI tool share
// one definition of "what a team brief contains".

import type { ClassifiedMeeting } from "@/lib/meeting-classifier";

// The five sections every team brief carries. `actionItems` here is the
// list of action-item TITLES the meeting produced (the digest view) —
// the actual draft tasks they spawned are tracked separately in
// client_meetings.task_ids so the timeline can deep-link to the work.
export interface MeetingBrief {
  keyDecisions: string[];
  actionItems: string[];
  clientRequests: string[];
  risks: string[];
  nextSteps: string[];
}

export function buildMeetingBrief(classified: ClassifiedMeeting): MeetingBrief {
  return {
    keyDecisions: classified.keyDecisions,
    actionItems: classified.actionItems.map((i) => i.title),
    clientRequests: classified.clientRequests,
    risks: classified.risks,
    nextSteps: classified.nextSteps
  };
}

// True when the brief has at least one populated section — used to decide
// whether a meeting is worth storing/surfacing at all.
export function briefHasContent(brief: MeetingBrief): boolean {
  return (
    brief.keyDecisions.length > 0 ||
    brief.actionItems.length > 0 ||
    brief.clientRequests.length > 0 ||
    brief.risks.length > 0 ||
    brief.nextSteps.length > 0
  );
}

// Defensive coercion of a jsonb value read back from the DB into a
// MeetingBrief. Legacy/null rows degrade to empty sections rather than
// throwing on the client page or in the AI tool.
export function coerceMeetingBrief(value: unknown): MeetingBrief {
  const v = (value ?? {}) as Partial<Record<keyof MeetingBrief, unknown>>;
  const arr = (x: unknown): string[] =>
    Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : [];
  return {
    keyDecisions: arr(v.keyDecisions),
    actionItems: arr(v.actionItems),
    clientRequests: arr(v.clientRequests),
    risks: arr(v.risks),
    nextSteps: arr(v.nextSteps)
  };
}

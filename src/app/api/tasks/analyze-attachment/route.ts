import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById, getDepartments } from "@/lib/server-data";
import { isLeader, canCreateTaskInDepartment } from "@/lib/access";
import { getAnthropic, resetAnthropic, MODELS } from "@/lib/anthropic-client";
import { TAG_PRESETS } from "@/lib/mock-data";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/tasks/analyze-attachment
//   Reads an uploaded image (a screenshot / photo the user attached on the
//   New-task form via /api/upload) with Claude vision and extracts the
//   structured task fields the form would otherwise be typed by hand:
//   title, description, department, priority, estimate, tags, client, website.
//
//   Returns the extracted fields to the frontend, which POPULATES the form —
//   it never creates the task. The user still reviews + clicks "Create task",
//   and POST /api/tasks re-validates everything server-side.
//
//   Permissions: gated on requireCurrentUserId (so anonymous traffic can't
//   drain the Anthropic budget), and the suggested department is clamped to
//   what the caller is actually allowed to create in (canCreateTaskInDepartment)
//   — a worker's screenshot can't pre-fill another team's department. The
//   suggested assignee is intentionally NOT guessed here: the form's existing
//   skill/capacity ranker (rankCandidates, scoped to assignableTargets) is the
//   single source of truth for that and recomputes once these fields land.

// Anthropic vision accepts these base64 media types. We normalise the
// uploaded file's content-type into one of them and reject anything else
// (svg / heic / pdf / non-image) with a clear message.
const SUPPORTED_MEDIA: Record<string, "image/jpeg" | "image/png" | "image/gif" | "image/webp"> = {
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/png": "image/png",
  "image/gif": "image/gif",
  "image/webp": "image/webp"
};

// Claude vision caps base64 images at ~5 MB. Screenshots are well under
// this; anything larger we bounce with a friendly message rather than
// letting the upstream call fail opaquely.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function isAnthropicAuthError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { status?: number }).status === 401
  );
}

function mediaTypeFor(raw: string | null | undefined): "image/jpeg" | "image/png" | "image/gif" | "image/webp" | null {
  if (!raw) return null;
  const key = raw.split(";")[0].trim().toLowerCase();
  return SUPPORTED_MEDIA[key] ?? null;
}

export async function POST(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const caller = await getUserById(userId);
    const privileged = isLeader(caller);

    const body = await req.json().catch(() => ({}));
    const imageUrl = typeof body.imageUrl === "string" ? body.imageUrl.trim() : "";
    if (!imageUrl) {
      return NextResponse.json({ error: "imageUrl is required" }, { status: 400 });
    }

    // Fetch the attachment bytes server-side (the URL is a public Supabase
    // Storage object the client just uploaded). We base64 it ourselves
    // rather than handing Anthropic the URL so analysis doesn't depend on
    // our bucket being reachable from Anthropic's side.
    let imgRes: Response;
    try {
      imgRes = await fetch(imageUrl);
    } catch {
      return NextResponse.json({ error: "Couldn't fetch the attachment to analyze." }, { status: 502 });
    }
    if (!imgRes.ok) {
      return NextResponse.json({ error: `Couldn't fetch the attachment (status ${imgRes.status}).` }, { status: 502 });
    }

    const mediaType = mediaTypeFor(typeof body.contentType === "string" ? body.contentType : imgRes.headers.get("content-type"));
    if (!mediaType) {
      return NextResponse.json(
        { error: "Only image attachments (PNG, JPG, GIF, WebP) can be analyzed with AI." },
        { status: 400 }
      );
    }

    const bytes = Buffer.from(await imgRes.arrayBuffer());
    if (bytes.byteLength === 0) {
      return NextResponse.json({ error: "The attachment is empty." }, { status: 400 });
    }
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      return NextResponse.json(
        { error: `Image too large to analyze — max ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB. Try a smaller screenshot.` },
        { status: 400 }
      );
    }
    const base64 = bytes.toString("base64");

    const departments = await getDepartments();
    const deptList = departments.map((d) =>
      `- ${d.name} (id: "${d.id}"): ${d.description}; covers ${d.taskTypes.join(", ")}`
    ).join("\n");

    const systemPrompt = `You read a screenshot or photo a teammate at a digital agency attached while creating a task (e.g. a client email screenshot, a chat message, a bug screenshot, a design comment, a sticky-note photo) and extract the fields needed to file that task.

Extract ONLY what is clearly supported by the image. If a field isn't determinable from the image, return null for it (or [] for tags) — DO NOT guess. It's better to leave a field blank than to invent it.

Departments (pick the single best fit, by id):
${deptList || "(none configured)"}

Allowed tags (use only these; pick the ones that genuinely apply, or []):
${TAG_PRESETS.join(", ")}

Return STRICT JSON in exactly this shape — no preamble, no code fences:
{
  "title": "<short, action-y task title starting with a verb (<70 chars), or null>",
  "description": "<Markdown summary of what needs to happen and any context/links/names/deadlines visible in the image, or null>",
  "department": "<one of the dept ids above, or null if unclear>",
  "priority": "<low | medium | high | critical, or null>",
  "estimatedHours": <number of hours as a rough estimate, or null>,
  "tags": ["<zero or more of the allowed tags above>"],
  "clientName": "<the client / company name if one is identifiable, or null>",
  "website": "<a website/domain if one is visible, or null>",
  "needsReview": <true if the image is ambiguous, unreadable, or doesn't clearly describe a task, false otherwise>,
  "notes": "<one short sentence on anything the user should double-check, or null>"
}

Priority: "critical" = explicit emergency (site down, legal, billing broken); "high" = same-day / client blocked; "medium" = normal work; "low" = FYI / nice-to-have. If the image gives no urgency signal, return null (the form keeps its default).
Title must read like a task ("Fix broken contact form on Acme site"), not a description of the image ("Screenshot of an email").
If the image clearly isn't a task at all (random photo, meme, unrelated), set needsReview=true and leave the content fields null.`;

    const createParams = {
      // Sonnet for higher-fidelity reading of dense screenshots (email
      // threads, bug reports, design comments) vs the Haiku used for the
      // text-only classifiers. Vision quality matters more than cost here
      // since it's a one-shot, user-initiated action.
      model: MODELS.chat,
      max_tokens: 900,
      system: systemPrompt,
      messages: [{
        role: "user" as const,
        content: [
          {
            type: "image" as const,
            source: { type: "base64" as const, media_type: mediaType, data: base64 }
          },
          {
            type: "text" as const,
            text: "Extract the task fields from this attachment as strict JSON per the schema."
          }
        ]
      }]
    };

    // Self-heal a stale cached Anthropic key on a 401 (same pattern as the
    // email classifier): drop the cached key+client and retry once. Other
    // errors (429 / 404 / network) propagate to the outer catch.
    let result;
    try {
      result = await (await getAnthropic()).messages.create(createParams);
    } catch (err) {
      if (isAnthropicAuthError(err)) {
        console.warn("[analyze-attachment] 401 from Anthropic — resetting cached key and retrying once");
        resetAnthropic();
        result = await (await getAnthropic()).messages.create(createParams);
      } else {
        throw err;
      }
    }

    const text = result.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    const match = text.match(/\{[\s\S]*\}/);
    let parsed: Record<string, unknown> = {};
    if (match) {
      try { parsed = JSON.parse(match[0]); } catch { /* fall through to defaults */ }
    }

    // ---- Validate + coerce every field. Nothing the model returns is
    // trusted: out-of-range / unknown values become null so the frontend
    // only ever applies safe, in-shape data to the form. ----

    const title = typeof parsed.title === "string" && parsed.title.trim()
      ? parsed.title.trim().slice(0, 120)
      : null;

    const description = typeof parsed.description === "string" && parsed.description.trim()
      ? parsed.description.trim().slice(0, 4000)
      : null;

    const validPriorities = new Set(["low", "medium", "high", "critical"]);
    const priority = typeof parsed.priority === "string" && validPriorities.has(parsed.priority)
      ? parsed.priority
      : null;

    const estRaw = typeof parsed.estimatedHours === "number" ? parsed.estimatedHours : Number(parsed.estimatedHours);
    const estimatedHours = Number.isFinite(estRaw) && estRaw > 0 && estRaw <= 200
      ? Math.round(estRaw * 4) / 4 // snap to quarter-hours
      : null;

    // Tags: keep only known presets (the form renders preset toggles, so a
    // free-form tag wouldn't show as selected anyway), de-duped.
    const presetSet = new Set(TAG_PRESETS);
    const tags = Array.isArray(parsed.tags)
      ? Array.from(new Set(
          parsed.tags
            .map((t) => (typeof t === "string" ? t.trim().toLowerCase() : ""))
            .filter((t) => presetSet.has(t))
        )).slice(0, TAG_PRESETS.length)
      : [];

    // Department: must be a real department id. For non-leaders, clamp to
    // what they're allowed to create in — a worker's screenshot can't
    // pre-fill another team's department (the POST /api/tasks route would
    // reject it anyway; we just don't surface an un-pickable suggestion).
    let department: string | null =
      typeof parsed.department === "string" && departments.some((d) => d.id === parsed.department)
        ? parsed.department
        : null;
    let departmentBlocked = false;
    if (department && !privileged && !canCreateTaskInDepartment(caller, department)) {
      department = null;
      departmentBlocked = true;
    }

    const clientName = typeof parsed.clientName === "string" && parsed.clientName.trim()
      ? parsed.clientName.trim().slice(0, 120)
      : null;

    const website = typeof parsed.website === "string" && parsed.website.trim()
      ? parsed.website.trim().slice(0, 200)
      : null;

    // needsReview from the model, OR forced true when we couldn't extract
    // anything usable / we had to drop a department the worker can't use.
    const gotSomething = !!(title || description || priority || estimatedHours || tags.length || clientName || website || department);
    const needsReview = parsed.needsReview === true || !gotSomething || departmentBlocked;

    const notes = typeof parsed.notes === "string" && parsed.notes.trim()
      ? parsed.notes.trim().slice(0, 280)
      : departmentBlocked
        ? "The suggested department is outside your team, so it was left blank."
        : null;

    return NextResponse.json({
      fields: { title, description, department, priority, estimatedHours, tags, clientName, website },
      needsReview,
      notes
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

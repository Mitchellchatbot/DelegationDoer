import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getLinkByToken, recordFile } from "@/lib/client-onboarding";
import { getField } from "@/lib/client-onboarding-forms";

export const dynamic = "force-dynamic";

// POST /api/onboarding/[token]/upload — multipart: file, stepId, fieldKey
//
// The Website form's branding-materials upload, on the "Brand and design" step.
//
// This is the one UNAUTHENTICATED write path in the feature, so it is
// deliberately stricter than the app's own /api/upload — which allows any
// content type up to 150 MB on the reasoning that only signed-in employees can
// reach it. That reasoning does not hold here, so:
//
//   · 25 MB a file. Enough for a logo pack or a few photographs, nowhere near
//     enough to be worth using us as free storage.
//   · An allowlist of what a client could plausibly be sending: images, PDFs,
//     and a zip of the two. Not "anything without a script extension" — a
//     denylist on a public endpoint is a list of the attacks you thought of.
//   · Refused once the form is completed or the link revoked, so a leaked link
//     does not stay writable forever.
//
// Storage is the existing public ticket-attachments bucket, keyed under
// onboarding/<linkId>/. Public-read is what makes the file render in an <img>
// on the client page with no signing dance, and matches how every other
// attachment in DD is served.

const MAX_BYTES = 25 * 1024 * 1024;

// SVG is on this list on purpose, and it is the one entry worth justifying: an
// SVG can carry script, and this endpoint takes files from the open internet.
// It stays because a logo is the single most common thing a client sends and
// theirs is very often an SVG. What makes it acceptable is where the file ends
// up -- Supabase's storage domain, a different origin from the app, with no
// access to a DD session or cookie. Anyone opening one is executing it against
// Supabase's origin, not ours.
const ALLOWED = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/heic",
  "image/heif",
  "image/avif",
  "application/pdf",
  "application/zip",
  "application/x-zip-compressed",
  "application/postscript"
]);

export async function POST(req: NextRequest, { params }: { params: { token: string } }) {
  try {
    const link = await getLinkByToken(params.token);
    if (!link) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (link.completedAt) {
      return NextResponse.json({ error: "this form has already been submitted" }, { status: 409 });
    }

    const form = await req.formData();
    const file = form.get("file");
    const stepId = (form.get("stepId") as string | null) ?? "";
    const fieldKey = (form.get("fieldKey") as string | null) ?? "";

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "file required" }, { status: 400 });
    }

    // The field has to exist on THIS form and actually be a file field —
    // otherwise the endpoint is an open uploader that merely happens to be
    // reached through a form token.
    const field = getField(link.formKey, stepId, fieldKey);
    if (!field || field.kind !== "files") {
      return NextResponse.json({ error: "unknown upload field" }, { status: 400 });
    }

    if (file.size > MAX_BYTES) {
      return NextResponse.json(
        { error: `That file is too big — ${Math.round(MAX_BYTES / 1024 / 1024)} MB is the limit.` },
        { status: 400 }
      );
    }
    if (file.size === 0) {
      return NextResponse.json({ error: "That file is empty." }, { status: 400 });
    }

    const contentType = (file.type || "").toLowerCase();
    if (!ALLOWED.has(contentType)) {
      return NextResponse.json(
        { error: "We can take images, PDFs, or a zip of them. Send that file another way and we'll sort it." },
        { status: 400 }
      );
    }

    const safeName = file.name.replace(/[^a-z0-9._-]+/gi, "_").slice(0, 80) || "upload";
    const key = `onboarding/${link.id}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${safeName}`;
    const bytes = await file.arrayBuffer();

    const supabase = getSupabaseAdmin();
    const { error: uploadErr } = await supabase.storage
      .from("ticket-attachments")
      .upload(key, bytes, { contentType, upsert: false });
    if (uploadErr) return NextResponse.json({ error: uploadErr.message }, { status: 500 });

    const { data: pub } = supabase.storage.from("ticket-attachments").getPublicUrl(key);

    const saved = await recordFile({
      link,
      stepId,
      fieldKey,
      fileName: file.name.slice(0, 200),
      url: pub.publicUrl,
      storageKey: key,
      contentType,
      sizeBytes: file.size
    });

    return NextResponse.json({ file: saved });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

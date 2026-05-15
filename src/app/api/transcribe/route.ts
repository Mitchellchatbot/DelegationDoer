import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/transcribe
//   Accepts multipart/form-data with a single "file" field (audio blob
//   recorded by MediaRecorder in the browser). Proxies it to OpenAI's
//   gpt-4o-mini-transcribe and returns { text }.
//
//   Gated on requireCurrentUserId so anonymous traffic can't drain
//   the OPENAI_API_KEY budget.
export async function POST(req: NextRequest) {
  try {
    await requireCurrentUserId();
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "OPENAI_API_KEY not configured" },
        { status: 500 }
      );
    }

    const incoming = await req.formData();
    const file = incoming.get("file");
    if (!(file instanceof Blob)) {
      return NextResponse.json({ error: "file required" }, { status: 400 });
    }
    const filename = (file instanceof File && file.name) || "dictation.webm";

    const fd = new FormData();
    fd.append("file", file, filename);
    fd.append("model", "gpt-4o-mini-transcribe");
    fd.append("response_format", "json");

    const upstream = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: fd
    });
    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => "");
      return NextResponse.json(
        { error: `openai ${upstream.status}: ${detail.slice(0, 400)}` },
        { status: 502 }
      );
    }
    const data: { text?: string } = await upstream.json();
    return NextResponse.json({ text: typeof data.text === "string" ? data.text : "" });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}

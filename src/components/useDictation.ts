"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

// Click-to-start / click-to-stop dictation backed by OpenAI
// gpt-4o-mini-transcribe (via POST /api/transcribe). We record the mic
// with MediaRecorder, then POST the audio blob on stop and hand the
// returned text back through onTranscript.
//
// This is the same pipeline the AI assistant composer uses, extracted so
// the voice-task flow can reuse it without duplicating the MediaRecorder
// codec negotiation, permission-error handling, and transcribe plumbing.
//
// The OpenAI endpoint is request/response (not streaming), so there's a
// 1–2s "transcribing…" window between stop and the text arriving — surfaced
// via the `transcribing` flag so callers can show it.
export function useDictation({
  onTranscript,
  baselineValue
}: {
  // Called once per completed recording with the newly transcribed text
  // already spliced onto `baselineValue` (previous text + " " + new text).
  onTranscript: (next: string) => void;
  // The text already present when recording starts, so a second dictation
  // appends rather than replaces.
  baselineValue: string;
}) {
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [supported, setSupported] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const baselineRef = useRef<string>("");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const ok =
      !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";
    setSupported(ok);
    return () => {
      try { recorderRef.current?.stop(); } catch { /* */ }
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  async function start() {
    baselineRef.current = baselineValue;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      // Permission denied, extension intercept, no mic device, etc. Surface
      // the reason so users know why nothing happened.
      const name = err instanceof Error ? err.name : "";
      const msg =
        name === "NotAllowedError"
          ? "Microphone permission was denied. Allow it in the browser address bar (lock icon) and try again."
          : name === "NotFoundError"
            ? "No microphone detected on this device."
            : name === "NotReadableError"
              ? "Mic is busy — another app or browser extension (Scribe / Loom / etc.) might be using it. Close those and retry."
              : `Couldn't access mic: ${err instanceof Error ? err.message : "unknown"}`;
      // eslint-disable-next-line no-console
      console.warn("[mic] getUserMedia failed:", err);
      toast.error(msg);
      return;
    }
    streamRef.current = stream;
    // Chrome/Firefox produce webm/opus, Safari produces mp4/aac. Both are
    // accepted by the OpenAI transcription endpoint.
    const preferred = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : MediaRecorder.isTypeSupported("audio/mp4")
          ? "audio/mp4"
          : "";
    const rec = preferred
      ? new MediaRecorder(stream, { mimeType: preferred })
      : new MediaRecorder(stream);
    chunksRef.current = [];
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      const type = rec.mimeType || "audio/webm";
      const blob = new Blob(chunksRef.current, { type });
      chunksRef.current = [];
      void transcribe(blob, type);
    };
    recorderRef.current = rec;
    rec.start();
    setListening(true);
  }

  async function transcribe(blob: Blob, mime: string) {
    if (blob.size === 0) {
      toast.error("Mic captured no audio — try again and speak after the red pulse appears.");
      return;
    }
    setTranscribing(true);
    try {
      const ext = mime.includes("mp4") || mime.includes("m4a") ? "m4a"
        : mime.includes("ogg") ? "ogg"
        : mime.includes("wav") ? "wav"
        : "webm";
      const fd = new FormData();
      fd.append("file", blob, `dictation.${ext}`);
      const res = await fetch("/api/transcribe", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail = typeof data?.error === "string" ? data.error : `HTTP ${res.status}`;
        // eslint-disable-next-line no-console
        console.warn("[mic] /api/transcribe failed:", detail);
        toast.error(`Transcription failed: ${detail}`);
        return;
      }
      const text = typeof data.text === "string" ? data.text.trim() : "";
      if (!text) {
        toast.error("Transcription came back empty — try a longer recording or speak more clearly.");
        return;
      }
      const base = baselineRef.current;
      const joined = base
        ? base + (base.endsWith(" ") || base.endsWith("\n") ? "" : " ") + text
        : text;
      onTranscript(joined);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[mic] /api/transcribe threw:", err);
      toast.error(`Transcription network error: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setTranscribing(false);
    }
  }

  function stop() {
    const rec = recorderRef.current;
    if (!rec) return;
    try { rec.stop(); } catch { /* */ }
    recorderRef.current = null;
    setListening(false);
  }

  function toggle() {
    if (transcribing) return;
    if (listening) stop();
    else void start();
  }

  return { supported, listening, transcribing, toggle };
}

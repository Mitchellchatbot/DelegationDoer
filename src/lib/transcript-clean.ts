// Loom (and most caption tools) export transcripts as WebVTT: a `WEBVTT`
// header, blank-line-separated cues, numeric cue identifiers,
// `00:00:00.000 --> 00:00:05.000` timing lines, and inline tags like
// <v Speaker> / <c>. Feeding that raw into the SOP embedder pollutes the
// vectors and the text Ask AI reads back with timecodes and markup.
//
// cleanTranscript() strips that structure down to readable prose while
// KEEPING the spoken words and any <v> speaker name. It is deliberately
// conservative and IDEMPOTENT: plain prose (no WEBVTT header, no `-->`,
// no bare-timecode lines) passes through essentially unchanged, and
// running it on its own output is a no-op — so it is safe to call on the
// client (on file load) AND the server (before chunking) with no divergence.
//
// The `Speaker: text` shape below deliberately mirrors joinWithSpeakers in
// tldv-client.ts (which does the same for structured tl;dv segments).

const BARE_TIMECODE_LINE = /^(?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?$/; // 0:00 | 00:01:23 | 00:00:05.000
const CUE_TIMING = /-->/;                             // cue timing line (settings may trail)
const CUE_NUMBER = /^\d+$/;                           // SRT/VTT numeric cue id (VTT/SRT mode only)
const VOICE_TAG = /^<v(?:\.[^\s>]*)?\s+([^>]+)>\s*/i; // <v Name> / <v.class Name> (one optional class group — no nested-quantifier backtracking)
const ANY_TAG = /<\/?[^>]+>/g;                        // <c>, </c>, <i>, <00:00:00.000>, …
const WEBVTT_HEADER = /^WEBVTT\b/;                    // WEBVTT signature (BOM stripped first)

export function cleanTranscript(raw: string): string {
  if (!raw) return "";
  // Drop a leading UTF-8 BOM (0xFEFF) up front so the WEBVTT/first-cue
  // checks don't have to account for it. Kept as a code-point check to
  // avoid an invisible BOM literal in this source file.
  const src = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;

  // Only apply the aggressive structural stripping when the input actually
  // looks like VTT/SRT, so plain prose is left alone.
  const looksLikeVtt = CUE_TIMING.test(src) || WEBVTT_HEADER.test(src);

  const out: string[] = [];
  let skippingBlock = false; // inside a NOTE/STYLE/REGION metadata block
  let lastContent = "";      // last non-blank line kept (for dupe collapsing across cues)

  for (const line of src.replace(/\r\n?/g, "\n").split("\n")) {
    const trimmed = line.trim();

    if (looksLikeVtt) {
      if (skippingBlock) { if (!trimmed) skippingBlock = false; continue; }
      if (/^(NOTE|STYLE|REGION)\b/.test(trimmed)) { skippingBlock = true; continue; }
      if (WEBVTT_HEADER.test(trimmed)) continue;
      if (CUE_TIMING.test(trimmed)) continue;
      if (CUE_NUMBER.test(trimmed)) continue;
    }

    if (BARE_TIMECODE_LINE.test(trimmed)) continue; // safe in both modes (Loom .txt too)

    // Pull the speaker out of a leading <v …> tag, then strip all tags.
    let speaker = "";
    let text = trimmed;
    const v = text.match(VOICE_TAG);
    if (v) { speaker = v[1].trim(); text = text.slice(v[0].length); }
    text = text.replace(ANY_TAG, "").trim();

    if (!text) { out.push(""); continue; }        // keep blank = paragraph break for chunkText
    const finalLine = speaker ? `${speaker}: ${text}` : text;
    // Drop a caption identical to the previous one — rolling auto-captions
    // repeat the same line across consecutive cues (blank-separated), so we
    // compare against the last kept content, not just the adjacent slot.
    if (finalLine === lastContent) continue;
    lastContent = finalLine;
    out.push(finalLine);
  }

  // Single blanks preserve cue boundaries as paragraphs (chunkText splits on
  // blank lines); collapse the larger gaps left by removed header/number rows.
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

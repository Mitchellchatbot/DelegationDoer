// SOP ingestion pipeline:
//   bytes + mime  →  extracted text  →  chunks  →  OpenAI embeddings
//
// Three input shapes are supported in v1:
//   * application/pdf → pdf-parse for text. If the text is sparse
//     (<500 chars) we flag the SOP with a warning so the uploader
//     knows the result will be thin; image-heavy PDFs should be
//     exported as PNG/JPG pages instead until we add page-rasterizing.
//   * Word docs (.docx) → mammoth.
//   * image/png|jpeg|webp → straight to gpt-4o-mini vision, which
//     produces a detailed caption that's then used as the chunk text
//     (and the chunk carries the source image URL so chatbot answers
//     can surface the original picture).
//
// Chunking is intentionally simple: split on paragraphs, then pack
// into ~CHUNK_TARGET_TOKENS pieces by char/4 ≈ token estimate. This
// is good enough for retrieval quality at the scale we're at;
// upgrade to tiktoken when it actually matters.

import { cleanTranscript } from "./transcript-clean";

const CHUNK_TARGET_TOKENS = 500;
const CHUNK_TARGET_CHARS = CHUNK_TARGET_TOKENS * 4;
const SPARSE_TEXT_THRESHOLD = 500; // chars

export interface SopChunk {
  content: string;
  embedding: number[];
  tokenCount: number;
  imageUrl: string | null;
}

export interface IngestResult {
  chunks: SopChunk[];
  warnings: string;
}

// --------------------------- entry point ---------------------------

export async function ingestSopFile(args: {
  bytes: Buffer;
  mimeType: string;
  filename: string;
  fileUrl: string;
}): Promise<IngestResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured");

  const { bytes, mimeType, filename, fileUrl } = args;
  const warnings: string[] = [];

  // 1. Extract text (or caption) according to type.
  let text = "";
  let imageUrl: string | null = null;
  if (mimeType === "application/pdf") {
    text = await extractPdfText(bytes);
    if (text.trim().length < SPARSE_TEXT_THRESHOLD) {
      warnings.push(
        "PDF text extraction was sparse — looks like an image-heavy doc. " +
        "Consider exporting each page as a PNG/JPG and re-uploading; the chatbot " +
        "will index the visual content properly that way."
      );
    }
  } else if (
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    filename.toLowerCase().endsWith(".docx")
  ) {
    text = await extractDocxText(bytes);
  } else if (mimeType.startsWith("image/")) {
    text = await captionImage({ bytes, mimeType, apiKey });
    imageUrl = fileUrl;
  } else {
    throw new Error(`unsupported mime type: ${mimeType}`);
  }

  text = text.trim();
  if (!text) {
    return { chunks: [], warnings: warnings.concat("No text could be extracted.").join(" ") };
  }

  // 2. Chunk the text.
  const rawChunks = chunkText(text, CHUNK_TARGET_CHARS);

  // 3. Embed each chunk in parallel (cheap enough that we don't
  //    need to throttle — text-embedding-3-small is ~$0.02/M tokens).
  const embeddings = await embedBatch({
    texts: rawChunks,
    apiKey
  });

  const chunks: SopChunk[] = rawChunks.map((content, i) => ({
    content,
    embedding: embeddings[i],
    tokenCount: Math.ceil(content.length / 4),
    imageUrl: imageUrl // every chunk from a single image references that image
  }));

  return { chunks, warnings: warnings.join(" ") };
}

// --------------------------- extractors ----------------------------

async function extractPdfText(bytes: Buffer): Promise<string> {
  // pdf-parse v2 exposes a class-based API (the v1 single-function
  // form is gone). Next.js's serverComponentsExternalPackages keeps
  // pdf-parse + its pdfjs-dist dependency out of the webpack bundle
  // so they load via Node's normal resolver at runtime.
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(bytes) });
  try {
    const result = await parser.getText();
    return typeof result?.text === "string" ? result.text : "";
  } finally {
    await parser.destroy().catch(() => {});
  }
}

async function extractDocxText(bytes: Buffer): Promise<string> {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ buffer: bytes });
  return result.value || "";
}

async function captionImage(args: {
  apiKey: string;
  // Caption either from raw bytes (image-file SOP uploads) or from an
  // already-hosted public URL (Loom screenshots uploaded to Storage
  // before ingest). OpenAI's image_url.url accepts a public URL or a
  // data: URL interchangeably.
  bytes?: Buffer;
  mimeType?: string;
  imageUrl?: string;
}): Promise<string> {
  const url = args.imageUrl
    ?? `data:${args.mimeType};base64,${args.bytes!.toString("base64")}`;
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are indexing internal SOP (Standard Operating Procedure) images so they can be retrieved by a chatbot. Describe the image with the detail a new hire would need to follow it: every visible UI element, button label, menu, step number, callout, arrow, and any text. If it's a diagram, describe the flow. If it's a screenshot, describe what tool / app / page it's from. Output a single dense paragraph, no headings."
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this SOP image in detail." },
            { type: "image_url", image_url: { url } }
          ]
        }
      ],
      max_tokens: 800,
      temperature: 0
    })
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`vision captioning failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  const data: { choices?: Array<{ message?: { content?: string } }> } = await res.json();
  const text = data.choices?.[0]?.message?.content ?? "";
  return text.trim();
}

// ---------------------------- chunking -----------------------------

// Pack paragraphs greedily into chunks of roughly CHUNK_TARGET_CHARS.
// If a single paragraph is larger than the target, split it on
// sentence boundaries so a 10K-word section doesn't end up as one
// monolithic chunk (which would dilute retrieval relevance).
function chunkText(text: string, targetChars: number): string[] {
  const paragraphs = text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if (paragraph.length > targetChars) {
      if (current) { chunks.push(current); current = ""; }
      for (const piece of splitOnSentences(paragraph, targetChars)) chunks.push(piece);
      continue;
    }
    if (!current) {
      current = paragraph;
    } else if (current.length + paragraph.length + 2 <= targetChars) {
      current += "\n\n" + paragraph;
    } else {
      chunks.push(current);
      current = paragraph;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function splitOnSentences(paragraph: string, targetChars: number): string[] {
  const sentences = paragraph.split(/(?<=[.!?])\s+/);
  const out: string[] = [];
  let current = "";
  for (const s of sentences) {
    if (!current) {
      current = s;
    } else if (current.length + s.length + 1 <= targetChars) {
      current += " " + s;
    } else {
      out.push(current);
      current = s;
    }
  }
  if (current) out.push(current);
  return out;
}

// ---------------------------- embeddings ---------------------------

async function embedBatch(args: {
  texts: string[];
  apiKey: string;
}): Promise<number[][]> {
  if (args.texts.length === 0) return [];
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: args.texts
    })
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`openai embeddings failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  const data: { data: Array<{ embedding: number[] }> } = await res.json();
  return data.data.map((row) => row.embedding);
}

// Used by the search_sops tool to embed a single query.
export async function embedQuery(query: string): Promise<number[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured");
  const results = await embedBatch({ texts: [query], apiKey });
  return results[0];
}

// --------------------------- Loom SOPs -----------------------------

// Ingest a Loom recording captured as a transcript + a set of
// screenshots the author grabbed from the video. Produces the same
// SopChunk shape as ingestSopFile so the existing search_sops tool and
// the Ask AI drawer surface the text + screenshots with no changes:
//   * transcript → ~500-token text chunks (imageUrl null)
//   * each screenshot → a vision caption chunk that carries the image
//     URL, so answers can cite the picture inline via markdown.
// Screenshots are already uploaded to Storage by the caller, so we
// caption from their public URL rather than raw bytes.
export async function ingestLoomSop(args: {
  transcript: string;
  screenshots: { url: string; label?: string }[];
}): Promise<IngestResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured");

  const transcript = cleanTranscript(args.transcript);
  const screenshots = args.screenshots ?? [];
  const warnings: string[] = [];

  // 1. Transcript → text chunks (same greedy paragraph packing as docs).
  const textChunks = transcript ? chunkText(transcript, CHUNK_TARGET_CHARS) : [];
  if (!transcript) {
    warnings.push("No transcript provided — this SOP is indexed by its screenshots only.");
  }

  // 2. Each screenshot → a captioned chunk that keeps the image URL so
  //    the chatbot can show the picture, not just its caption. The
  //    optional author label is prepended so the frame is retrievable
  //    by the step name too (there are no per-frame timestamps to tie a
  //    frame to a transcript position, so the label is the anchor).
  const captions = await Promise.all(
    screenshots.map((shot) =>
      captionImage({ imageUrl: shot.url, apiKey }).catch((err) => {
        warnings.push(
          `Couldn't caption a screenshot (${err instanceof Error ? err.message : "error"}).`
        );
        return "";
      })
    )
  );
  const shotChunks: { content: string; imageUrl: string }[] = [];
  screenshots.forEach((shot, i) => {
    const caption = captions[i]?.trim();
    const label = shot.label?.trim();
    const content = [label, caption].filter(Boolean).join("\n").trim();
    // Skip a screenshot that produced neither a label nor a caption —
    // an empty chunk would just be retrieval noise.
    if (content) shotChunks.push({ content, imageUrl: shot.url });
  });

  // 3. Assemble chunk texts (transcript first, then screenshots in the
  //    order the author added them) and embed them all in one batch.
  const contents = [...textChunks, ...shotChunks.map((c) => c.content)];
  if (contents.length === 0) {
    return { chunks: [], warnings: warnings.concat("Nothing could be indexed.").join(" ") };
  }
  const embeddings = await embedBatch({ texts: contents, apiKey });

  const chunks: SopChunk[] = contents.map((content, i) => ({
    content,
    embedding: embeddings[i],
    tokenCount: Math.ceil(content.length / 4),
    // The first textChunks.length chunks are transcript text (no image);
    // the rest are screenshots and carry their source image URL.
    imageUrl: i < textChunks.length ? null : shotChunks[i - textChunks.length].imageUrl
  }));

  return { chunks, warnings: warnings.join(" ") };
}

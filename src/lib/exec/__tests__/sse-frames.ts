// Test support (P5b Area D): a STRICT reader of the chat route's SSE bytes, so a
// test fails on any frame that isn't exactly `event: <name>\ndata: <JSON>\n\n`
// or a `: comment\n\n` heartbeat. Deliberately not the UI's tolerant parser
// (chat/sse-parse.ts, Area E): this one checks what the server writes.
// Imports nothing, so a vi.mock factory may load it.

export interface SseFrame {
  event: string;
  data: unknown;
}

export interface SseRead {
  raw: string;
  frames: SseFrame[];
  comments: string[];
  /** Every frame and comment in order (comments as { event: ":" , data: text }). */
  sequence: SseFrame[];
}

export function parseSseStrict(raw: string): SseRead {
  if (raw.includes("\r")) throw new Error("sse: a carriage return in the stream");
  if (raw !== "" && !raw.endsWith("\n\n")) throw new Error("sse: the stream doesn't end on a frame boundary");
  const blocks = raw === "" ? [] : raw.slice(0, -2).split("\n\n");
  const frames: SseFrame[] = [];
  const comments: string[] = [];
  const sequence: SseFrame[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    if (lines.length === 1 && lines[0].startsWith(": ")) {
      comments.push(lines[0].slice(2));
      sequence.push({ event: ":", data: lines[0].slice(2) });
      continue;
    }
    if (lines.length !== 2 || !/^event: [a-z]+$/.test(lines[0]) || !lines[1].startsWith("data: ")) {
      throw new Error(`sse: a malformed frame ${JSON.stringify(block.slice(0, 120))}`);
    }
    const frame = { event: lines[0].slice("event: ".length), data: JSON.parse(lines[1].slice("data: ".length)) as unknown };
    frames.push(frame);
    sequence.push(frame);
  }
  return { raw, frames, comments, sequence };
}

/** The whole body of a streamed Response, read to its end. */
export async function readSse(res: Response): Promise<SseRead> {
  return parseSseStrict(await readBody(res));
}

export async function readBody(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out + decoder.decode();
    out += decoder.decode(value, { stream: true });
  }
}

/** Reads chunks until the accumulated text holds `count` complete blocks (frames or comments). */
export async function readBlocks(reader: ReadableStreamDefaultReader<Uint8Array>, count: number, carry = { text: "" }): Promise<string> {
  const decoder = new TextDecoder();
  while ((carry.text.match(/\n\n/g) ?? []).length < count) {
    const { done, value } = await reader.read();
    if (done) break;
    carry.text += decoder.decode(value, { stream: true });
  }
  return carry.text;
}

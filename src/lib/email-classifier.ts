import { getAnthropic, resetAnthropic, MODELS } from "./anthropic-client";

// The Anthropic SDK throws errors carrying the HTTP status; a 401 means the
// API key we sent is invalid/revoked (vs. 429 rate-limit, 404 bad model,
// network, etc.). We special-case 401 to self-heal a stale cached key.
function isAnthropicAuthError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { status?: number }).status === 401
  );
}

// What the email-intake pipeline gets back from Claude after reading a
// thread. Drives the task title/description/priority + which routing
// signals to feed into the matcher.
export interface ClassifiedEmail {
  title: string;
  description: string;
  priority: "low" | "medium" | "high" | "critical";
  // Free-form skill/topic tags Claude pulls out of the email body —
  // matched against routing rules + user_skills tags.
  tags: string[];
  // Optional dept hint; falls back to the dept-routing endpoint if the
  // matcher + ranker both come up empty.
  departmentHint: string | null;
  confidence: "low" | "medium" | "high";
  // false = noise (promo / digest / receipt / FYI with no action needed).
  // When false the pipeline drops the thread without creating a task.
  // Defaults to true on parse errors so an LLM hiccup never silently
  // drops a real client email.
  isActionable: boolean;
  // Short Claude-written reason ("promotional", "shipping receipt",
  // "calendar invite", "FYI digest", …). Logged for audit so a leader
  // reviewing a missed email can see why intake skipped it.
  skipReason: string | null;
  // false = Claude errored / returned non-JSON / claimed actionable but gave
  // no description, so the routable fields are placeholder defaults (we
  // couldn't actually read the email). The intake pipeline treats this as
  // "no signal" and parks the thread in the leaders' needs-review queue
  // instead of auto-routing a draft built from a guessed title +
  // "couldn't auto-summarize" body. true = Claude classified it — either a
  // real summary to route, OR an explicit isActionable=false skip (promo /
  // digest / receipt), which the pipeline drops silently rather than parks.
  summarized: boolean;
}

interface DepartmentLite { id: string; name: string; description: string; taskTypes: string[]; }

// Read an inbound email thread, extract everything we'd otherwise have
// the user type into the new-task popdown. Robust JSON parse — falls
// back to a sensible shape on AI errors.
export async function classifyEmailThread(args: {
  subject: string;
  bodyText: string;
  fromEmail: string | null;
  departments: DepartmentLite[];
}): Promise<ClassifiedEmail> {
  const { subject, bodyText, fromEmail, departments } = args;

  const deptList = departments.map((d) =>
    `- ${d.name} (id: "${d.id}"): ${d.description}; covers ${d.taskTypes.join(", ")}`
  ).join("\n");

  const systemPrompt = `You convert inbound emails into ACTIONABLE task drafts at a digital agency. The assignee should be able to read the description and know exactly what to do without opening the original email.

FIRST: decide if this email is even worth turning into a task. Set isActionable=false (and skipReason="<short label>") for:
  - Promotional / marketing / cold sales pitches (even from a real-looking @company.com sender)
  - Newsletter / digest / weekly recap mail (Instagram recaps, Slack digests, vendor BI emails, citation reports, "your post got N impressions")
  - Service advisories with no action required (Microsoft 365 Message Center, plugin update FYIs, backup-completed pings)
  - Shipping / order / payment receipts ("your order has shipped", "payment confirmation #…")
  - Bounce / NDR / mail delivery failure replies
  - Auto-replies and out-of-office responses
  - Survey / NPS / feedback requests with no follow-up needed
  - Calendar invites that just confirm an existing meeting

Set isActionable=true ONLY when a human at the agency needs to do something concrete in response — reply to a client, fix a real issue, deliver work, make a decision, sign a contract. If you'd write the task as "review and decide whether to ignore", it should be isActionable=false instead.

When in genuine doubt, prefer isActionable=true — we'd rather create a task a leader rejects than miss real client work.

Departments:
${deptList || "(none configured)"}

Return STRICT JSON in exactly this shape — no preamble, no code fences:
{
  "isActionable": <true | false>,
  "skipReason": "<short label like 'promotional' or 'shipping receipt'; null when isActionable=true>",
  "title": "<short, action-y task title; starts with a verb; <70 chars>",
  "description": "<Markdown-formatted description, see rubric below>",
  "priority": "<low | medium | high | critical>",
  "tags": ["<short topic/skill keywords>"],
  "departmentHint": "<one of the dept ids above, or null if unclear>"
}

Title rubric:
- Starts with a verb: "Fix", "Build", "Send", "Review", "Update", "Reply to".
- NOT "Email from X about Y" — that's a description of the email, not the task.

Description rubric (this is the part that matters most):
Write Markdown with EXACTLY these sections, in order. Skip sections that have no real content; never invent content.

**Do:** <one-sentence imperative of the concrete deliverable. e.g. "Send Colin the updated branding mockup PDF and confirm the new hero image is approved.">

**Context:**
- <3-6 bullets covering the relevant background, constraints, deadlines mentioned, prior decisions, anything weird>
- <pull specific names, dates, URLs, file references straight from the email>
- <if the email asks multiple questions, list each one>

**Requested by:** <name + email of sender>
**Mentioned deadline:** <if the email explicitly states one, quote it; "no deadline mentioned" otherwise>

Rules:
- NEVER paste the raw email body. Summarize.
- NEVER write "Client wrote: …" or "The email says …". Just describe the work.
- Quote short phrases (≤8 words) when wording matters; don't quote whole sentences.
- If there are links or files mentioned, list them under Context as a "Links:" bullet.

Priority rubric:
- "critical" = explicit emergency (site down, broken billing, legal threat).
- "high" = same-day need or paying client blocked.
- "medium" = normal client work.
- "low" = FYI / nice-to-have.

Tags are 1-4 short lowercase words (e.g. "wordpress", "billing", "design"). They feed our auto-delegation engine.`;

  // Build the request once so the auth-retry below can reissue the exact
  // same call.
  const createParams = {
    model: MODELS.classify,
    max_tokens: 1200,
    system: systemPrompt,
    messages: [{
      role: "user" as const,
      content: [
        fromEmail ? `From: ${fromEmail}` : "",
        `Subject: ${subject}`,
        "",
        // Truncate to a generous but bounded slice so a 200-msg
        // thread doesn't blow the context window.
        bodyText.slice(0, 6000)
      ].filter(Boolean).join("\n")
    }]
  };

  let parsed: Partial<ClassifiedEmail> = {};
  // True once we've parsed a usable JSON object out of Claude's reply — i.e.
  // Claude actually classified the email (whether it judged it actionable or
  // not). Stays false on a thrown error / non-JSON / unparseable reply, which
  // is the ONLY thing that should count as a classifier failure downstream.
  let parsedOk = false;
  try {
    let result;
    try {
      result = await (await getAnthropic()).messages.create(createParams);
    } catch (err) {
      // A cached-but-invalid API key poisons EVERY classify call for the
      // life of the server process (the key is cached in module memory at
      // first use). If the process booted before ANTHROPIC_API_KEY was set,
      // or Vault returned a stale value, it keeps 401-ing forever — exactly
      // the routing-review "Couldn't auto-summarize" flood. Drop the cached
      // key + client so the next read picks up the corrected value and retry
      // once. Anything that isn't a 401 (rate limit, bad model, network)
      // rethrows to the outer catch unchanged.
      if (isAnthropicAuthError(err)) {
        console.warn(
          "[email-classifier] 401 from Anthropic — resetting cached key and retrying once"
        );
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
    if (match) {
      parsed = JSON.parse(match[0]);
      parsedOk = true;
    }
  } catch (err) {
    // Don't swallow this — a bulk "Couldn't auto-summarize" park in
    // routing-review means the classify call is failing for every email,
    // and this is the only place the real cause (401 invalid key / 404
    // bad model / 429 quota / network) is visible. Log it like the rest
    // of the intake pipeline so it shows up in the Railway deploy logs.
    console.warn(
      `[email-classifier] classify failed for "${subject.slice(0, 80)}" — falling back to unsummarized:`,
      err instanceof Error ? err.message : err
    );
  }

  // Validate + coerce. Anything Claude returns that's not in-shape gets
  // replaced with a sane default so downstream code doesn't have to
  // null-check every field.
  const validPriorities = new Set(["low", "medium", "high", "critical"] as const);
  const priority: ClassifiedEmail["priority"] =
    typeof parsed.priority === "string" && validPriorities.has(parsed.priority as never)
      ? (parsed.priority as ClassifiedEmail["priority"])
      : "medium";

  const tags = Array.isArray(parsed.tags)
    ? parsed.tags
        .map((t) => (typeof t === "string" ? t.trim().toLowerCase() : ""))
        .filter((t) => t.length > 0 && t.length <= 32)
        .slice(0, 6)
    : [];

  const departmentHint =
    typeof parsed.departmentHint === "string" &&
    departments.some((d) => d.id === parsed.departmentHint)
      ? parsed.departmentHint
      : null;

  const confidence: ClassifiedEmail["confidence"] =
    departmentHint && tags.length > 0
      ? "high"
      : departmentHint || tags.length > 0
        ? "medium"
        : "low";

  // Default to actionable on parse error / missing field — we'd rather
  // create a task a leader rejects than silently drop real client work.
  const isActionable = parsed.isActionable === false ? false : true;

  // Did Claude actually classify the email? "Summarized" means we got a
  // usable structured reply back — NOT that the description is populated.
  // A correctly-skipped non-actionable email (promo / digest / receipt)
  // legitimately comes back with isActionable=false and description=null;
  // that's a SUCCESS and must fall through to the not-actionable skip in
  // the intake pipeline, NOT the "Couldn't auto-summarize" failure park.
  // So: summarized when we parsed JSON AND it's either an explicit skip or
  // carries a real description. Only a thrown error / non-JSON reply
  // (parsedOk=false) — or valid JSON that claims actionable yet gives us no
  // description to route on — counts as a classifier failure.
  const summarized =
    parsedOk &&
    (parsed.isActionable === false ||
      (typeof parsed.description === "string" && parsed.description.trim().length > 0));
  const skipReason =
    !isActionable && typeof parsed.skipReason === "string" && parsed.skipReason.trim()
      ? parsed.skipReason.trim().slice(0, 80)
      : null;

  return {
    title:
      typeof parsed.title === "string" && parsed.title.trim()
        ? parsed.title.trim().slice(0, 120)
        : subject.slice(0, 120) || "Email task",
    description:
      typeof parsed.description === "string"
        ? parsed.description.trim().slice(0, 4000)
        : // AI errored — produce a clearly-marked placeholder instead of
          // dumping the raw email body, so the assignee knows they need
          // to read the original thread (linked under the description).
          `**Do:** Read the linked email thread and turn it into a task.\n\n_Couldn't auto-summarize this one — open the thread for the full email._\n\n**Requested by:** ${fromEmail ?? "unknown"}`,
    priority,
    tags,
    departmentHint,
    confidence,
    isActionable,
    skipReason,
    summarized
  };
}

import "server-only";
import { randomBytes } from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { seal, hint as maskHint, preview, vaultConfigured } from "@/lib/onboarding-vault";
import {
  CLIENT_FIELD_MAP,
  FORMS,
  getField,
  getStep,
  workingSteps,
  type FormKey
} from "@/lib/client-onboarding-forms";

// Data layer for client onboarding forms.
//
// Everything is keyed off the LINK rather than the client. A client can be sent
// both forms, and can be sent the same form twice after a rebuild, and the two
// sets of answers have to stay separable — otherwise "what did they tell us
// about their services" has two answers and no way to tell which is current.

export interface OnboardingLink {
  id: string;
  token: string;
  formKey: FormKey;
  clientId: string;
  clientName: string;
  departmentId: string | null;
  createdBy: string | null;
  createdAt: string;
  firstOpenedAt: string | null;
  completedAt: string | null;
  revokedAt: string | null;
}

export interface OnboardingAnswer {
  id: string;
  stepId: string;
  fieldKey: string;
  label: string;
  /** Readable for ordinary answers, masked for secrets. Never the plaintext of
   *  a secret — that only ever comes back through revealAnswer. */
  hint: string;
  isSecret: boolean;
  submittedAt: string;
}

export interface OnboardingFile {
  id: string;
  stepId: string;
  fieldKey: string;
  fileName: string;
  url: string;
  contentType: string | null;
  sizeBytes: number | null;
  uploadedAt: string;
}

interface LinkRow {
  id: string;
  token: string;
  form_key: string;
  client_id: string;
  department_id: string | null;
  created_by: string | null;
  created_at: string;
  first_opened_at: string | null;
  completed_at: string | null;
  revoked_at: string | null;
  clients?: { name: string } | { name: string }[] | null;
}

function clientNameOf(row: LinkRow): string {
  const c = row.clients;
  if (!c) return "";
  return Array.isArray(c) ? c[0]?.name ?? "" : c.name;
}

function toLink(row: LinkRow): OnboardingLink {
  return {
    id: row.id,
    token: row.token,
    formKey: row.form_key as FormKey,
    clientId: row.client_id,
    clientName: clientNameOf(row),
    departmentId: row.department_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    firstOpenedAt: row.first_opened_at,
    completedAt: row.completed_at,
    revokedAt: row.revoked_at
  };
}

const LINK_COLS =
  "id, token, form_key, client_id, department_id, created_by, created_at, first_opened_at, completed_at, revoked_at";

// ---------------------------------------------------------------------------
// Creating a link (and, usually, the client it belongs to)
// ---------------------------------------------------------------------------

/** Same id shape /api/clients POST uses, so a client created here is
 *  indistinguishable from one created through the New client dialog. */
function clientIdFromName(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 32);
  return `cl_${slug}_${randomBytes(2).toString("hex")}`;
}

/**
 * Mint a link, creating a lightweight client row when we are given a name
 * rather than an existing id.
 *
 * The shell client is deliberately thin — a name, active status, medium
 * priority, nothing else. Everything a full client record carries (website,
 * contact, business information) is what the form is about to collect, and
 * inventing placeholder values now would mean applyAnswersToClient later has to
 * decide whether it is allowed to overwrite its own guesses.
 */
export async function createOnboardingLink(input: {
  formKey: FormKey;
  name?: string;
  clientId?: string;
  createdBy: string | null;
}): Promise<OnboardingLink & { reusedExisting: boolean }> {
  const supabase = getSupabaseAdmin();
  let clientId = input.clientId ?? "";
  let clientName = "";
  // Whether the name they typed turned out to be a client we already had. The
  // caller says so on screen — silently attaching to an existing record would
  // look like a new client had been created when it had not.
  let reusedExisting = false;

  if (clientId) {
    const { data, error } = await supabase
      .from("clients")
      .select("id, name")
      .eq("id", clientId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error("that client no longer exists");
    clientName = data.name as string;
  } else {
    const name = (input.name ?? "").trim();
    if (!name) throw new Error("give the client a name first");

    // clients.name is UNIQUE, and typing the name of a client we already have
    // is the obvious thing to do when you want to send THEM a form. Reuse that
    // client rather than failing: a duplicate row would split their tasks,
    // emails and history across two records, and the raw unique-violation this
    // would otherwise surface tells the operator nothing about what to do next.
    // limit(1) rather than maybeSingle(): the UNIQUE index on clients.name is
    // case-SENSITIVE, so "Acme" and "acme" can both exist, and a case-insensitive
    // lookup that insisted on exactly one row would error out on precisely the
    // messy data this is here to cope with.
    const { data: hits, error: findErr } = await supabase
      .from("clients")
      .select("id, name")
      .ilike("name", name)
      .limit(1);
    if (findErr) throw new Error(findErr.message);
    const hit = (hits ?? [])[0];

    if (hit) {
      clientId = hit.id as string;
      clientName = hit.name as string;
      reusedExisting = true;
    } else {
      clientId = clientIdFromName(name);
      const { data, error } = await supabase
        .from("clients")
        .insert({ id: clientId, name })
        .select("id, name")
        .single();
      // A racing create between the lookup above and this insert lands here.
      // Rare, but the recovery is the same as the branch above: use theirs.
      if (error) {
        if (error.code === "23505") {
          const { data: racedRows } = await supabase
            .from("clients")
            .select("id, name")
            .ilike("name", name)
            .limit(1);
          const raced = (racedRows ?? [])[0];
          if (!raced) throw new Error(error.message);
          clientId = raced.id as string;
          clientName = raced.name as string;
          reusedExisting = true;
        } else {
          throw new Error(error.message);
        }
      } else {
        clientId = data.id as string;
        clientName = data.name as string;
      }
    }
  }

  // 32 bytes of randomness, base64url. This IS the credential for the form, so
  // it is sized like one — guessing it is not a threat model anyone has to
  // think about again.
  const token = randomBytes(32).toString("base64url");
  const id = `ol_${randomBytes(8).toString("hex")}`;

  const { data, error } = await supabase
    .from("client_onboarding_links")
    .insert({
      id,
      token,
      form_key: input.formKey,
      client_id: clientId,
      department_id: FORMS[input.formKey].departmentId,
      created_by: input.createdBy
    })
    .select(LINK_COLS)
    .single();
  if (error) throw new Error(error.message);

  return { ...toLink(data as LinkRow), clientName, reusedExisting };
}

// ---------------------------------------------------------------------------
// Reading a link
// ---------------------------------------------------------------------------

/** Resolve the token in the URL. Returns null for unknown OR revoked links —
 *  the caller 404s either way, because telling a stranger the difference
 *  between "never existed" and "was turned off" tells them a valid token shape
 *  and nothing useful to anyone we actually sent it to. */
export async function getLinkByToken(token: string): Promise<OnboardingLink | null> {
  if (!token) return null;
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("client_onboarding_links")
    .select(`${LINK_COLS}, clients(name)`)
    .eq("token", token)
    .is("revoked_at", null)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? toLink(data as LinkRow) : null;
}

/** Stamped once, the first time somebody opens the link. The gap between
 *  "sent" and "opened" is the most actionable thing on the client card — it is
 *  the difference between chasing the client and chasing the email. */
export async function markOpened(link: OnboardingLink): Promise<void> {
  if (link.firstOpenedAt) return;
  const supabase = getSupabaseAdmin();
  await supabase
    .from("client_onboarding_links")
    .update({ first_opened_at: new Date().toISOString() })
    .eq("id", link.id)
    .is("first_opened_at", null);
}

export async function listLinksForClient(clientId: string): Promise<OnboardingLink[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("client_onboarding_links")
    .select(`${LINK_COLS}, clients(name)`)
    .eq("client_id", clientId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return ((data ?? []) as LinkRow[]).map(toLink);
}

export async function revokeLink(id: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("client_onboarding_links")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(error.message);
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

export interface SaveResult {
  saved: number;
  /** Fields we refused, with the reason. Today there is exactly one reason —
   *  a secret field with no ONBOARDING_SECRET configured — and the client is
   *  told so on screen rather than being left to think it saved. */
  refused: { key: string; label: string; reason: string }[];
}

export async function saveAnswers(input: {
  link: OnboardingLink;
  stepId: string;
  values: { key: string; value: string }[];
}): Promise<SaveResult> {
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  const refused: SaveResult["refused"] = [];
  const rows: Record<string, unknown>[] = [];

  for (const v of input.values) {
    const plain = (v.value ?? "").trim();
    if (!plain) continue;

    // The field definition is the authority on whether something is secret —
    // never the client's own payload. Otherwise a crafted request could store a
    // password in the plaintext column simply by claiming it was not one.
    const field = getField(input.link.formKey, input.stepId, v.key);
    if (!field) continue;

    const base = {
      id: `${input.link.id}:${input.stepId}:${v.key}`,
      link_id: input.link.id,
      client_id: input.link.clientId,
      step_id: input.stepId,
      field_key: v.key,
      label: field.label,
      submitted_at: now
    };

    if (field.secret) {
      if (!vaultConfigured()) {
        refused.push({
          key: v.key,
          label: field.label,
          reason:
            "We can't store that securely just yet, so we haven't stored it at all. "
            + "Leave it blank and our team will collect it with you directly."
        });
        continue;
      }
      rows.push({ ...base, value: null, sealed: seal(plain), hint: maskHint(plain), is_secret: true });
    } else {
      rows.push({ ...base, value: plain, sealed: null, hint: preview(plain), is_secret: false });
    }
  }

  if (rows.length) {
    const { error } = await supabase.from("client_onboarding_answers").upsert(rows);
    if (error) throw new Error(error.message);
  }
  return { saved: rows.length, refused };
}

/** What the client has already sent, for pre-filling the form.
 *
 *  Non-secret answers come back in full — the person reading them is the person
 *  who typed them, and the stored `hint` is a 160-character preview that would
 *  silently truncate a long answer the moment they edited the step.
 *
 *  Secrets come back MASKED and never in plaintext. A client does not need
 *  their own password read back to them, and this must never become a way to
 *  retrieve one: anybody holding the link would then hold the credential too,
 *  which would make the encryption theatre.
 */
export async function getAnswerState(
  linkId: string
): Promise<Record<string, Record<string, { value: string; isSecret: boolean }>>> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("client_onboarding_answers")
    .select("step_id, field_key, value, hint, is_secret")
    .eq("link_id", linkId);
  if (error) throw new Error(error.message);

  const out: Record<string, Record<string, { value: string; isSecret: boolean }>> = {};
  for (const r of data ?? []) {
    const step = r.step_id as string;
    const isSecret = !!r.is_secret;
    out[step] = out[step] ?? {};
    out[step][r.field_key as string] = {
      value: isSecret ? ((r.hint as string | null) ?? "••••") : ((r.value as string | null) ?? ""),
      isSecret
    };
  }
  return out;
}

export async function listAnswers(linkId: string): Promise<OnboardingAnswer[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("client_onboarding_answers")
    .select("id, step_id, field_key, label, hint, is_secret, submitted_at")
    .eq("link_id", linkId)
    .order("submitted_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    id: r.id as string,
    stepId: r.step_id as string,
    fieldKey: r.field_key as string,
    label: r.label as string,
    hint: (r.hint as string | null) ?? "",
    isSecret: !!r.is_secret,
    submittedAt: r.submitted_at as string
  }));
}

/** The one path that turns a sealed answer back into plaintext. Callers must
 *  have already checked canRevealOnboardingSecret. */
export async function readSealedAnswer(answerId: string): Promise<string | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("client_onboarding_answers")
    .select("sealed, is_secret")
    .eq("id", answerId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || !data.is_secret || !data.sealed) return null;
  const { open } = await import("@/lib/onboarding-vault");
  return open(data.sealed as string);
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

export async function markStepDone(linkId: string, stepId: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("client_onboarding_steps")
    .upsert({ link_id: linkId, step_id: stepId, done_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
}

export async function listDoneSteps(linkId: string): Promise<string[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("client_onboarding_steps")
    .select("step_id")
    .eq("link_id", linkId);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => r.step_id as string);
}

export async function completeLink(link: OnboardingLink): Promise<void> {
  if (link.completedAt) return;
  const supabase = getSupabaseAdmin();
  await supabase
    .from("client_onboarding_links")
    .update({ completed_at: new Date().toISOString() })
    .eq("id", link.id)
    .is("completed_at", null);
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export async function recordFile(input: {
  link: OnboardingLink;
  stepId: string;
  fieldKey: string;
  fileName: string;
  url: string;
  storageKey: string;
  contentType: string | null;
  sizeBytes: number;
}): Promise<OnboardingFile> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("client_onboarding_files")
    .insert({
      id: `of_${randomBytes(8).toString("hex")}`,
      link_id: input.link.id,
      client_id: input.link.clientId,
      step_id: input.stepId,
      field_key: input.fieldKey,
      file_name: input.fileName,
      url: input.url,
      storage_key: input.storageKey,
      content_type: input.contentType,
      size_bytes: input.sizeBytes
    })
    .select("id, step_id, field_key, file_name, url, content_type, size_bytes, uploaded_at")
    .single();
  if (error) throw new Error(error.message);
  return {
    id: data.id as string,
    stepId: data.step_id as string,
    fieldKey: data.field_key as string,
    fileName: data.file_name as string,
    url: data.url as string,
    contentType: (data.content_type as string | null) ?? null,
    sizeBytes: (data.size_bytes as number | null) ?? null,
    uploadedAt: data.uploaded_at as string
  };
}

export async function listFiles(linkId: string): Promise<OnboardingFile[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("client_onboarding_files")
    .select("id, step_id, field_key, file_name, url, content_type, size_bytes, uploaded_at")
    .eq("link_id", linkId)
    .order("uploaded_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    id: r.id as string,
    stepId: r.step_id as string,
    fieldKey: r.field_key as string,
    fileName: r.file_name as string,
    url: r.url as string,
    contentType: (r.content_type as string | null) ?? null,
    sizeBytes: (r.size_bytes as number | null) ?? null,
    uploadedAt: r.uploaded_at as string
  }));
}

// ---------------------------------------------------------------------------
// Backfilling the client record
// ---------------------------------------------------------------------------

/**
 * Copy the handful of answers that have a home in the clients table onto the
 * client itself, so the profile page, the composer and the client↔thread email
 * matching all benefit without anyone retyping.
 *
 * ONLY fills columns that are still empty. A head who has already set a website
 * by hand knows something the form does not — most obviously when the client
 * types their old site into a form about building a new one — and a "helpful"
 * overwrite here would be silent and hard to trace back.
 *
 * Secrets are excluded outright: nothing sealed has a destination column, and
 * routing one into business_information would undo the encryption two files
 * away from where it was applied.
 */
export async function applyAnswersToClient(link: OnboardingLink): Promise<void> {
  const supabase = getSupabaseAdmin();

  const { data: answerRows, error: aErr } = await supabase
    .from("client_onboarding_answers")
    .select("field_key, value, is_secret")
    .eq("link_id", link.id)
    .eq("is_secret", false);
  if (aErr) throw new Error(aErr.message);

  const byKey = new Map<string, string>();
  for (const r of answerRows ?? []) {
    const v = ((r.value as string | null) ?? "").trim();
    if (v) byKey.set(r.field_key as string, v);
  }

  const { data: client, error: cErr } = await supabase
    .from("clients")
    .select("id, name, website, contact_name, contact_emails, business_information, onboarding_date")
    .eq("id", link.clientId)
    .maybeSingle();
  if (cErr) throw new Error(cErr.message);
  if (!client) return;

  const map = CLIENT_FIELD_MAP[link.formKey];
  const patch: Record<string, unknown> = {};

  // The client's NAME is deliberately not touched.
  //
  // It is the one field that always has a value already — a head typed it to
  // mint the link — and it is the label this account carries on the board, in
  // the task list, in Slack notices and in every email thread matched to it.
  // The form's own name question is free text, and "Acme Recovery Center, LLC
  // (formerly Acme House)" is a perfectly good answer to it and a terrible
  // display name. Renaming an account out from under the team on the strength
  // of that is not a trade worth making: the answer stays on the onboarding
  // card, and somebody renames the client by hand if it reads better.

  if (map.website && !((client.website as string | null) ?? "").trim()) {
    const site = byKey.get(map.website);
    if (site) patch.website = site.slice(0, 300);
  }

  if (!((client.contact_name as string | null) ?? "").trim()) {
    const first = map.contactFirstName ? byKey.get(map.contactFirstName) ?? "" : "";
    const last = map.contactLastName ? byKey.get(map.contactLastName) ?? "" : "";
    const full = `${first} ${last}`.trim();
    if (full) patch.contact_name = full;
  }

  if (map.contactEmail) {
    const email = byKey.get(map.contactEmail)?.toLowerCase();
    const existing = ((client.contact_emails as string[] | null) ?? []).map((e) => e.toLowerCase());
    // Appended rather than replaced: contact_emails feeds the client↔thread
    // matching, and dropping an address the team already relies on would
    // silently detach a live email history from the client.
    if (email && !existing.includes(email)) {
      patch.contact_emails = [...((client.contact_emails as string[] | null) ?? []), email];
    }
  }

  if (map.businessInformation && !((client.business_information as string | null) ?? "").trim()) {
    const info = byKey.get(map.businessInformation);
    if (info) patch.business_information = info;
  }

  if (!client.onboarding_date) {
    patch.onboarding_date = new Date().toISOString().slice(0, 10);
  }

  if (Object.keys(patch).length === 0) return;
  const { error } = await supabase.from("clients").update(patch).eq("id", link.clientId);
  if (error) throw new Error(error.message);
}

// ---------------------------------------------------------------------------

/** n of N, for the progress line on the client card. */
export function progressOf(formKey: FormKey, doneStepIds: string[]): { done: number; total: number } {
  const steps = workingSteps(formKey);
  const ids = new Set(doneStepIds);
  return { done: steps.filter((s) => ids.has(s.id)).length, total: steps.length };
}

// ---------------------------------------------------------------------------
// Everything the client page needs, in one call
// ---------------------------------------------------------------------------

export interface ClientOnboardingView {
  links: (OnboardingLink & { doneCount: number; total: number })[];
  answers: (OnboardingAnswer & { linkId: string; stepTitle: string })[];
  files: (OnboardingFile & { linkId: string })[];
}

/**
 * The onboarding section of a client's profile.
 *
 * Fanned out per link rather than queried across the client, because the step
 * titles have to come from whichever form each link belongs to — a client sent
 * both forms has two step lists, and a single client-wide query would have no
 * way to label an answer's section correctly.
 */
export async function listOnboardingForClient(clientId: string): Promise<ClientOnboardingView> {
  const links = await listLinksForClient(clientId);
  if (!links.length) return { links: [], answers: [], files: [] };

  const parts = await Promise.all(
    links.map(async (link) => {
      const [done, answers, files] = await Promise.all([
        listDoneSteps(link.id),
        listAnswers(link.id),
        listFiles(link.id)
      ]);
      const { done: doneCount, total } = progressOf(link.formKey, done);
      return {
        link: { ...link, doneCount, total },
        answers: answers.map((a) => ({
          ...a,
          linkId: link.id,
          // Falls back to the raw id rather than throwing: a step renamed or
          // removed from the script must not blank out answers a client already
          // gave under it.
          stepTitle: getStep(link.formKey, a.stepId)?.title ?? a.stepId
        })),
        files: files.map((f) => ({ ...f, linkId: link.id }))
      };
    })
  );

  return {
    links: parts.map((p) => p.link),
    answers: parts.flatMap((p) => p.answers),
    files: parts.flatMap((p) => p.files)
  };
}

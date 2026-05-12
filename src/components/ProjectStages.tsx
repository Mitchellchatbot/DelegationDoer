"use client";

// Interactive stage cards for a project. Each card surfaces:
//   - Status pill (locked / active / done) + position
//   - Two bullet lists ("It is" / "It isn't"), inline editable
//   - Image gallery: tiles + a drop-target for new uploads (uses the
//     existing /api/upload endpoint, then we PATCH the stage with the
//     new combined imageUrls list)
//   - Notes textarea, autosaves on blur
//   - Embedded task list grouped by parallel_group with assignee /
//     status; click-through to the task detail page
//   - "Mark complete" button on the active stage — triggers the flow
//     engine on the server which activates the next stage and
//     auto-delegates its first batch.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import Link from "next/link";
import {
  CheckCircle2, Lock, PlayCircle, Plus, Upload, X, Image as ImageIcon,
  ChevronRight, Save, Loader2
} from "lucide-react";
import { toast } from "sonner";

interface StageTask {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assigneeId: string | null;
  stagePosition: number | null;
  parallelGroup: number | null;
  estimatedHours: number;
  actualHours: number;
  dueDate: string | null;
}

export interface StageDTO {
  id: string;
  projectId: string;
  position: number;
  name: string;
  kind: string;
  status: "locked" | "active" | "done";
  isIt: string[];
  isNot: string[];
  imageUrls: string[];
  notes: string;
  tasks: StageTask[];
}

interface AssigneeLite {
  id: string;
  name: string;
  avatarUrl?: string | null;
}

export function ProjectStages({
  projectId,
  initialStages,
  assigneesById
}: {
  projectId: string;
  initialStages: StageDTO[];
  assigneesById: Record<string, AssigneeLite>;
}) {
  const [stages, setStages] = useState<StageDTO[]>(initialStages);
  const router = useRouter();

  function patchStage(stageId: string, patch: Partial<StageDTO>) {
    setStages((cur) => cur.map((s) => (s.id === stageId ? { ...s, ...patch } : s)));
  }

  async function savePatch(stageId: string, body: Record<string, unknown>) {
    try {
      const res = await fetch(`/api/projects/${projectId}/stages/${stageId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? `status ${res.status}`);
      }
    } catch (err) {
      toast.error(`Couldn't save: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }

  async function markComplete(stageId: string, stageName: string) {
    if (!confirm(`Mark "${stageName}" complete? This activates the next stage and auto-assigns its tasks.`)) return;
    try {
      const res = await fetch(`/api/projects/${projectId}/stages/${stageId}/complete`, {
        method: "POST"
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? `status ${res.status}`);
      }
      toast.success(`${stageName} closed · next stage dispatched`);
      router.refresh();
    } catch (err) {
      toast.error(`Couldn't complete: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }

  return (
    <div className="space-y-4">
      {stages.map((s, idx) => (
        <StageCard
          key={s.id}
          stage={s}
          assigneesById={assigneesById}
          isLast={idx === stages.length - 1}
          onPatch={(patch) => patchStage(s.id, patch)}
          onSave={(body) => savePatch(s.id, body)}
          onComplete={() => markComplete(s.id, s.name)}
        />
      ))}
    </div>
  );
}

const STATUS_STYLE: Record<StageDTO["status"], { tone: string; icon: React.ReactNode; label: string }> = {
  locked: {
    tone: "bg-slate-100 text-slate-500 border-slate-200",
    icon: <Lock className="w-3 h-3" />,
    label: "locked"
  },
  active: {
    tone: "bg-blue-100 text-blue-700 border-blue-200",
    icon: <PlayCircle className="w-3 h-3" />,
    label: "active"
  },
  done: {
    tone: "bg-emerald-100 text-emerald-700 border-emerald-200",
    icon: <CheckCircle2 className="w-3 h-3" />,
    label: "done"
  }
};

function StageCard({
  stage, assigneesById, isLast, onPatch, onSave, onComplete
}: {
  stage: StageDTO;
  assigneesById: Record<string, AssigneeLite>;
  isLast: boolean;
  onPatch: (patch: Partial<StageDTO>) => void;
  onSave: (body: Record<string, unknown>) => Promise<void>;
  onComplete: () => void;
}) {
  const sx = STATUS_STYLE[stage.status];
  const dim = stage.status === "locked";

  return (
    <motion.section
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className={
        "rounded-2xl border bg-white shadow-soft overflow-hidden transition-opacity " +
        (dim ? "opacity-70" : "")
      }
    >
      <header className="flex items-center gap-3 px-5 py-3 border-b border-slate-100">
        <span className="text-[11px] uppercase tracking-wider font-semibold text-ink/45 tabular-nums">
          Stage {stage.position + 1}
        </span>
        <h2 className="text-base font-semibold flex-1 min-w-0 truncate">{stage.name}</h2>
        <span className={"inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border " + sx.tone}>
          {sx.icon}
          {sx.label}
        </span>
        {stage.status === "active" && (
          <button
            type="button"
            onClick={onComplete}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-lift active:scale-95"
            style={{ background: "linear-gradient(135deg, #10b981 0%, #059669 100%)" }}
          >
            <CheckCircle2 className="w-3.5 h-3.5" />
            Mark complete
          </button>
        )}
      </header>

      <div className="p-5 grid grid-cols-2 gap-5">
        <BulletEditor
          title="This is what it is"
          tone="emerald"
          items={stage.isIt}
          onChange={(items) => { onPatch({ isIt: items }); onSave({ isIt: items }); }}
        />
        <BulletEditor
          title="This is what it isn't"
          tone="rose"
          items={stage.isNot}
          onChange={(items) => { onPatch({ isNot: items }); onSave({ isNot: items }); }}
        />
      </div>

      <div className="px-5 pb-5">
        <ImageGallery
          stageId={stage.id}
          imageUrls={stage.imageUrls}
          onChange={(next) => { onPatch({ imageUrls: next }); onSave({ imageUrls: next }); }}
        />
      </div>

      <div className="px-5 pb-5">
        <NotesEditor
          value={stage.notes}
          onChange={(v) => onPatch({ notes: v })}
          onBlur={(v) => onSave({ notes: v })}
        />
      </div>

      <div className="px-5 pb-5">
        <StageTaskList stage={stage} assigneesById={assigneesById} />
      </div>

      {!isLast && (
        <div className="flex justify-center pb-3 -mt-2">
          <ChevronRight className="w-4 h-4 rotate-90 text-ink/30" />
        </div>
      )}
    </motion.section>
  );
}

function BulletEditor({
  title, tone, items, onChange
}: {
  title: string;
  tone: "emerald" | "rose";
  items: string[];
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const tonedHeader =
    tone === "emerald"
      ? "text-emerald-700 bg-emerald-50/70 border-emerald-200/70"
      : "text-rose-700 bg-rose-50/70 border-rose-200/70";
  const bullet =
    tone === "emerald" ? "bg-emerald-500" : "bg-rose-500";

  function add() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    onChange([...items, trimmed]);
    setDraft("");
  }

  return (
    <div className={"rounded-xl border p-3 " + tonedHeader}>
      <div className="text-[10px] uppercase tracking-wider font-semibold mb-2">
        {title}
      </div>
      <ul className="space-y-1.5">
        {items.map((item, i) => (
          <li key={i} className="flex items-start gap-2 text-[13px] text-ink group">
            <span className={"inline-block w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 " + bullet} />
            <span className="flex-1 leading-snug">{item}</span>
            <button
              type="button"
              onClick={() => onChange(items.filter((_, idx) => idx !== i))}
              className="opacity-0 group-hover:opacity-100 transition-opacity text-ink/40 hover:text-rose-600"
              title="Remove"
            >
              <X className="w-3 h-3" />
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex items-center gap-1.5">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          placeholder="Add a bullet…"
          className="flex-1 bg-white/80 border border-white/80 rounded-md px-2 py-1 text-[12px] outline-none focus:ring-2 focus:ring-accent/30"
        />
        <button
          type="button"
          onClick={add}
          disabled={!draft.trim()}
          className="inline-flex items-center justify-center w-7 h-7 rounded-md bg-white/80 border border-white/80 text-ink/70 hover:text-ink disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

function ImageGallery({
  stageId, imageUrls, onChange
}: {
  stageId: string;
  imageUrls: string[];
  onChange: (next: string[]) => void;
}) {
  const [uploading, setUploading] = useState(false);

  async function upload(file: File) {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("taskId", stageId); // re-purposed path prefix
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "upload failed");
      onChange([...imageUrls, data.url as string]);
    } catch (err) {
      toast.error(`Upload failed: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setUploading(false);
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files ?? []).filter((f) => f.type.startsWith("image/"));
    for (const f of files) void upload(f);
  }

  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider font-semibold text-ink/55 mb-2 flex items-center gap-1.5">
        <ImageIcon className="w-3 h-3" />
        Diagrams & screenshots · {imageUrls.length}
      </div>
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        className="grid grid-cols-4 gap-2"
      >
        {imageUrls.map((url, i) => (
          <div key={url + i} className="relative group rounded-lg overflow-hidden border border-slate-200 aspect-video bg-slate-50">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={url} alt="" className="w-full h-full object-cover" />
            <button
              type="button"
              onClick={() => onChange(imageUrls.filter((u) => u !== url))}
              className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity bg-black/60 hover:bg-black/80 text-white rounded-full p-1"
              title="Remove"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        ))}
        <label
          className={
            "aspect-video rounded-lg border-2 border-dashed flex flex-col items-center justify-center gap-1 cursor-pointer transition-colors " +
            (uploading
              ? "border-blue-300 bg-blue-50/40 text-blue-600"
              : "border-slate-200 hover:border-accent/40 hover:bg-blue-50/30 text-ink/45 hover:text-accent")
          }
        >
          {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
          <span className="text-[10px] font-medium">
            {uploading ? "Uploading…" : "Drop or click"}
          </span>
          <input
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              for (const f of files) void upload(f);
              e.target.value = "";
            }}
          />
        </label>
      </div>
    </div>
  );
}

function NotesEditor({
  value, onChange, onBlur
}: {
  value: string;
  onChange: (v: string) => void;
  onBlur: (v: string) => void;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider font-semibold text-ink/55 mb-2 flex items-center gap-1.5">
        <Save className="w-3 h-3" />
        Notes · autosaves
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => onBlur(e.target.value)}
        rows={3}
        placeholder="Free-form thoughts, links, decisions…"
        className="w-full bg-white border border-slate-200/70 rounded-lg px-3 py-2 text-[13px] outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/40 resize-y transition-all"
      />
    </div>
  );
}

function StageTaskList({
  stage, assigneesById
}: {
  stage: StageDTO;
  assigneesById: Record<string, AssigneeLite>;
}) {
  // Bucket by parallel_group for visual grouping.
  const groups = new Map<number, StageTask[]>();
  for (const t of stage.tasks) {
    const key = t.parallelGroup ?? Number.MAX_SAFE_INTEGER;
    const arr = groups.get(key) ?? [];
    arr.push(t);
    groups.set(key, arr);
  }
  const orderedKeys = Array.from(groups.keys()).sort((a, b) => a - b);

  if (orderedKeys.length === 0) {
    return (
      <div className="text-[12px] text-ink/45 italic">No tasks attached to this stage.</div>
    );
  }

  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider font-semibold text-ink/55 mb-2">
        Tasks · {stage.tasks.length}
      </div>
      <div className="space-y-2">
        {orderedKeys.map((key) => {
          const group = groups.get(key) ?? [];
          const parallel = group.length > 1;
          return (
            <div key={key} className="space-y-1">
              {parallel && (
                <div className="text-[10px] uppercase tracking-wider font-semibold text-ink/40 px-2">
                  Batch {key} · parallel
                </div>
              )}
              {group.map((t) => {
                const assignee = t.assigneeId ? assigneesById[t.assigneeId] : null;
                const done = t.status === "done";
                return (
                  <Link
                    key={t.id}
                    href={`/tasks/${t.id}`}
                    className={
                      "flex items-center gap-2.5 px-3 py-2 rounded-lg border bg-white hover:border-accent/40 hover:bg-blue-50/30 transition-colors " +
                      (done ? "border-emerald-200 bg-emerald-50/30" : "border-slate-200/70")
                    }
                  >
                    {done ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                    ) : (
                      <span className="w-2 h-2 rounded-full bg-slate-300 ml-1 mr-0.5 shrink-0" />
                    )}
                    <div className="flex-1 min-w-0 text-[13px] truncate">
                      <span className={done ? "line-through text-ink/55" : ""}>{t.title}</span>
                    </div>
                    <span className="text-[10px] text-ink/55 tabular-nums">{t.estimatedHours}h</span>
                    {assignee ? (
                      <div className="flex items-center gap-1.5 text-[11px] text-ink/65">
                        <Initials name={assignee.name} />
                        <span className="hidden sm:inline">{assignee.name}</span>
                      </div>
                    ) : (
                      <span className="text-[10px] text-ink/45 italic">unassigned</span>
                    )}
                    <ChevronRight className="w-3.5 h-3.5 text-ink/30 shrink-0" />
                  </Link>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Initials({ name }: { name: string }) {
  const i = name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <span className="w-5 h-5 rounded-full bg-gradient-to-br from-blue-200 to-blue-100 text-blue-700 grid place-items-center text-[9px] font-bold shrink-0">
      {i}
    </span>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ListChecks, Sparkles, Plus, Check, Trash2, Loader2, ShieldAlert,
  Edit2, X, Users, Crown
} from "lucide-react";
import { PageHero } from "@/components/PageHero";
import { useCurrentUser } from "@/lib/user-context";
import { PersonAvatar } from "@/components/PersonAvatar";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface TodoList {
  id: string;
  ownerId: string | null;
  title: string;
  kind: "today" | "longterm" | "custom" | "shared";
  position: number;
  updatedAt: string;
  openCount: number;
  doneCount: number;
}
interface TodoItem {
  id: string;
  content: string;
  done: boolean;
  position: number;
  createdAt: string;
  updatedAt: string;
  doneAt: string | null;
  createdBy: string | null;
}
interface Leader {
  id: string;
  name: string;
  avatarUrl: string | null;
}

// Leader-only todo lists. Sidebar groups the lists into three
// buckets: the shared workspace list, the current leader's own
// lists (Today / Long-term / customs), and every other leader's
// lists. Click a list → checkable items on the right.
//
// Equal-authority model: any leader can check / edit / delete any
// item on any of these lists. The other leader's lists exist to be
// visible to you, not protected from you.
export default function TodosPage() {
  const me = useCurrentUser();
  const [lists, setLists] = useState<TodoList[] | null>(null);
  const [leaders, setLeaders] = useState<Leader[]>([]);
  const [meId, setMeId] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [items, setItems] = useState<TodoItem[] | null>(null);
  const [newItemText, setNewItemText] = useState("");
  const [busy, setBusy] = useState(false);
  const newItemRef = useRef<HTMLInputElement>(null);
  // In-app dialog state — replaces window.prompt + window.confirm.
  const [newListOpen, setNewListOpen] = useState(false);
  const [newListTitle, setNewListTitle] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<TodoList | null>(null);

  async function loadLists() {
    try {
      const res = await fetch("/api/todo-lists", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      setLists(data.lists ?? []);
      setLeaders(data.leaders ?? []);
      setMeId(data.meId ?? null);
      if (!activeId && data.lists?.length > 0) {
        // Default to the shared list if present, else the user's Today.
        const shared = data.lists.find((l: TodoList) => l.kind === "shared");
        const today = data.lists.find(
          (l: TodoList) => l.kind === "today" && l.ownerId === data.meId
        );
        setActiveId(shared?.id ?? today?.id ?? data.lists[0].id);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "couldn't load lists");
    }
  }

  async function loadItems(listId: string) {
    setItems(null);
    try {
      const res = await fetch(`/api/todo-lists/${listId}/items`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      setItems(data.items ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "couldn't load items");
      setItems([]);
    }
  }

  useEffect(() => { loadLists(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  useEffect(() => {
    if (activeId) loadItems(activeId);
  }, [activeId]);

  if (me.role !== "leader" && !me.isAdmin) {
    return (
      <div className="card p-6 max-w-lg mx-auto mt-12 text-center">
        <ShieldAlert className="w-8 h-8 text-warn mx-auto mb-2" />
        <div className="text-base font-medium">Leader only</div>
        <div className="text-sm text-muted mt-1">
          Personal todo lists are restricted to the Leader role.
        </div>
      </div>
    );
  }

  async function addItem() {
    if (!activeId) return;
    const content = newItemText.trim();
    if (!content) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/todo-lists/${activeId}/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      setItems((cur) => [...(cur ?? []), data.item]);
      setNewItemText("");
      // Refresh list counts on the sidebar (cheap).
      loadLists();
      newItemRef.current?.focus();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "couldn't add");
    } finally {
      setBusy(false);
    }
  }

  async function toggleDone(item: TodoItem) {
    // Optimistic.
    const next = !item.done;
    setItems((cur) => (cur ?? []).map((i) => i.id === item.id ? { ...i, done: next } : i));
    try {
      const res = await fetch(`/api/todo-items/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ done: next })
      });
      if (!res.ok) throw new Error(`failed (${res.status})`);
      loadLists();
    } catch (e) {
      // Revert on failure.
      setItems((cur) => (cur ?? []).map((i) => i.id === item.id ? { ...i, done: item.done } : i));
      toast.error(e instanceof Error ? e.message : "couldn't update");
    }
  }

  async function deleteItem(item: TodoItem) {
    const prev = items;
    setItems((cur) => (cur ?? []).filter((i) => i.id !== item.id));
    try {
      const res = await fetch(`/api/todo-items/${item.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`failed (${res.status})`);
      loadLists();
    } catch (e) {
      setItems(prev);
      toast.error(e instanceof Error ? e.message : "couldn't delete");
    }
  }

  async function editItem(item: TodoItem, content: string) {
    const trimmed = content.trim();
    if (!trimmed || trimmed === item.content) return;
    const prev = items;
    setItems((cur) => (cur ?? []).map((i) => i.id === item.id ? { ...i, content: trimmed } : i));
    try {
      const res = await fetch(`/api/todo-items/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: trimmed })
      });
      if (!res.ok) throw new Error(`failed (${res.status})`);
    } catch (e) {
      setItems(prev);
      toast.error(e instanceof Error ? e.message : "couldn't save");
    }
  }

  async function createList() {
    const title = newListTitle.trim();
    if (!title) return;
    try {
      const res = await fetch("/api/todo-lists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      await loadLists();
      setActiveId(data.list.id);
      setNewListTitle("");
      setNewListOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "couldn't create");
    }
  }

  function requestDeleteList(list: TodoList) {
    if (list.kind !== "custom") {
      toast.error("Today / Long-term / Shared can't be deleted");
      return;
    }
    setDeleteTarget(list);
  }

  async function confirmDeleteList() {
    const list = deleteTarget;
    if (!list) return;
    try {
      const res = await fetch(`/api/todo-lists/${list.id}`, { method: "DELETE" });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        throw new Error(d?.error ?? `failed (${res.status})`);
      }
      const remaining = (lists ?? []).filter((l) => l.id !== list.id);
      setLists(remaining);
      if (activeId === list.id) {
        setActiveId(remaining[0]?.id ?? null);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "couldn't delete");
    } finally {
      setDeleteTarget(null);
    }
  }

  // Sidebar groupings.
  const shared = (lists ?? []).filter((l) => l.kind === "shared");
  const myLists = (lists ?? []).filter((l) => l.ownerId === meId);
  const otherLeaderLists = leaders
    .filter((l) => l.id !== meId)
    .map((leader) => ({
      leader,
      lists: (lists ?? []).filter((l) => l.ownerId === leader.id)
    }))
    .filter((g) => g.lists.length > 0);

  const active = (lists ?? []).find((l) => l.id === activeId) ?? null;
  const ownerLabel = active
    ? active.ownerId === null
      ? "Shared with leaders"
      : active.ownerId === meId
        ? "Your list"
        : `${leaders.find((l) => l.id === active.ownerId)?.name ?? "Another leader"}'s list`
    : "";

  return (
    <div className="space-y-4 max-w-7xl mx-auto">
      <PageHero
        eyebrow="Leader todos"
        headline={["The other half of your ", { accent: "brain" }]}
        subtitle="Personal lists for today, long-term, and anything else. Shared with the other leader at the top. Workers can't see this tab."
        icon={<ListChecks />}
        iconTone="indigo"
      />

      <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-4">
        {/* SIDEBAR */}
        <aside className="rounded-2xl border border-slate-200/70 bg-white shadow-soft p-3 space-y-4 h-fit">
          {shared.length > 0 && (
            <ListSection
              icon={<Users className="w-3.5 h-3.5 text-fuchsia-500" />}
              label="Shared"
            >
              {shared.map((l) => (
                <ListRow
                  key={l.id}
                  list={l}
                  active={l.id === activeId}
                  onClick={() => setActiveId(l.id)}
                />
              ))}
            </ListSection>
          )}

          <ListSection
            icon={<Crown className="w-3.5 h-3.5 text-amber-500" />}
            label="Mine"
            action={
              <button
                type="button"
                onClick={() => { setNewListTitle(""); setNewListOpen(true); }}
                className="inline-flex items-center gap-0.5 text-[10px] text-accent hover:text-accent/80 font-medium"
                title="Add a new list"
              >
                <Plus className="w-3 h-3" />
                New
              </button>
            }
          >
            {myLists.map((l) => (
              <ListRow
                key={l.id}
                list={l}
                active={l.id === activeId}
                onClick={() => setActiveId(l.id)}
                onDelete={l.kind === "custom" ? () => requestDeleteList(l) : undefined}
              />
            ))}
          </ListSection>

          {otherLeaderLists.map(({ leader, lists: theirLists }) => (
            <ListSection
              key={leader.id}
              icon={
                <PersonAvatar
                  userId={leader.id}
                  name={leader.name}
                  imageUrl={leader.avatarUrl}
                  size={16}
                />
              }
              label={leader.name}
            >
              {theirLists.map((l) => (
                <ListRow
                  key={l.id}
                  list={l}
                  active={l.id === activeId}
                  onClick={() => setActiveId(l.id)}
                />
              ))}
            </ListSection>
          ))}
        </aside>

        {/* MAIN PANE */}
        <main className="rounded-2xl border border-slate-200/70 bg-white shadow-soft overflow-hidden flex flex-col min-h-[480px]">
          {!active ? (
            <div className="p-8 text-center text-sm text-ink/55 flex-1 flex items-center justify-center">
              {lists === null ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Loading lists…
                </span>
              ) : (
                "Pick a list to the left, or create a new one."
              )}
            </div>
          ) : (
            <>
              <header className="px-5 py-4 border-b border-slate-100 flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl grid place-items-center bg-gradient-to-br from-indigo-100 to-blue-100 ring-1 ring-blue-200/60 text-blue-700">
                  <ListIcon kind={active.kind} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-base font-semibold truncate">{active.title}</div>
                  <div className="text-[11px] text-ink/55">
                    {ownerLabel} · {active.openCount} open · {active.doneCount} done
                  </div>
                </div>
              </header>

              <form
                onSubmit={(e) => { e.preventDefault(); addItem(); }}
                className="px-5 py-3 border-b border-slate-100 flex items-center gap-2 bg-slate-50/40"
              >
                <Plus className="w-4 h-4 text-ink/45 shrink-0" />
                <input
                  ref={newItemRef}
                  value={newItemText}
                  onChange={(e) => setNewItemText(e.target.value)}
                  placeholder="Add a todo…"
                  className="flex-1 bg-transparent text-sm outline-none placeholder:text-ink/40"
                  disabled={busy}
                />
                {newItemText.trim() && (
                  <button
                    type="submit"
                    disabled={busy}
                    className="text-[11px] font-semibold text-accent hover:text-accent/80 disabled:opacity-60"
                  >
                    {busy ? "Adding…" : "Add"}
                  </button>
                )}
              </form>

              {items === null ? (
                <div className="p-8 text-center text-sm text-ink/55 flex-1 flex items-center justify-center">
                  <Loader2 className="w-4 h-4 animate-spin mr-1.5" />
                  Loading…
                </div>
              ) : items.length === 0 ? (
                <div className="p-8 text-center text-sm text-ink/55 flex-1 flex items-center justify-center italic">
                  No items yet. Add one above.
                </div>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {items.map((item) => (
                    <TodoRow
                      key={item.id}
                      item={item}
                      onToggle={() => toggleDone(item)}
                      onDelete={() => deleteItem(item)}
                      onEdit={(c) => editItem(item, c)}
                    />
                  ))}
                </ul>
              )}
            </>
          )}
        </main>
      </div>

      {/* New-list dialog — replaces window.prompt() */}
      <Dialog.Root open={newListOpen} onOpenChange={setNewListOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/60 z-40" />
          <Dialog.Content
            aria-describedby={undefined}
            className="fixed inset-0 z-50 outline-none pointer-events-none flex items-center justify-center px-4 lg:pl-[264px]"
          >
            <div className="pointer-events-auto w-[440px] max-w-[92vw] card p-5 space-y-4">
              <div className="flex items-start justify-between">
                <div>
                  <Dialog.Title className="text-base font-medium">New list</Dialog.Title>
                  <p className="text-xs text-muted mt-0.5">Pick a name. You can rename it anytime.</p>
                </div>
                <Dialog.Close className="btn p-1.5"><X className="w-3.5 h-3.5" /></Dialog.Close>
              </div>
              <input
                autoFocus
                value={newListTitle}
                onChange={(e) => setNewListTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); void createList(); }
                }}
                className="input"
                placeholder="e.g. Q3 marketing ideas"
              />
              <div className="flex items-center justify-end gap-2">
                <Dialog.Close className="btn">Cancel</Dialog.Close>
                <button
                  type="button"
                  onClick={createList}
                  disabled={!newListTitle.trim()}
                  className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Create list
                </button>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Delete-list confirm — replaces window.confirm() */}
      <Dialog.Root open={deleteTarget !== null} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/60 z-40" />
          <Dialog.Content
            aria-describedby={undefined}
            className="fixed inset-0 z-50 outline-none pointer-events-none flex items-center justify-center px-4 lg:pl-[264px]"
          >
            <div className="pointer-events-auto w-[440px] max-w-[92vw] card p-5 space-y-4">
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-lg bg-rose-100 border border-rose-200 grid place-items-center text-rose-600">
                  <Trash2 className="w-4 h-4" />
                </div>
                <div className="flex-1">
                  <Dialog.Title className="text-base font-medium">Delete list?</Dialog.Title>
                  <p className="text-sm text-muted mt-1">
                    <span className="font-medium text-ink">{deleteTarget?.title}</span> and all of its items will be removed. This can't be undone.
                  </p>
                </div>
              </div>
              <div className="flex items-center justify-end gap-2">
                <Dialog.Close className="btn">Cancel</Dialog.Close>
                <button
                  type="button"
                  onClick={confirmDeleteList}
                  className="btn-danger"
                >
                  Delete list
                </button>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

function ListSection({
  icon, label, action, children
}: {
  icon: React.ReactNode;
  label: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center justify-between px-2 py-1 mb-1">
        <div className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wide font-semibold text-ink/55">
          {icon}
          {label}
        </div>
        {action}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function ListRow({
  list, active, onClick, onDelete
}: {
  list: TodoList;
  active: boolean;
  onClick: () => void;
  onDelete?: () => void;
}) {
  return (
    <div
      className={cn(
        "group relative rounded-lg flex items-center gap-2 px-2 py-1.5 cursor-pointer transition-colors",
        active ? "bg-accent/10" : "hover:bg-slate-50"
      )}
      onClick={onClick}
    >
      <ListIcon kind={list.kind} />
      <div className="min-w-0 flex-1">
        <div className={cn(
          "text-[13px] truncate",
          active ? "font-semibold text-accent" : "text-ink"
        )}>
          {list.title}
        </div>
      </div>
      {list.openCount > 0 && (
        <span className={cn(
          "text-[10px] font-bold tabular-nums px-1.5 py-0.5 rounded-full",
          active ? "bg-accent text-white" : "bg-slate-100 text-ink/65"
        )}>
          {list.openCount}
        </span>
      )}
      {onDelete && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="opacity-0 group-hover:opacity-100 text-ink/45 hover:text-rose-600 transition-opacity"
          title="Delete list"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}

function ListIcon({ kind }: { kind: TodoList["kind"] }) {
  if (kind === "today") return <Sparkles className="w-3.5 h-3.5 text-amber-500 shrink-0" />;
  if (kind === "longterm") return <ListChecks className="w-3.5 h-3.5 text-blue-500 shrink-0" />;
  if (kind === "shared") return <Users className="w-3.5 h-3.5 text-fuchsia-500 shrink-0" />;
  return <ListChecks className="w-3.5 h-3.5 text-ink/55 shrink-0" />;
}

function TodoRow({
  item, onToggle, onDelete, onEdit
}: {
  item: TodoItem;
  onToggle: () => void;
  onDelete: () => void;
  onEdit: (content: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.content);
  useEffect(() => { setDraft(item.content); }, [item.content]);

  return (
    <li className="group px-5 py-2.5 flex items-center gap-3 hover:bg-slate-50/60 transition-colors">
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          "w-5 h-5 rounded-md border-2 grid place-items-center transition-all shrink-0",
          item.done
            ? "bg-emerald-500 border-emerald-500 text-white"
            : "border-slate-300 hover:border-accent"
        )}
        title={item.done ? "Mark not done" : "Mark done"}
      >
        {item.done && <Check className="w-3 h-3" strokeWidth={3} />}
      </button>
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => { onEdit(draft); setEditing(false); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") { (e.target as HTMLInputElement).blur(); }
            if (e.key === "Escape") { setDraft(item.content); setEditing(false); }
          }}
          className="flex-1 bg-white border border-slate-200 rounded px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-accent/30"
        />
      ) : (
        <div
          className={cn(
            "flex-1 text-sm cursor-text",
            item.done && "line-through text-ink/45"
          )}
          onDoubleClick={() => setEditing(true)}
        >
          {item.content}
        </div>
      )}
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="opacity-0 group-hover:opacity-100 text-ink/45 hover:text-accent transition-opacity"
        title="Edit"
      >
        <Edit2 className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        onClick={onDelete}
        className="opacity-0 group-hover:opacity-100 text-ink/45 hover:text-rose-600 transition-opacity"
        title="Delete"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </li>
  );
}

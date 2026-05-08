import Link from "next/link";
import { notFound } from "next/navigation";
import { Briefcase, Globe2, Calendar, FileText, Lightbulb, ExternalLink, ListChecks } from "lucide-react";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getClient, getResourcesForClient, type ClientResource } from "@/lib/clients-data";
import { BackPill } from "@/components/BackPill";
import { AddResourceForm, DeleteResourceButton } from "@/components/AddResourceForm";

export const dynamic = "force-dynamic";

const PRIORITY_TONES = {
  high:   "bg-blue-100 text-blue-700 border-blue-200/60",
  medium: "bg-indigo-100 text-indigo-700 border-indigo-200/60",
  low:    "bg-slate-100 text-slate-600 border-slate-200/60"
} as const;

export default async function ClientDetailPage({ params }: { params: { id: string } }) {
  const client = await getClient(params.id);
  if (!client) notFound();

  const [resources, openTasks] = await Promise.all([
    getResourcesForClient(client.id),
    // Tasks linked to this client by free-text name match. Limited to non-done.
    getSupabaseAdmin()
      .from("tasks")
      .select("id, title, status, priority, due_date")
      .eq("client_name", client.name)
      .neq("status", "done")
      .order("due_date", { ascending: true })
      .limit(20)
      .then((r) => r.data ?? [])
  ]);

  const meetings    = resources.filter((r) => r.kind === "meeting");
  const documents   = resources.filter((r) => r.kind === "document");
  const suggestions = resources.filter((r) => r.kind === "suggestion");

  return (
    <div className="space-y-5 max-w-5xl mx-auto">
      <BackPill href="/clients" label="Clients" />

      <header
        className="relative overflow-hidden rounded-2xl border border-white/60 shadow-soft p-5"
        style={{ background: "linear-gradient(120deg, #DBEAFE 0%, #C7D2FE 50%, #C7D2FE 100%)" }}
      >
        <div className="relative flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl bg-white/70 border border-white/80 grid place-items-center text-indigo-600 shadow-sm">
              <Briefcase className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-xl font-semibold">{client.name}</h1>
                <span className={`text-[10px] px-2 py-0.5 rounded-full border capitalize ${PRIORITY_TONES[client.priority]}`}>
                  {client.priority} priority
                </span>
              </div>
              {client.website && (
                <a
                  href={client.website.startsWith("http") ? client.website : `https://${client.website}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-ink/60 inline-flex items-center gap-1 mt-1 hover:text-accent"
                >
                  <Globe2 className="w-3 h-3" /> {client.website}
                </a>
              )}
              {client.notes && (
                <p className="text-sm text-ink/70 mt-2 max-w-2xl">{client.notes}</p>
              )}
            </div>
          </div>
        </div>
        <div
          aria-hidden
          className="absolute -top-10 right-12 w-32 h-32 rounded-full pointer-events-none"
          style={{ background: "radial-gradient(circle, rgba(99,102,241,0.18), transparent 70%)" }}
        />
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Section
          title="Meeting links"
          icon={<Calendar className="w-4 h-4" />}
          tone="blue"
          empty="No meeting links yet."
          add={<AddResourceForm clientId={client.id} kind="meeting" />}
          items={meetings}
          renderItem={(r) => (
            <ResourceRow
              key={r.id}
              clientId={client.id}
              resource={r}
              icon={<Calendar className="w-3.5 h-3.5 text-blue-600" />}
              tone="blue"
            />
          )}
        />

        <Section
          title="Documents"
          icon={<FileText className="w-4 h-4" />}
          tone="indigo"
          empty="No documents yet."
          add={<AddResourceForm clientId={client.id} kind="document" />}
          items={documents}
          renderItem={(r) => (
            <ResourceRow
              key={r.id}
              clientId={client.id}
              resource={r}
              icon={<FileText className="w-3.5 h-3.5 text-indigo-600" />}
              tone="indigo"
            />
          )}
        />
      </div>

      <Section
        title="Suggestions & notes"
        icon={<Lightbulb className="w-4 h-4" />}
        tone="violet"
        empty="No suggestions yet."
        add={<AddResourceForm clientId={client.id} kind="suggestion" />}
        items={suggestions}
        renderItem={(r) => (
          <SuggestionRow
            key={r.id}
            clientId={client.id}
            resource={r}
          />
        )}
      />

      <Section
        title="Open tasks"
        icon={<ListChecks className="w-4 h-4" />}
        tone="purple"
        empty="No open tasks linked to this client."
        items={openTasks as { id: string; title: string; status: string; priority: string; due_date: string | null }[]}
        renderItem={(t) => (
          <Link
            key={t.id}
            href={`/tasks/${t.id}`}
            className="group flex items-center gap-2 p-2.5 rounded-xl bg-white/80 border border-white/70 hover:border-blue-200 hover:bg-blue-50/40 transition-colors"
          >
            <div className="text-sm flex-1 truncate group-hover:text-accent">{t.title}</div>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 border border-indigo-200/60 capitalize">
              {t.status.replace("_", " ")}
            </span>
          </Link>
        )}
      />
    </div>
  );
}

// Generic colored section card. Each tone matches one of our four
// blue→purple flavors; passing different tones differentiates the
// resource categories visually.
function Section<T>({
  title, icon, tone, empty, items, add, renderItem
}: {
  title: string;
  icon: React.ReactNode;
  tone: "blue" | "indigo" | "violet" | "purple";
  empty: string;
  items: T[];
  add?: React.ReactNode;
  renderItem: (item: T) => React.ReactNode;
}) {
  const TONES = {
    blue:   { bg: "from-blue-50/60 to-white",     dot: "bg-blue-500" },
    indigo: { bg: "from-indigo-50/60 to-white",   dot: "bg-indigo-500" },
    violet: { bg: "from-indigo-50/60 to-white",   dot: "bg-indigo-500" },
    purple: { bg: "from-blue-50/60 to-white",   dot: "bg-blue-500" }
  } as const;
  const t = TONES[tone];
  return (
    <section className={`rounded-2xl border border-white/60 shadow-soft bg-gradient-to-br ${t.bg} p-4 space-y-3`}>
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${t.dot}`} />
          <div className="text-sm font-semibold inline-flex items-center gap-1.5">
            {icon} {title}
          </div>
          <span className="text-xs text-muted">· {items.length}</span>
        </div>
        {add}
      </header>
      {items.length === 0 ? (
        <div className="text-xs text-muted italic px-1">{empty}</div>
      ) : (
        <div className="space-y-1.5">
          {items.map(renderItem)}
        </div>
      )}
    </section>
  );
}

function ResourceRow({
  clientId, resource, icon
}: {
  clientId: string;
  resource: ClientResource;
  icon: React.ReactNode;
  tone: "blue" | "indigo";
}) {
  return (
    <div className="group flex items-center gap-2 p-2.5 rounded-xl bg-white/80 border border-white/70 hover:border-indigo-200 transition-colors">
      <div className="shrink-0">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium truncate">{resource.title}</div>
        {resource.url && (
          <a
            href={resource.url.startsWith("http") ? resource.url : `https://${resource.url}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] text-ink/60 truncate inline-flex items-center gap-1 hover:text-accent"
          >
            <ExternalLink className="w-3 h-3" /> {resource.url}
          </a>
        )}
      </div>
      <DeleteResourceButton clientId={clientId} resourceId={resource.id} />
    </div>
  );
}

function SuggestionRow({
  clientId, resource
}: { clientId: string; resource: ClientResource }) {
  return (
    <div className="group rounded-xl bg-white/80 border border-white/70 p-3 hover:border-indigo-200 transition-colors">
      <div className="flex items-start gap-2">
        <Lightbulb className="w-3.5 h-3.5 text-indigo-600 shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{resource.title}</div>
          {resource.body && (
            <div className="text-xs text-ink/60 mt-1 whitespace-pre-wrap">{resource.body}</div>
          )}
        </div>
        <DeleteResourceButton clientId={clientId} resourceId={resource.id} />
      </div>
    </div>
  );
}

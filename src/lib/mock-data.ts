import type {
  User, Department, Task, Project, Milestone, RACIEntry,
  IncidentLog, SkillProfile, ActivityLog
} from "./types";

const NOW = Date.now();
const hoursAgo = (h: number) => new Date(NOW - h * 36e5).toISOString();
const daysAhead = (d: number) => new Date(NOW + d * 86400000).toISOString();

export const departments: Department[] = [
  {
    id: "dep_seo",
    name: "SEO",
    description: "Organic growth, on-page, technical SEO, link building.",
    taskTypes: ["keyword research", "on-page audit", "backlink outreach", "technical seo", "schema markup"]
  },
  {
    id: "dep_web",
    name: "Website",
    description: "Site builds, CMS, content, performance, hosting.",
    taskTypes: ["new page build", "bug fix", "site migration", "performance tuning", "form integration", "cms update"]
  },
  {
    id: "dep_software",
    name: "Software",
    description: "Internal tools, custom apps, integrations, automation.",
    taskTypes: ["feature build", "api integration", "bug fix", "refactor", "deploy", "internal tool"]
  },
  {
    id: "dep_mkt",
    name: "Marketing",
    description: "Paid ads, email, content strategy, social.",
    taskTypes: ["ad campaign setup", "email sequence", "blog post", "social calendar", "landing page copy"]
  }
];

// Henry (henry@scaledai.org) is the Leader.
// Priya heads SEO. Diego heads Website AND Software. Sara heads Marketing.
// Workers report to their department head; heads report to the Leader.
export const users: User[] = [
  {
    id: "u_1", name: "Shaheer Khosa", email: "shaheerkhosa6@gmail.com",
    role: "leader", departmentIds: [],
    skills: ["strategy", "operations"], dailyCapacity: 8, throughput: {}
  },
  {
    id: "u_2", name: "Priya Sharma", email: "priya@scaledai.org",
    role: "department_head", departmentIds: ["dep_seo"],
    skills: ["technical seo", "audits", "schema"], dailyCapacity: 8, throughput: { audits_per_day: 2, insurance_pages_per_day: 10 }
  },
  {
    id: "u_3", name: "Marcus Lee", email: "marcus@scaledai.org",
    role: "worker", departmentIds: ["dep_seo"],
    skills: ["link building", "outreach"], dailyCapacity: 7, throughput: { outreach_emails_per_day: 30 }
  },
  {
    id: "u_4", name: "Sara Okafor", email: "sara@scaledai.org",
    role: "department_head", departmentIds: ["dep_mkt"],
    skills: ["meta ads", "google ads", "copy"], dailyCapacity: 8, throughput: { ad_creatives_per_day: 6 }
  },
  {
    id: "u_5", name: "Diego Martín", email: "diego@scaledai.org",
    role: "department_head", departmentIds: ["dep_web", "dep_software"],
    skills: ["wordpress", "react", "next.js", "node", "css"], dailyCapacity: 8, throughput: { pages_per_day: 5 }
  },
  {
    id: "u_6", name: "Aisha Rahman", email: "aisha@scaledai.org",
    role: "worker", departmentIds: ["dep_mkt"],
    skills: ["email", "lifecycle"], dailyCapacity: 6, throughput: { emails_per_day: 8 }
  },
  {
    id: "u_7", name: "Theo Park", email: "theo@scaledai.org",
    role: "worker", departmentIds: ["dep_web"],
    skills: ["wordpress", "html", "css"], dailyCapacity: 8, throughput: { pages_per_day: 4 }
  },
  {
    id: "u_8", name: "Nadia Volkova", email: "nadia@scaledai.org",
    role: "worker", departmentIds: ["dep_software"],
    skills: ["typescript", "next.js", "prisma"], dailyCapacity: 8, throughput: { features_per_week: 3 }
  },
  {
    id: "u_9", name: "Jamal Reed", email: "jamal@scaledai.org",
    role: "worker", departmentIds: ["dep_seo"],
    skills: ["content", "keyword research"], dailyCapacity: 7, throughput: { briefs_per_day: 4 }
  },
  {
    id: "u_10", name: "Mitchell Price", email: "mitchell@scaledai.org",
    role: "worker", departmentIds: ["dep_software"],
    skills: ["typescript", "react"], dailyCapacity: 8, throughput: { features_per_week: 3 }
  }
];

export const CURRENT_USER_ID = "u_1";
export const currentUser = users.find((u) => u.id === CURRENT_USER_ID)!;

export const projects: Project[] = [
  { id: "p_1", name: "Acme Insurance Site Refresh", description: "End-to-end rebuild of acme-insurance.com on Next.js with location pages.", departmentId: "dep_web" },
  { id: "p_2", name: "Q3 SEO Push — Lawsmith Group", description: "Programmatic location pages and authority backlinks.", departmentId: "dep_seo" },
  { id: "p_3", name: "Spring Lifecycle Campaign", description: "Activation + retention email arc.", departmentId: "dep_mkt" },
  { id: "p_4", name: "Scaled Operations (internal)", description: "This very tool. Built by Software.", departmentId: "dep_software" }
];

export const milestones: Milestone[] = [
  { id: "m_1", projectId: "p_1", name: "Design lock", dueDate: daysAhead(-3), deliverables: ["Figma sign-off", "Brand guide"], status: "done" },
  { id: "m_2", projectId: "p_1", name: "Templates built", dueDate: daysAhead(7), deliverables: ["5 page templates", "Component library"], status: "in_progress" },
  { id: "m_3", projectId: "p_1", name: "Launch", dueDate: daysAhead(28), deliverables: ["DNS cutover", "301 map", "GSC verification"], status: "pending" },
  { id: "m_4", projectId: "p_2", name: "Keyword map", dueDate: daysAhead(2), deliverables: ["1000 keywords", "Cluster doc"], status: "in_progress" },
  { id: "m_5", projectId: "p_2", name: "First 50 pages live", dueDate: daysAhead(14), deliverables: ["50 location pages indexed"], status: "pending" },
  { id: "m_6", projectId: "p_3", name: "Welcome series", dueDate: daysAhead(5), deliverables: ["6 emails", "Triggers"], status: "in_progress" },
  { id: "m_7", projectId: "p_4", name: "v1 internal launch", dueDate: daysAhead(10), deliverables: ["Auth", "Tasks", "Board"], status: "in_progress" }
];

export const tasks: Task[] = [
  {
    id: "t_1", title: "Build /locations/[city] template", description: "Programmatic template w/ schema, FAQ, internal links. Lighthouse 90+.",
    status: "in_progress", priority: "high", estimatedHours: 6, actualHours: 2.5,
    tags: ["story", "performance"], departmentId: "dep_web", assigneeId: "u_5", creatorId: "u_1",
    projectId: "p_1", dueDate: daysAhead(2), inactiveFlag: false,
    lastActivityAt: hoursAgo(3), createdAt: hoursAgo(30), blocksTaskIds: ["t_5", "t_6"]
  },
  {
    id: "t_2", title: "Site down — acme-insurance.com 502s",
    description: "Cloudflare reporting bad gateway intermittently. Affecting checkout flow.",
    status: "urgent", priority: "critical", estimatedHours: 2, actualHours: 0.5,
    tags: ["urgent", "client-request"], departmentId: "dep_web", assigneeId: "u_7", creatorId: "u_5",
    projectId: null, dueDate: daysAhead(0), inactiveFlag: false,
    lastActivityAt: hoursAgo(1), createdAt: hoursAgo(2), blocksTaskIds: []
  },
  {
    id: "t_3", title: "Schema markup audit — Lawsmith Group",
    description: "Run sitewide audit, identify pages missing FAQPage / LocalBusiness schema.",
    status: "pending", priority: "medium", estimatedHours: 4, actualHours: 0,
    tags: ["day-task"], departmentId: "dep_seo", assigneeId: "u_9", creatorId: "u_2",
    projectId: "p_2", dueDate: daysAhead(3), inactiveFlag: false,
    lastActivityAt: hoursAgo(8), createdAt: hoursAgo(8), blocksTaskIds: []
  },
  {
    id: "t_4", title: "10 location pages — insurance vertical",
    description: "Pittsburgh, Cincinnati, St Louis, Cleveland, Indianapolis, Columbus, Buffalo, Rochester, Hartford, Providence.",
    status: "in_progress", priority: "medium", estimatedHours: 8, actualHours: 3,
    tags: ["story"], departmentId: "dep_seo", assigneeId: "u_3", creatorId: "u_2",
    projectId: "p_2", dueDate: daysAhead(5), inactiveFlag: false,
    lastActivityAt: hoursAgo(60), createdAt: hoursAgo(80), blocksTaskIds: []
  },
  {
    id: "t_5", title: "Wire contact form to HubSpot", description: "Forms submit to /api/lead and forward to HubSpot. Validate spam.",
    status: "waiting_on_client", priority: "medium", estimatedHours: 3, actualHours: 1,
    tags: ["client-request"], departmentId: "dep_web", assigneeId: "u_7", creatorId: "u_5",
    projectId: "p_1", dueDate: daysAhead(4), inactiveFlag: true,
    lastActivityAt: hoursAgo(72), createdAt: hoursAgo(120), blocksTaskIds: []
  },
  {
    id: "t_6", title: "QA pass on templates",
    description: "Cross-browser, mobile, a11y. Document defects in Linear.",
    status: "pending", priority: "low", estimatedHours: 4, actualHours: 0,
    tags: ["day-task"], departmentId: "dep_web", assigneeId: null, creatorId: "u_5",
    projectId: "p_1", dueDate: daysAhead(10), inactiveFlag: false,
    lastActivityAt: hoursAgo(20), createdAt: hoursAgo(20), blocksTaskIds: []
  },
  {
    id: "t_7", title: "Welcome email #3 copy",
    description: "Tone: warm + product-led. CTA to onboarding video.",
    status: "in_progress", priority: "medium", estimatedHours: 2, actualHours: 0.5,
    tags: ["story"], departmentId: "dep_mkt", assigneeId: "u_6", creatorId: "u_4",
    projectId: "p_3", dueDate: daysAhead(1), inactiveFlag: false,
    lastActivityAt: hoursAgo(4), createdAt: hoursAgo(48), blocksTaskIds: []
  },
  {
    id: "t_8", title: "Meta ads — Spring promo creatives",
    description: "6 creatives, 2 angles. Hook test.",
    status: "pending", priority: "high", estimatedHours: 5, actualHours: 0,
    tags: ["story"], departmentId: "dep_mkt", assigneeId: "u_4", creatorId: "u_1",
    projectId: "p_3", dueDate: daysAhead(2), inactiveFlag: false,
    lastActivityAt: hoursAgo(10), createdAt: hoursAgo(10), blocksTaskIds: []
  },
  {
    id: "t_9", title: "Outreach — 30 prospect domains for Lawsmith",
    description: "Build prospect list, score by DR, send first-touch.",
    status: "in_progress", priority: "medium", estimatedHours: 3, actualHours: 1.5,
    tags: ["day-task"], departmentId: "dep_seo", assigneeId: "u_3", creatorId: "u_2",
    projectId: "p_2", dueDate: daysAhead(2), inactiveFlag: false,
    lastActivityAt: hoursAgo(6), createdAt: hoursAgo(50), blocksTaskIds: []
  },
  {
    id: "t_10", title: "Migrate hosting from Pantheon to Vercel",
    description: "Plan, dry run, cutover window. Coordinate with client.",
    status: "done", priority: "high", estimatedHours: 10, actualHours: 11,
    tags: ["story"], departmentId: "dep_web", assigneeId: "u_5", creatorId: "u_1",
    projectId: "p_1", dueDate: daysAhead(-2), inactiveFlag: false,
    lastActivityAt: hoursAgo(48), createdAt: hoursAgo(240), blocksTaskIds: []
  },
  {
    id: "t_11", title: "Ship Scaled Operations v1",
    description: "Internal release of the org's task tool. Auth, tasks, board, focus mode.",
    status: "in_progress", priority: "high", estimatedHours: 16, actualHours: 8,
    tags: ["story", "internal"], departmentId: "dep_software", assigneeId: "u_8", creatorId: "u_5",
    projectId: "p_4", dueDate: daysAhead(7), inactiveFlag: false,
    lastActivityAt: hoursAgo(2), createdAt: hoursAgo(120), blocksTaskIds: []
  },
  {
    id: "t_12", title: "Critical: malware flag on lawsmith.com",
    description: "Google Safe Browsing flagging — investigate, clean, request review.",
    status: "urgent", priority: "critical", estimatedHours: 4, actualHours: 0.5,
    tags: ["urgent"], departmentId: "dep_web", assigneeId: "u_5", creatorId: "u_2",
    projectId: null, dueDate: daysAhead(0), inactiveFlag: false,
    lastActivityAt: hoursAgo(2), createdAt: hoursAgo(2), blocksTaskIds: []
  },
  {
    id: "t_13", title: "Slack ↔ task sync integration",
    description: "Post a thread in #ops when a task flips to urgent.",
    status: "pending", priority: "medium", estimatedHours: 6, actualHours: 0,
    tags: ["story", "internal"], departmentId: "dep_software", assigneeId: "u_8", creatorId: "u_1",
    projectId: "p_4", dueDate: daysAhead(9), inactiveFlag: false,
    lastActivityAt: hoursAgo(14), createdAt: hoursAgo(14), blocksTaskIds: []
  }
];

export const raciEntries: RACIEntry[] = [
  { id: "r_1", projectId: "p_1", userId: "u_5", area: "Templates", role: "responsible" },
  { id: "r_2", projectId: "p_1", userId: "u_7", area: "Templates", role: "consulted" },
  { id: "r_3", projectId: "p_1", userId: "u_2", area: "SEO migration", role: "accountable" },
  { id: "r_4", projectId: "p_1", userId: "u_4", area: "SEO migration", role: "informed" },
  { id: "r_5", projectId: "p_1", userId: "u_5", area: "DNS cutover", role: "responsible" },
  { id: "r_6", projectId: "p_1", userId: "u_1", area: "DNS cutover", role: "accountable" },
  { id: "r_7", projectId: "p_2", userId: "u_2", area: "Keyword strategy", role: "accountable" },
  { id: "r_8", projectId: "p_2", userId: "u_3", area: "Outreach", role: "responsible" },
  { id: "r_9", projectId: "p_2", userId: "u_2", area: "Outreach", role: "consulted" }
];

export const incidents: IncidentLog[] = [
  { id: "i_1", issueType: "site down", affectedUrl: "acme-insurance.com", description: "502 Bad Gateway intermittently.", assignedToId: "u_7", resolutionNotes: null, resolvedAt: null, createdAt: hoursAgo(2) },
  { id: "i_2", issueType: "malware", affectedUrl: "lawsmith.com", description: "Google Safe Browsing flag.", assignedToId: "u_5", resolutionNotes: null, resolvedAt: null, createdAt: hoursAgo(2) },
  { id: "i_3", issueType: "form broken", affectedUrl: "acme-insurance.com/contact", description: "Submissions silently failing.", assignedToId: "u_7", resolutionNotes: "HubSpot API key rotated; updated env var; deployed.", resolvedAt: hoursAgo(96), createdAt: hoursAgo(120) },
  { id: "i_4", issueType: "site down", affectedUrl: "lawsmith.com", description: "Outage during maintenance window.", assignedToId: "u_5", resolutionNotes: "Pantheon DB connection pool exhausted; bumped tier.", resolvedAt: hoursAgo(200), createdAt: hoursAgo(220) },
  { id: "i_5", issueType: "site down", affectedUrl: "acme-insurance.com", description: "Cloudflare 522.", assignedToId: "u_5", resolutionNotes: "Origin upstream timeout; raised origin keep-alive.", resolvedAt: hoursAgo(340), createdAt: hoursAgo(360) }
];

export const skillProfiles: SkillProfile[] = [
  { id: "s_1", userId: "u_1", skillName: "strategy", experienceLevel: 5, taskTypes: [] },
  { id: "s_2", userId: "u_5", skillName: "next.js", experienceLevel: 5, taskTypes: ["new page build", "performance tuning", "feature build"] },
  { id: "s_3", userId: "u_5", skillName: "wordpress", experienceLevel: 4, taskTypes: ["cms update", "bug fix"] },
  { id: "s_4", userId: "u_2", skillName: "technical seo", experienceLevel: 5, taskTypes: ["on-page audit", "schema markup", "technical seo"] },
  { id: "s_5", userId: "u_3", skillName: "link building", experienceLevel: 4, taskTypes: ["backlink outreach"] },
  { id: "s_6", userId: "u_4", skillName: "meta ads", experienceLevel: 5, taskTypes: ["ad campaign setup"] },
  { id: "s_7", userId: "u_7", skillName: "wordpress", experienceLevel: 4, taskTypes: ["new page build", "bug fix", "cms update"] },
  { id: "s_8", userId: "u_8", skillName: "typescript", experienceLevel: 5, taskTypes: ["feature build", "refactor", "api integration"] },
  { id: "s_9", userId: "u_6", skillName: "email", experienceLevel: 4, taskTypes: ["email sequence"] },
  { id: "s_10", userId: "u_9", skillName: "content", experienceLevel: 3, taskTypes: ["blog post"] }
];

export const activity: ActivityLog[] = [
  { id: "a_1", taskId: "t_1", userId: "u_1", action: "created", detail: "Created and assigned to Diego (Website lead)", createdAt: hoursAgo(30) },
  { id: "a_2", taskId: "t_1", userId: "u_5", action: "status_change", detail: "pending → in_progress", createdAt: hoursAgo(28) },
  { id: "a_3", taskId: "t_1", userId: "u_5", action: "comment", detail: "First template scaffolded; FAQ schema next.", createdAt: hoursAgo(3) },
  { id: "a_4", taskId: "t_2", userId: "u_5", action: "created", detail: "Reported by Diego from monitoring", createdAt: hoursAgo(2) },
  { id: "a_5", taskId: "t_2", userId: "u_7", action: "status_change", detail: "pending → urgent", createdAt: hoursAgo(1) },
  { id: "a_6", taskId: "t_5", userId: "u_7", action: "status_change", detail: "in_progress → waiting_on_client", createdAt: hoursAgo(72) },
  { id: "a_7", taskId: "t_11", userId: "u_5", action: "comment", detail: "Auth flows wrapped, working on tasks API next.", createdAt: hoursAgo(2) }
];

export const incidentRouting: Record<string, string> = {
  "site down": "u_7",
  "malware": "u_5",
  "form broken": "u_7",
  "other": "u_1"
};

export const TAG_PRESETS = ["day-task", "story", "urgent", "client-request", "performance", "a11y", "internal"];

// Backfill client/website on the seeded tasks to match the Supabase migration.
// Heuristic: derive from projectId; specific overrides for project-less tasks.
const CLIENT_BY_PROJECT: Record<string, { clientName: string | null; website: string | null }> = {
  p_1: { clientName: "Acme Insurance",       website: "acme-insurance.com" },
  p_2: { clientName: "Lawsmith Group",       website: "lawsmith.com" },
  p_3: { clientName: "Spring Lifecycle Co",  website: "spring-lifecycle.com" },
  p_4: { clientName: null,                   website: null }
};
const TICKET_OVERRIDES: Record<string, { clientName: string | null; website: string | null }> = {
  t_2:  { clientName: "Acme Insurance", website: "acme-insurance.com" },
  t_12: { clientName: "Lawsmith Group", website: "lawsmith.com" }
};
for (const t of tasks) {
  const fromProject = t.projectId ? CLIENT_BY_PROJECT[t.projectId] : undefined;
  const override = TICKET_OVERRIDES[t.id];
  const enrich = override ?? fromProject;
  if (enrich) {
    t.clientName = enrich.clientName;
    t.website = enrich.website;
  }
}

export function distinctClients(): string[] {
  return Array.from(new Set(tasks.map((t) => t.clientName).filter(Boolean) as string[])).sort();
}
export function distinctWebsites(): string[] {
  return Array.from(new Set(tasks.map((t) => t.website).filter(Boolean) as string[])).sort();
}

export function userById(id: string | null | undefined): User | undefined {
  return users.find((u) => u.id === id);
}
export function deptById(id: string | null | undefined): Department | undefined {
  return departments.find((d) => d.id === id);
}
export function projectById(id: string | null | undefined): Project | undefined {
  return projects.find((p) => p.id === id);
}
export function taskById(id: string): Task | undefined {
  return tasks.find((t) => t.id === id);
}

// Heads of a given department.
export function headsOf(deptId: string): User[] {
  return users.filter((u) => u.role === "department_head" && u.departmentIds.includes(deptId));
}
// Workers in a given department.
export function workersOf(deptId: string): User[] {
  return users.filter((u) => u.role === "worker" && u.departmentIds.includes(deptId));
}
// Reporting line: a user's direct manager. Workers report to the head(s) of
// their first department; heads report to the Leader; Leader reports to no one.
// Pure: feed in the live users list and get back this user's manager.
// Old callers can still call managerOf(user) and get the mock fallback
// (workspace was demo-seeded), but live callers should pass team.users.
export function managerOf(user: User, allUsers: User[] = users): User | null {
  if (user.role === "leader") return null;
  if (user.role === "department_head") {
    return allUsers.find((u) => u.role === "leader") ?? null;
  }
  const dep = user.departmentIds[0];
  return dep
    ? allUsers.find((u) =>
        u.role === "department_head" && u.departmentIds.includes(dep)
      ) ?? null
    : null;
}

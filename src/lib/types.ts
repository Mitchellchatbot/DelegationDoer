export type Role = "leader" | "department_head" | "worker";
export type TaskStatus = "pending" | "in_progress" | "urgent" | "waiting_on_client" | "done";
export type Priority = "low" | "medium" | "high" | "critical";
export type MilestoneStatus = "pending" | "in_progress" | "done" | "delayed";
export type RaciRole = "responsible" | "accountable" | "consulted" | "informed";

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  // Departments the user belongs to. For workers this is typically one home
  // department. For department_heads, the departments they lead (one or many).
  // For the Leader this can be empty.
  departmentIds: string[];
  skills: string[];
  dailyCapacity: number;
  throughput: Record<string, number>;
  avatarUrl?: string;
  // Stealth admin: passes every leader-equivalent permission gate
  // (canManageTask, canViewTask, etc.) without changing what the UI
  // shows for `role`. Used for a builder who needs full access while
  // appearing as a regular worker. Default false.
  isAdmin?: boolean;
}

export interface Department {
  id: string;
  name: string;
  description: string;
  taskTypes: string[];
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: Priority;
  estimatedHours: number;
  // The "displayed" actual hours: override if set, else derived from the
  // time_entries log. Reads should treat this as the truth.
  actualHours: number;
  // When set, the user has manually pinned actuals (off-clock work or
  // historical backfill) and the time-log sum is ignored. Lets the UI
  // surface "overridden" affordances and offer a clear-override action.
  actualHoursOverride?: number | null;
  tags: string[];
  departmentId: string | null;
  assigneeId: string | null;
  creatorId: string;
  projectId: string | null;
  dueDate: string | null;
  inactiveFlag: boolean;
  lastActivityAt: string;
  createdAt: string;
  blocksTaskIds: string[];
  clientName?: string | null;
  website?: string | null;
  // Notion-style project fields, all optional.
  clientEmail?: string | null;
  clientFolderUrl?: string | null;
  stagingServer?: string | null;
  markupLink?: string | null;
  hostingAccess?: string | null;
  missiveThreadUrl?: string | null;
  // Org-wide custom field values, keyed by field id. Shape per value
  // depends on the matching CustomField.type (string for text/url/date/
  // select, number for number, boolean for checkbox, string[] for
  // multiselect).
  custom?: Record<string, unknown>;
}

// Org-wide custom field definition. Managed in Settings; rendered on the
// new-task form and task detail.
export type CustomFieldType =
  | "text" | "number" | "url" | "date" | "checkbox" | "select" | "multiselect";

export interface CustomFieldOption {
  value: string;
  label: string;
  color?: string;
}

export interface CustomField {
  id: string;
  name: string;
  type: CustomFieldType;
  options: CustomFieldOption[] | null;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  departmentId: string | null;
}

export type ProjectStageStatus = "locked" | "active" | "done";
export type ProjectStageKind =
  | "scope"
  | "architecture"
  | "frontend"
  | "backend"
  | "completed"
  | "custom";

export interface ProjectStage {
  id: string;
  projectId: string;
  position: number;
  name: string;
  kind: ProjectStageKind;
  status: ProjectStageStatus;
  isIt: string[];
  isNot: string[];
  imageUrls: string[];
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface Milestone {
  id: string;
  projectId: string;
  name: string;
  dueDate: string;
  deliverables: string[];
  status: MilestoneStatus;
}

export interface RACIEntry {
  id: string;
  projectId: string;
  userId: string;
  area: string;
  role: RaciRole;
}

export interface IncidentLog {
  id: string;
  issueType: string;
  affectedUrl: string;
  description: string;
  assignedToId: string | null;
  resolutionNotes: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

export interface SkillProfile {
  id: string;
  userId: string;
  skillName: string;
  experienceLevel: number;
  taskTypes: string[];
}

export interface ActivityLog {
  id: string;
  taskId: string;
  userId: string;
  action: string;
  detail: string;
  imageUrl?: string | null;
  createdAt: string;
}

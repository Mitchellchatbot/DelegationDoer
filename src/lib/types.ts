export type Role = "ceo" | "department_head" | "worker";
export type TicketStatus = "pending" | "in_progress" | "urgent" | "waiting_on_client" | "done";
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
  // For the CEO this can be empty.
  departmentIds: string[];
  skills: string[];
  dailyCapacity: number;
  throughput: Record<string, number>;
  avatarUrl?: string;
}

export interface Department {
  id: string;
  name: string;
  description: string;
  taskTypes: string[];
}

export interface Ticket {
  id: string;
  title: string;
  description: string;
  status: TicketStatus;
  priority: Priority;
  estimatedHours: number;
  actualHours: number;
  tags: string[];
  departmentId: string | null;
  assigneeId: string | null;
  creatorId: string;
  projectId: string | null;
  dueDate: string | null;
  inactiveFlag: boolean;
  lastActivityAt: string;
  createdAt: string;
  blocksTicketIds: string[];
  clientName?: string | null;
  website?: string | null;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  departmentId: string | null;
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
  ticketId: string;
  userId: string;
  action: string;
  detail: string;
  imageUrl?: string | null;
  createdAt: string;
}

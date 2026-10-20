import type { Permission } from "@opspilot/core";

export type Role = "tenant_admin" | "agent" | "employee";

export type User = {
  id: string;
  email: string;
  displayName: string;
  isPlatformAdmin: boolean;
};

export type Membership = {
  id: string;
  slug: string;
  name: string;
  role: Role;
  permissions: Permission[];
};

export type Team = { id: string; slug: string; name: string };
export type Category = { id: string; slug: string; name: string; default_team_id: string | null };
export type Priority = { id: string; key: string; label: string; rank: number; color: string };
export type Status = { id: string; key: string; label: string; stage: string; sort_order: number };

export type CustomField = {
  id: string;
  key: string;
  label: string;
  type: "text" | "textarea" | "number" | "date" | "select" | "multiselect" | "checkbox";
  required: boolean;
  visibility: "public" | "internal";
  options: string[];
  applies_to_category_id: string | null;
  sort_order: number;
};

export type Agent = {
  id: string;
  name: string;
  role: Role;
  team_ids: string[];
};

export type RoutingRule = {
  id: string;
  name: string;
  conditions: unknown;
  team_id: string;
  sort_order: number;
  version: number;
};

export type TenantSettings = {
  timezone: string;
  ticket_prefix: string;
  reopen_window_days: number;
  auto_close_days: number;
  branding: Record<string, unknown>;
  config_version: number;
};

export type NotificationTemplate = {
  id: string;
  key: string;
  subject: string;
  body: string;
  is_active: boolean;
  updated_at: string;
};

export type SlaPolicy = {
  id: string;
  name: string;
  priority_id: string | null;
  category_id: string | null;
  response_minutes: number;
  resolution_minutes: number;
  is_active: boolean;
};

export type Config = {
  teams: Team[];
  categories: Category[];
  priorities: Priority[];
  statuses: Status[];
  custom_fields: CustomField[];
  routing_rules: RoutingRule[];
  agents: Agent[];
  settings: TenantSettings | null;
  sla_policies: SlaPolicy[];
};

export type Ticket = {
  tenant_id: string;
  id: string;
  number: string;
  subject: string;
  description: string;
  requester_id: string;
  assignee_id: string | null;
  team_id: string | null;
  category_id: string;
  priority_id: string;
  status_id: string;
  custom_fields: Record<string, unknown>;
  resolution_summary: string | null;
  pending_reason: string | null;
  version: number;
  reopened_count: number;
  first_responded_at: string | null;
  resolved_at: string | null;
  closed_at: string | null;
  sla_policy_id: string | null;
  sla_response_due_at: string | null;
  sla_resolution_due_at: string | null;
  sla_response_breached_at: string | null;
  sla_resolution_breached_at: string | null;
  sla_paused_at: string | null;
  created_at: string;
  updated_at: string;
  status_key: string;
  status_label: string;
  status_stage: string;
  category_name: string;
  priority_key: string;
  priority_label: string;
  priority_rank: number;
  requester_name: string;
  assignee_name: string | null;
  team_name: string | null;
};

export type TicketComment = {
  id: string;
  body: string;
  visibility: "public" | "internal";
  author_name: string;
  created_at: string;
};

export type StatusHistory = {
  created_at: string;
  from_label: string | null;
  to_label: string;
  actor_role: string;
  actor_name: string | null;
  reason: string | null;
};

export type AssignmentHistory = {
  created_at: string;
  actor_role: string;
  actor_name: string | null;
  source: string;
  to_assignee_name: string | null;
  to_team_name: string | null;
};

export type Transition = {
  toStatusId: string;
  key: string;
  label: string;
  stage: string;
  requiresAssignee: boolean;
  requiresSummary: boolean;
  requiresReason: boolean;
};

export type Attachment = {
  id: string;
  filename: string;
  content_type: string;
  size: number;
  uploader_id: string;
  uploader_name: string;
  created_at: string;
};

export type TicketDetail = Ticket & {
  comments: TicketComment[];
  history: StatusHistory[];
  assignments: AssignmentHistory[];
  attachments: Attachment[];
  allowed_transitions: Transition[];
};

export type TicketList = {
  items: Ticket[];
  total: number;
  page: number;
  pageSize: number;
};

export type TenantUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
  is_active: boolean;
  team_ids: string[];
  custom_role_id: string | null;
  custom_role_name: string | null;
  created_at: string;
};

export type CustomRole = {
  id: string;
  name: string;
  base_role: Role;
  permissions: string[];
  member_count: number;
  created_at: string;
};

export type PendingInvitation = {
  id: string;
  email: string;
  role: Role;
  team_ids: string[];
  expires_at: string;
  created_at: string;
};

export type SessionInfo = {
  id: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  user_agent: string | null;
  ip: string | null;
  is_current: boolean;
};

export type InvitationInfo = {
  email: string;
  role: Role;
  tenantName: string;
  tenantSlug: string;
  existingUser: boolean;
};

export type PlatformTenant = {
  id: string;
  slug: string;
  name: string;
  status: "active" | "suspended";
  created_at: string;
  member_count: number;
  ticket_count: number;
  pending_invitations: number;
};

export type ReportBucket = { label: string; count: number };

export type ReportSummary = {
  total: number;
  open: number;
  unassigned: number;
  sla_breached: number;
  resolved_week: number;
  created_period: number;
  avg_resolution_hours: number;
  avg_response_minutes: number;
};

export type ReportTrendPoint = { day: string; created: number; resolved: number };

export type ReportFeedback = {
  rating: number;
  comment: string | null;
  submitted_at: string;
  number: number;
  subject: string;
  requester_name: string;
};

export type Report = {
  periodDays: number;
  summary: ReportSummary;
  by_status: (ReportBucket & { stage: string })[];
  by_priority: (ReportBucket & { color: string })[];
  by_team: ReportBucket[];
  trend: ReportTrendPoint[];
  csat: { average: number; responses: number; comments: number };
  recent_feedback: ReportFeedback[];
};

export type FeedbackInfo = {
  ticketNumber: number;
  ticketSubject: string;
  tenantName: string;
  submitted: boolean;
  rating: number | null;
  comment: string | null;
};

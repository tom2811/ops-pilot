import { z } from "zod";

export const ROLES = ["tenant_admin", "agent", "employee"] as const;
export type Role = (typeof ROLES)[number];

export const STAGES = ["new", "open", "in_progress", "pending", "resolved", "closed"] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  new: "New",
  open: "Open",
  in_progress: "In progress",
  pending: "Pending",
  resolved: "Resolved",
  closed: "Closed",
};

export const DEFAULT_STATUSES: Array<{ key: string; label: string; stage: Stage; sortOrder: number }> = [
  { key: "new", label: "New", stage: "new", sortOrder: 10 },
  { key: "open", label: "Open", stage: "open", sortOrder: 20 },
  { key: "in_progress", label: "In progress", stage: "in_progress", sortOrder: 30 },
  { key: "pending", label: "Pending", stage: "pending", sortOrder: 40 },
  { key: "resolved", label: "Resolved", stage: "resolved", sortOrder: 50 },
  { key: "closed", label: "Closed", stage: "closed", sortOrder: 60 },
];

export const DEFAULT_PRIORITIES: Array<{ key: string; label: string; rank: number; color: string }> = [
  { key: "p1", label: "P1 - Critical", rank: 1, color: "red" },
  { key: "p2", label: "P2 - High", rank: 2, color: "orange" },
  { key: "p3", label: "P3 - Normal", rank: 3, color: "blue" },
  { key: "p4", label: "P4 - Low", rank: 4, color: "gray" },
];

type TransitionSeed = {
  from: string;
  to: string;
  role: Role;
  requiresAssignee?: boolean;
  requiresSummary?: boolean;
  requiresReason?: boolean;
};

export const DEFAULT_TRANSITIONS: TransitionSeed[] = [
  { from: "new", to: "open", role: "agent", requiresAssignee: true },
  { from: "new", to: "open", role: "tenant_admin", requiresAssignee: true },
  { from: "open", to: "in_progress", role: "agent", requiresAssignee: true },
  { from: "open", to: "in_progress", role: "tenant_admin", requiresAssignee: true },
  { from: "open", to: "pending", role: "agent", requiresAssignee: true, requiresReason: true },
  { from: "open", to: "pending", role: "tenant_admin", requiresAssignee: true, requiresReason: true },
  { from: "open", to: "resolved", role: "agent", requiresAssignee: true, requiresSummary: true },
  { from: "open", to: "resolved", role: "tenant_admin", requiresAssignee: true, requiresSummary: true },
  { from: "in_progress", to: "pending", role: "agent", requiresAssignee: true, requiresReason: true },
  { from: "in_progress", to: "pending", role: "tenant_admin", requiresAssignee: true, requiresReason: true },
  { from: "in_progress", to: "resolved", role: "agent", requiresAssignee: true, requiresSummary: true },
  { from: "in_progress", to: "resolved", role: "tenant_admin", requiresAssignee: true, requiresSummary: true },
  { from: "pending", to: "in_progress", role: "agent", requiresAssignee: true },
  { from: "pending", to: "in_progress", role: "tenant_admin", requiresAssignee: true },
  { from: "pending", to: "resolved", role: "agent", requiresAssignee: true, requiresSummary: true },
  { from: "pending", to: "resolved", role: "tenant_admin", requiresAssignee: true, requiresSummary: true },
  { from: "resolved", to: "closed", role: "tenant_admin" },
  { from: "resolved", to: "closed", role: "employee" },
  { from: "resolved", to: "open", role: "employee", requiresReason: true },
  { from: "resolved", to: "open", role: "tenant_admin", requiresReason: true },
  { from: "closed", to: "open", role: "tenant_admin", requiresReason: true },
];

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
});

export const createTicketSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(20000),
  categoryId: z.string().uuid(),
  priorityId: z.string().uuid(),
  customFields: z.record(z.string(), z.unknown()).default({}),
});

export const transitionSchema = z.object({
  toStatusId: z.string().uuid(),
  expectedVersion: z.number().int().nonnegative(),
  reason: z.string().trim().max(2000).optional(),
  resolutionSummary: z.string().trim().max(5000).optional(),
});

export const commentSchema = z.object({
  body: z.string().trim().min(1).max(20000),
  visibility: z.enum(["public", "internal"]).default("public"),
});

export const assignSchema = z.object({
  teamId: z.string().uuid(),
  assigneeId: z.string().uuid().nullable().optional(),
  expectedVersion: z.number().int().nonnegative(),
});

export const automationAssignSchema = assignSchema.omit({ expectedVersion: true }).extend({
  ticketId: z.string().uuid(),
  idempotencyKey: z.string().min(1).max(200),
});

export const routePreviewSchema = z.object({
  categoryId: z.string().uuid(),
  priorityId: z.string().uuid(),
  customFields: z.record(z.string(), z.unknown()).default({}),
});

export const notificationInputSchema = z.object({
  ticketId: z.string().uuid(),
  recipientId: z.string().uuid(),
  channel: z.string().min(1).max(30).default("email"),
  subject: z.string().min(1).max(300),
  body: z.string().min(1).max(20000),
});

export const runCompleteSchema = z.object({
  status: z.enum(["completed", "failed"]),
  error: z.string().max(2000).optional(),
});

export type RoutingCondition =
  | { field: "category_id" | "priority_id"; op: "eq" | "neq"; value: string }
  | { field: "priority_rank"; op: "lte" | "gte" | "eq" | "neq"; value: number }
  | { field: `custom.${string}`; op: "eq" | "neq" | "contains"; value: string };

export type RoutingConditions = { all: RoutingCondition[] };

export const routingConditionsSchema = z.object({
  all: z.array(
    z.union([
      z.object({
        field: z.enum(["category_id", "priority_id"]),
        op: z.enum(["eq", "neq"]),
        value: z.string().uuid(),
      }),
      z.object({
        field: z.literal("priority_rank"),
        op: z.enum(["lte", "gte", "eq", "neq"]),
        value: z.number().int(),
      }),
      z.object({
        field: z.string().regex(/^custom\.[a-z0-9_]+$/),
        op: z.enum(["eq", "neq", "contains"]),
        value: z.string(),
      }),
    ]),
  ),
});

export type RoutingContext = {
  categoryId: string;
  priorityId: string;
  priorityRank: number;
  customFields: Record<string, unknown>;
};

export function matchesRoutingConditions(conditions: unknown, context: RoutingContext): boolean {
  const parsed = routingConditionsSchema.safeParse(conditions);
  if (!parsed.success) return false;

  return parsed.data.all.every((condition) => {
    if (condition.field === "category_id") {
      return condition.op === "eq"
        ? context.categoryId === condition.value
        : context.categoryId !== condition.value;
    }
    if (condition.field === "priority_id") {
      return condition.op === "eq"
        ? context.priorityId === condition.value
        : context.priorityId !== condition.value;
    }
    if (condition.field === "priority_rank") {
      if (condition.op === "lte") return context.priorityRank <= condition.value;
      if (condition.op === "gte") return context.priorityRank >= condition.value;
      if (condition.op === "eq") return context.priorityRank === condition.value;
      return context.priorityRank !== condition.value;
    }

    const key = condition.field.slice("custom.".length);
    const raw = context.customFields[key];
    const value = raw === null || raw === undefined ? "" : String(raw);
    if (condition.op === "eq") return value === condition.value;
    if (condition.op === "neq") return value !== condition.value;
    return String(value).includes(String(condition.value));
  });
}

export function formatTicketNumber(prefix: string, number: number | string): string {
  return `${prefix}-${String(number).padStart(6, "0")}`;
}

export function stagePausesResolution(stage: Stage): boolean {
  return stage === "pending";
}

export function stageStopsResolution(stage: Stage): boolean {
  return stage === "resolved" || stage === "closed";
}

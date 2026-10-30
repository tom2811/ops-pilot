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

export const DEFAULT_SLA_POLICIES: Array<{
  priorityKey: string;
  name: string;
  responseMinutes: number;
  resolutionMinutes: number;
}> = [
  { priorityKey: "p1", name: "Critical support", responseMinutes: 60, resolutionMinutes: 240 },
  { priorityKey: "p2", name: "High priority support", responseMinutes: 240, resolutionMinutes: 480 },
  { priorityKey: "p3", name: "Standard support", responseMinutes: 480, resolutionMinutes: 1440 },
  { priorityKey: "p4", name: "Low priority support", responseMinutes: 1440, resolutionMinutes: 2880 },
];

export const DEFAULT_NOTIFICATION_TEMPLATES: Array<{ key: string; subject: string; body: string }> = [
  {
    key: "ticket_created",
    subject: "Ticket #{{number}} created",
    body: "We received \"{{subject}}\". Your request is queued with the service team.",
  },
  {
    key: "ticket_replied",
    subject: "New reply on ticket #{{number}}",
    body: "{{authorName}} replied to \"{{subject}}\":\n\n{{body}}",
  },
  {
    key: "ticket_resolved",
    subject: "Ticket #{{number}} resolved",
    body: "\"{{subject}}\" has been resolved.\n\n{{summary}}",
  },
];

export function renderTemplate(template: string, variables: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([a-z0-9_.]+)\s*\}\}/gi, (_match, key: string) => {
    let value = variables[key];
    if (value === undefined && key.includes(".")) {
      const parts = key.split(".");
      let current: unknown = variables;
      for (const segment of parts) {
        if (current === null || current === undefined || typeof current !== "object") {
          current = undefined;
          break;
        }
        current = (current as Record<string, unknown>)[segment];
      }
      value = current;
    }
    if (value === null || value === undefined) return "";
    return Array.isArray(value) ? value.join(", ") : String(value);
  });
}

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

export const notificationInputSchema = z
  .object({
    ticketId: z.string().uuid(),
    recipientId: z.string().uuid(),
    channel: z.string().min(1).max(30).default("email"),
    templateKey: z.string().min(1).max(80).optional(),
    variables: z.record(z.string(), z.unknown()).default({}),
    subject: z.string().min(1).max(300).optional(),
    body: z.string().min(1).max(20000).optional(),
  })
  .refine((input) => Boolean(input.templateKey || (input.subject && input.body)), {
    message: "Provide a templateKey or both subject and body",
  });

export const PERMISSION_KEYS = [
  "config.manage",
  "users.manage",
  "tickets.assign",
  "tickets.delete",
  "reports.view",
  "audit.view",
] as const;

export type Permission = (typeof PERMISSION_KEYS)[number];

export const DEFAULT_ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  tenant_admin: [...PERMISSION_KEYS],
  agent: ["tickets.assign", "reports.view"],
  employee: [],
};

export const permissionSchema = z.enum(PERMISSION_KEYS);

export const customRoleInputSchema = z.object({
  name: z.string().trim().min(2).max(80),
  baseRole: z.enum(["tenant_admin", "agent", "employee"]),
  permissions: z.array(permissionSchema).default([]),
});

export const customRoleUpdateSchema = customRoleInputSchema.partial();

export const invitationInputSchema = z.object({
  email: z.string().email().max(320),
  role: z.enum(["tenant_admin", "agent", "employee"]),
  teamIds: z.array(z.string().uuid()).default([]),
});

export const invitationAcceptSchema = z.object({
  displayName: z.string().trim().min(2).max(120).optional(),
  password: z.string().min(8).max(200).optional(),
});

export const membershipUpdateSchema = z.object({
  role: z.enum(["tenant_admin", "agent", "employee"]).optional(),
  isActive: z.boolean().optional(),
  teamIds: z.array(z.string().uuid()).optional(),
  customRoleId: z.string().uuid().nullable().optional(),
});

export const feedbackSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(2000).optional(),
});

export const passwordResetRequestSchema = z.object({
  email: z.string().email().max(320),
});

export const passwordResetConfirmSchema = z.object({
  token: z.string().min(10).max(200),
  password: z.string().min(8).max(200),
});

export const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(8).max(200),
});

export const ticketUpdateSchema = z.object({
  subject: z.string().trim().min(3).max(200).optional(),
  description: z.string().trim().min(1).max(20000).optional(),
  categoryId: z.string().uuid().optional(),
  priorityId: z.string().uuid().optional(),
  customFields: z.record(z.string(), z.unknown()).optional(),
  expectedVersion: z.number().int().nonnegative(),
});

export const tenantSettingsInputSchema = z
  .object({
    timezone: z.string().trim().min(1).max(80).refine(isValidTimeZone, "Invalid timezone"),
    ticketPrefix: z
      .string()
      .trim()
      .min(2)
      .max(10)
      .regex(/^[A-Z0-9]+$/),
    reopenWindowDays: z.number().int().min(0).max(3650),
    autoCloseDays: z.number().int().min(0).max(3650),
    businessHoursStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/).optional(),
    businessHoursEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/).optional(),
    businessDays: z.array(z.number().int().min(1).max(7)).min(1).optional(),
  })
  .superRefine((value, context) => {
    if (!value.businessHoursStart || !value.businessHoursEnd) return;
    const start = value.businessHoursStart.split(":").map(Number);
    const end = value.businessHoursEnd.split(":").map(Number);
    const startMinutes = (start[0] ?? 0) * 60 + (start[1] ?? 0);
    const endMinutes = (end[0] ?? 0) * 60 + (end[1] ?? 0);
    if (startMinutes >= endMinutes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["businessHoursEnd"],
        message: "Business hours end must be after start",
      });
    }
  });

export const slaPolicyInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  priorityId: z.string().uuid().nullable().optional(),
  categoryId: z.string().uuid().nullable().optional(),
  responseMinutes: z.number().int().min(1).max(525_600),
  resolutionMinutes: z.number().int().min(1).max(525_600),
  businessHoursOnly: z.boolean().optional(),
});

export const notificationTemplateInputSchema = z.object({
  subject: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(20000),
  isActive: z.boolean().default(true),
});

export const cannedResponseInputSchema = z.object({
  title: z.string().trim().min(1).max(120),
  shortcut: z
    .string()
    .trim()
    .min(1)
    .max(50)
    .regex(/^[a-z0-9_-]+$/i, "Shortcut must contain only letters, numbers, hyphens, and underscores"),
  body: z.string().trim().min(1).max(20000),
});

export const cannedResponseUpdateSchema = cannedResponseInputSchema.partial();

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

export type BusinessHoursConfig = {
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
  businessDays: number[];
  timeZone?: string;
};

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

function zonedParts(date: Date, timeZone: string): ZonedParts {
  const values: Record<string, number> = {};
  for (const part of zonedFormatter(timeZone).formatToParts(date)) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  const year = values.year ?? 0;
  const month = values.month ?? 1;
  const day = values.day ?? 1;
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay() || 7;
  return {
    year,
    month,
    day,
    hour: values.hour ?? 0,
    minute: values.minute ?? 0,
    second: values.second ?? 0,
    weekday,
  };
}

function zonedTimeToUtc(
  parts: { year: number; month: number; day: number; hour: number; minute: number; second: number },
  timeZone: string,
  milliseconds: number,
): Date {
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  let timestamp = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = zonedParts(new Date(timestamp), timeZone);
    const actualTimestamp = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    const offset = target - actualTimestamp;
    if (offset === 0) break;
    timestamp += offset;
  }
  return new Date(timestamp + milliseconds);
}

export function addBusinessMinutes(
  from: Date,
  minutesToAdd: number,
  config?: BusinessHoursConfig,
): Date {
  if (!config || minutesToAdd <= 0) {
    return new Date(from.getTime() + minutesToAdd * 60000);
  }
  const timeZone = config.timeZone && isValidTimeZone(config.timeZone) ? config.timeZone : "UTC";
  const startHour = config.startHour;
  const startMinute = config.startMinute;
  const startTotal = startHour * 60 + startMinute;
  const endTotal = config.endHour * 60 + config.endMinute;
  const businessDays = new Set(config.businessDays.filter((day) => day >= 1 && day <= 7));
  if (endTotal <= startTotal || businessDays.size === 0) {
    return new Date(from.getTime() + minutesToAdd * 60000);
  }

  const milliseconds = from.getUTCMilliseconds();
  let cursor = new Date(from);
  let remaining = minutesToAdd;

  function dayStart(parts: ZonedParts, daysAhead: number): Date {
    const next = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + daysAhead));
    return zonedTimeToUtc(
      {
        year: next.getUTCFullYear(),
        month: next.getUTCMonth() + 1,
        day: next.getUTCDate(),
        hour: startHour,
        minute: startMinute,
        second: 0,
      },
      timeZone,
      milliseconds,
    );
  }

  for (let guard = 0; remaining > 0 && guard < 10000; guard += 1) {
    const local = zonedParts(cursor, timeZone);
    const currentMins = local.hour * 60 + local.minute;

    if (!businessDays.has(local.weekday) || currentMins >= endTotal) {
      cursor = dayStart(local, 1);
      continue;
    }

    if (currentMins < startTotal) {
      const start = dayStart(local, 0);
      cursor = start.getTime() > cursor.getTime() ? start : dayStart(local, 1);
      continue;
    }

    const availableToday = endTotal - currentMins;
    if (remaining <= availableToday) {
      const total = currentMins + remaining;
      cursor = zonedTimeToUtc(
        {
          ...local,
          hour: Math.floor(total / 60),
          minute: total % 60,
        },
        timeZone,
        milliseconds,
      );
      remaining = 0;
    } else {
      remaining -= availableToday;
      cursor = dayStart(local, 1);
    }
  }

  return cursor;
}

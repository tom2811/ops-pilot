import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  DEFAULT_NOTIFICATION_TEMPLATES,
  DEFAULT_PRIORITIES,
  DEFAULT_SLA_POLICIES,
  DEFAULT_STATUSES,
  DEFAULT_TRANSITIONS,
  type Role,
} from "@opspilot/core";
import { hashPassword } from "@opspilot/core/password";
import { adminDatabaseUrl } from "./env.js";

const PASSWORD = "Passw0rd!";

type TenantSeed = {
  id: string;
  slug: string;
  name: string;
  prefix: string;
  timezone: string;
  teams: Array<{ slug: string; name: string }>;
  categories: Array<{ slug: string; name: string; team: string }>;
  customFields: Array<{
    key: string;
    label: string;
    type: string;
    required: boolean;
    visibility: "public" | "internal";
    options?: string[];
  }>;
};

const tenants: TenantSeed[] = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    slug: "acme",
    name: "Apex Cloud Systems",
    prefix: "APX",
    timezone: "Asia/Bangkok",
    teams: [
      { slug: "service-desk", name: "Service Desk" },
      { slug: "network", name: "Network Team" },
    ],
    categories: [
      { slug: "hardware", name: "Hardware", team: "service-desk" },
      { slug: "access", name: "Access & Accounts", team: "service-desk" },
      { slug: "network", name: "Network", team: "network" },
      { slug: "software", name: "Software", team: "service-desk" },
    ],
    customFields: [
      {
        key: "site",
        label: "Site",
        type: "select",
        required: true,
        visibility: "public",
        options: [
          "HQ",
          "Bangkok Sathorn HQ",
          "Bangkok Bangna DC",
          "Chiang Mai Nimman POP",
          "Phuket Town Hub",
          "Rayong Industrial Gateway",
          "Remote",
        ],
      },
      { key: "asset_tag", label: "Asset tag", type: "text", required: false, visibility: "internal" },
    ],
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    slug: "globex",
    name: "Nexus Global Logistics",
    prefix: "NEX",
    timezone: "Asia/Yangon",
    teams: [{ slug: "it-ops", name: "IT Operations" }],
    categories: [
      { slug: "hardware", name: "Hardware", team: "it-ops" },
      { slug: "network", name: "Network", team: "it-ops" },
      { slug: "software", name: "Software", team: "it-ops" },
    ],
    customFields: [
      {
        key: "department",
        label: "Department",
        type: "text",
        required: false,
        visibility: "public",
      },
      {
        key: "site",
        label: "Site",
        type: "select",
        required: false,
        visibility: "public",
        options: [
          "Yangon Pyay Road HQ",
          "Yangon Yankin NOC",
          "Mandalay 78th Hub",
          "Naypyidaw Zabuthiri Office",
          "Remote",
        ],
      },
    ],
  },
];

type UserSeed = {
  id: string;
  email: string;
  name: string;
  password?: string;
  memberships: Array<{ tenantSlug: string; role: Role; customRoleId?: string }>;
};

const isTestEnv =
  process.env.NODE_ENV === "test" || process.env.CI === "true" || process.env.INCLUDE_TEST_ACCOUNTS === "true";

const testUsers: UserSeed[] = isTestEnv
  ? [
      {
        id: "00000000-0000-4000-8000-000000004001",
        email: "admin@acme.test",
        name: "Acme Admin Test",
        memberships: [
          { tenantSlug: "acme", role: "tenant_admin" },
          { tenantSlug: "globex", role: "tenant_admin" },
        ],
      },
      {
        id: "00000000-0000-4000-8000-000000004002",
        email: "agent@acme.test",
        name: "Acme Agent Test",
        memberships: [
          { tenantSlug: "acme", role: "agent" },
          { tenantSlug: "globex", role: "agent" },
        ],
      },
      {
        id: "00000000-0000-4000-8000-000000004003",
        email: "employee@acme.test",
        name: "Acme Employee Test",
        memberships: [{ tenantSlug: "acme", role: "employee" }],
      },
      {
        id: "00000000-0000-4000-8000-000000004004",
        email: "admin@globex.test",
        name: "Globex Admin Test",
        memberships: [{ tenantSlug: "globex", role: "tenant_admin" }],
      },
      {
        id: "00000000-0000-4000-8000-000000004005",
        email: "agent@globex.test",
        name: "Globex Agent Test",
        memberships: [{ tenantSlug: "globex", role: "agent" }],
      },
      {
        id: "00000000-0000-4000-8000-000000004006",
        email: "employee@globex.test",
        name: "Globex Employee Test",
        memberships: [{ tenantSlug: "globex", role: "employee" }],
      },
    ]
  : [];

const TEAM_ASSIGNMENTS: Record<string, string[]> = {
  "oaksoe.thein01@gmail.com": ["service-desk", "network", "it-ops"],
  "oaksoe.thein01+agent@gmail.com": ["service-desk", "network", "it-ops"],
  "guest-agent@opspilot.dev": ["service-desk", "network", "it-ops"],
  "oaksoe.thein01+nexus@gmail.com": ["it-ops"],
  "oaksoe.thein01+nexusagent@gmail.com": ["it-ops"],
  "admin@acme.test": ["service-desk", "network", "it-ops"],
  "agent@acme.test": ["service-desk", "network", "it-ops"],
  "admin@globex.test": ["it-ops"],
  "agent@globex.test": ["it-ops"],
};

const primaryUsers: UserSeed[] = [
  {
    id: "00000000-0000-4000-8000-000000001001",
    email: "oaksoe.thein01@gmail.com",
    name: "Oak Soe Thein",
    memberships: [
      { tenantSlug: "acme", role: "tenant_admin" },
      { tenantSlug: "globex", role: "tenant_admin" },
    ],
  },
  {
    id: "00000000-0000-4000-8000-000000001002",
    email: "oaksoe.thein01+agent@gmail.com",
    name: "Alex Mercer",
    memberships: [
      { tenantSlug: "acme", role: "agent" },
      { tenantSlug: "globex", role: "agent" },
    ],
  },
  {
    id: "00000000-0000-4000-8000-000000001003",
    email: "oaksoe.thein01+requester@gmail.com",
    name: "Elena Vance",
    memberships: [{ tenantSlug: "acme", role: "employee" }],
  },
  {
    id: "00000000-0000-4000-8000-000000002001",
    email: "oaksoe.thein01+nexus@gmail.com",
    name: "Marcus Brody",
    memberships: [{ tenantSlug: "globex", role: "tenant_admin" }],
  },
  {
    id: "00000000-0000-4000-8000-000000002002",
    email: "oaksoe.thein01+nexusagent@gmail.com",
    name: "Sarah Chen",
    memberships: [{ tenantSlug: "globex", role: "agent" }],
  },
  {
    id: "00000000-0000-4000-8000-000000002003",
    email: "oaksoe.thein01+nexusreq@gmail.com",
    name: "David Kim",
    memberships: [{ tenantSlug: "globex", role: "employee" }],
  },
  {
    id: "00000000-0000-4000-8000-000000003001",
    email: "oaksoe.thein01+platform@gmail.com",
    name: "Oak Soe Thein (Platform Ops)",
    memberships: [],
  },
  {
    id: "00000000-0000-4000-8000-000000005001",
    email: "guest-agent@opspilot.dev",
    name: "Guest NOC Reviewer",
    password: "GuestReviewer2026!",
    memberships: [
      {
        tenantSlug: "acme",
        role: "agent",
        customRoleId: "00000000-0000-4000-8000-000000006001",
      },
      {
        tenantSlug: "globex",
        role: "agent",
        customRoleId: "00000000-0000-4000-8000-000000006002",
      },
    ],
  },
];

const users: UserSeed[] = [...primaryUsers, ...testUsers];

function first<T>(rows: T[]): T {
  const row = rows[0];
  if (!row) throw new Error("expected one row");
  return row;
}

async function main() {
  const client = new pg.Client({ connectionString: adminDatabaseUrl() });
  await client.connect();
  const tenantIdBySlug = new Map<string, string>();
  const teamIdsByTenant = new Map<string, Map<string, string>>();

  try {
    await client.query("begin");
    await client.query("delete from notifications");
    await client.query("delete from email_messages");
    await client.query("delete from platform_admins");
    const seedTenantIds = "select id from tenants where slug in ('acme', 'globex', 'vanguard', 'van')";
    await client.query(`delete from inbound_emails where tenant_id in (${seedTenantIds})`);
    await client.query(`delete from ticket_links where tenant_id in (${seedTenantIds})`);
    await client.query(`delete from ticket_comments where tenant_id in (${seedTenantIds})`);
    await client.query(`delete from ticket_status_history where tenant_id in (${seedTenantIds})`);
    await client.query(`delete from ticket_assignment_history where tenant_id in (${seedTenantIds})`);
    await client.query(`delete from tickets where tenant_id in (${seedTenantIds})`);
    await client.query(`delete from audit_log where tenant_id in (${seedTenantIds})`);
    await client.query("delete from tenants where slug in ('acme', 'globex', 'vanguard', 'van')");
    const seedEmails = [
      ...users.map((u) => `'${u.email}'`),
      "'admin@acme.test'",
      "'agent@acme.test'",
      "'employee@acme.test'",
      "'admin@globex.test'",
      "'agent@globex.test'",
      "'employee@globex.test'",
    ].join(",");
    await client.query(
      `delete from user_invitations where invited_by in (select id from users where email in (${seedEmails}))`,
    );
    await client.query("delete from users where email in (" + seedEmails + ")");

    for (const tenant of tenants) {
      tenantIdBySlug.set(tenant.slug, tenant.id);
      await client.query(
        "insert into tenants (id, slug, name) values ($1, $2, $3)",
        [tenant.id, tenant.slug, tenant.name],
      );
      await client.query(
        "insert into tenant_settings (tenant_id, timezone, ticket_prefix) values ($1, $2, $3)",
        [tenant.id, tenant.timezone, tenant.prefix],
      );
      await client.query("insert into ticket_counters (tenant_id, next_number) values ($1, 7)", [tenant.id]);

      const teamIdBySlug = new Map<string, string>();
      for (const team of tenant.teams) {
        const id = randomUUID();
        teamIdBySlug.set(team.slug, id);
        await client.query("insert into teams (tenant_id, id, slug, name) values ($1, $2, $3, $4)", [
          tenant.id,
          id,
          team.slug,
          team.name,
        ]);
      }
      teamIdsByTenant.set(tenant.slug, teamIdBySlug);

      const categoryIdBySlug = new Map<string, string>();
      for (const category of tenant.categories) {
        const id = randomUUID();
        categoryIdBySlug.set(category.slug, id);
        await client.query(
          "insert into categories (tenant_id, id, slug, name, default_team_id) values ($1, $2, $3, $4, $5)",
          [tenant.id, id, category.slug, category.name, teamIdBySlug.get(category.team)],
        );
      }

      const priorityIdByKey = new Map<string, string>();
      for (const priority of DEFAULT_PRIORITIES) {
        const row = await client.query<{ id: string }>(
          "insert into priorities (tenant_id, key, label, rank, color) values ($1, $2, $3, $4, $5) returning id",
          [tenant.id, priority.key, priority.label, priority.rank, priority.color],
        );
        const id = row.rows[0]?.id;
        if (id) priorityIdByKey.set(priority.key, id);
      }
      await client.query(
        "update categories set default_priority_id = $2 where tenant_id = $1 and default_priority_id is null",
        [tenant.id, priorityIdByKey.get("p3") ?? priorityIdByKey.get("p4") ?? null],
      );
      for (const policy of DEFAULT_SLA_POLICIES) {
        await client.query(
          `insert into sla_policies
            (tenant_id, name, priority_id, response_minutes, resolution_minutes)
           values ($1, $2, $3, $4, $5)`,
          [
            tenant.id,
            policy.name,
            priorityIdByKey.get(policy.priorityKey) ?? null,
            policy.responseMinutes,
            policy.resolutionMinutes,
          ],
        );
      }

      const statusIdByKey = new Map<string, string>();
      for (const status of DEFAULT_STATUSES) {
        const id = randomUUID();
        statusIdByKey.set(status.key, id);
        await client.query(
          "insert into ticket_statuses (tenant_id, id, key, label, stage, sort_order, pauses_sla) values ($1, $2, $3, $4, $5, $6, $7)",
          [
            tenant.id,
            id,
            status.key,
            status.label,
            status.stage,
            status.sortOrder,
            status.pausesSla ?? status.stage === "pending",
          ],
        );
      }

      for (const rule of DEFAULT_TRANSITIONS) {
        await client.query(
          `insert into ticket_transition_rules
            (tenant_id, from_status_id, to_status_id, actor_role, requires_assignee, requires_summary, requires_reason)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [
            tenant.id,
            statusIdByKey.get(rule.from),
            statusIdByKey.get(rule.to),
            rule.role,
            rule.requiresAssignee ?? false,
            rule.requiresSummary ?? false,
            rule.requiresReason ?? false,
          ],
        );
      }

      for (const field of tenant.customFields) {
        await client.query(
          `insert into custom_field_definitions
            (tenant_id, key, label, type, required, visibility, options)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [
            tenant.id,
            field.key,
            field.label,
            field.type,
            field.required,
            field.visibility,
            JSON.stringify(field.options ?? []),
          ],
        );
      }

      for (const template of DEFAULT_NOTIFICATION_TEMPLATES) {
        await client.query(
          "insert into notification_templates (tenant_id, key, subject, body) values ($1, $2, $3, $4)",
          [tenant.id, template.key, template.subject, template.body],
        );
      }

      let sortOrder = 10;
      for (const category of tenant.categories) {
        await client.query(
          `insert into routing_rules (tenant_id, name, conditions, team_id, sort_order)
           values ($1, $2, $3, $4, $5)`,
          [
            tenant.id,
            `${category.name} routing`,
            JSON.stringify({ all: [{ field: "category_id", op: "eq", value: categoryIdBySlug.get(category.slug) }] }),
            teamIdBySlug.get(category.team),
            sortOrder,
          ],
        );
        sortOrder += 10;
      }

      await client.query(
        `insert into escalation_policies
          (tenant_id, name, sla_kind, threshold_percent, target_type)
         values ($1, 'Resolution breach to team lead', 'resolution', 100, 'team_lead')`,
        [tenant.id],
      );
    }

    const guestRoles = [
      { id: "00000000-0000-4000-8000-000000006001", slug: "acme" },
      { id: "00000000-0000-4000-8000-000000006002", slug: "globex" },
    ];
    for (const r of guestRoles) {
      const tId = tenantIdBySlug.get(r.slug);
      if (tId) {
        await client.query(
          `insert into custom_roles (id, tenant_id, name, base_role, permissions)
           values ($1, $2, 'NOC Reviewer', 'agent', '["tickets.assign", "reports.view", "audit.view"]'::jsonb)
           on conflict (tenant_id, name) do update set permissions = excluded.permissions`,
          [r.id, tId],
        );
      }
    }

    for (const user of users) {
      await client.query(
        "insert into users (id, email, password_hash, display_name) values ($1, $2, $3, $4)",
        [user.id, user.email, await hashPassword(user.password ?? PASSWORD), user.name],
      );
      for (const membership of user.memberships) {
        const tenantId = tenantIdBySlug.get(membership.tenantSlug);
        if (!tenantId) throw new Error(`unknown tenant ${membership.tenantSlug}`);
        await client.query(
          "insert into memberships (tenant_id, user_id, role, custom_role_id) values ($1, $2, $3, $4)",
          [tenantId, user.id, membership.role, membership.customRoleId ?? null],
        );
        for (const teamSlug of TEAM_ASSIGNMENTS[user.email] ?? []) {
          const teamId = teamIdsByTenant.get(membership.tenantSlug)?.get(teamSlug);
          if (teamId) {
            await client.query("insert into team_members (tenant_id, team_id, user_id) values ($1, $2, $3)", [
              tenantId,
              teamId,
              user.id,
            ]);
          }
        }
      }
    }

    await client.query("insert into platform_admins (user_id) values ($1), ($2) on conflict do nothing", [
      "00000000-0000-4000-8000-000000003001",
      "00000000-0000-4000-8000-000000001001",
    ]);

    const adminAcme = "00000000-0000-4000-8000-000000001001";
    const agentAcme = "00000000-0000-4000-8000-000000001002";
    const employeeAcme = "00000000-0000-4000-8000-000000001003";
    const adminGlobex = "00000000-0000-4000-8000-000000002001";
    const agentGlobex = "00000000-0000-4000-8000-000000002002";
    const employeeGlobex = "00000000-0000-4000-8000-000000002003";
    const acme = tenantIdBySlug.get("acme")!;
    const globex = tenantIdBySlug.get("globex")!;

    await client.query(
      "update memberships set manager_user_id = $3 where tenant_id = $1 and user_id = $2",
      [acme, agentAcme, adminAcme],
    );
    await client.query(
      "update memberships set manager_user_id = $3 where tenant_id = $1 and user_id = $2",
      [globex, agentAcme, adminAcme],
    );
    await client.query(
      "update memberships set manager_user_id = $3 where tenant_id = $1 and user_id = $2",
      [globex, agentGlobex, adminGlobex],
    );
    await client.query("update teams set lead_user_id = $2 where tenant_id = $1", [acme, adminAcme]);
    await client.query("update teams set lead_user_id = $2 where tenant_id = $1", [globex, adminGlobex]);

    async function status(tenantId: string, key: string): Promise<string> {
      const row = first(
        (
          await client.query<{ id: string }>(
            "select id from ticket_statuses where tenant_id = $1 and key = $2",
            [tenantId, key],
          )
        ).rows,
      );
      return row.id;
    }

    async function category(tenantId: string, slug: string): Promise<string> {
      const row = first(
        (
          await client.query<{ id: string }>(
            "select id from categories where tenant_id = $1 and slug = $2",
            [tenantId, slug],
          )
        ).rows,
      );
      return row.id;
    }

    async function priority(tenantId: string, key: string): Promise<string> {
      const row = first(
        (
          await client.query<{ id: string }>(
            "select id from priorities where tenant_id = $1 and key = $2",
            [tenantId, key],
          )
        ).rows,
      );
      return row.id;
    }

    async function team(tenantId: string, slug: string): Promise<string> {
      const row = first(
        (
          await client.query<{ id: string }>(
            "select id from teams where tenant_id = $1 and slug = $2",
            [tenantId, slug],
          )
        ).rows,
      );
      return row.id;
    }

    const defaultCanned = [
      {
        title: "Investigating Incident",
        shortcut: "investigating",
        body: "Hello {{requesterName}},\n\nWe have received your report regarding \"{{subject}}\" and our engineering team has initiated diagnostics. We will provide an update within 30 minutes.",
      },
      {
        title: "Requesting Telemetry",
        shortcut: "telemetry",
        body: "Hello {{requesterName}},\n\nCould you please capture and attach the syslog output or interface diagnostic telemetry from the affected device so we can isolate the fault?",
      },
      {
        title: "Resolution Confirmation",
        shortcut: "resolved",
        body: "Hello {{requesterName}},\n\nAll corrective actions for ticket #{{number}} are complete and verified. Please let us know if you observe any further anomalies.",
      },
    ];

    for (const tenantId of [acme, globex]) {
      for (const c of defaultCanned) {
        await client.query(
          `insert into canned_responses (tenant_id, title, shortcut, body, created_by)
           values ($1, $2, $3, $4, $5)
           on conflict (tenant_id, shortcut) do update set title = excluded.title, body = excluded.body`,
          [tenantId, c.title, c.shortcut, c.body, tenantId === acme ? adminAcme : adminGlobex],
        );
      }
    }

    async function insertTicket(params: {
      tenantId: string;
      id: string;
      number: number;
      subject: string;
      description: string;
      requesterId: string;
      assigneeId?: string;
      teamId?: string;
      categoryId: string;
      priorityId: string;
      statusId: string;
      customFields: Record<string, unknown>;
      pendingReason?: string;
      resolutionSummary?: string;
      firstRespondedAt?: string;
      resolvedAt?: string;
      closedAt?: string;
      createdAt: string;
      updatedAt: string;
    }) {
      await client.query(
        `insert into tickets
          (tenant_id, id, number, subject, description, requester_id, assignee_id, team_id,
           category_id, priority_id, status_id, custom_fields, pending_reason, resolution_summary,
           version, first_responded_at, resolved_at, closed_at, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,1,$15,$16,$17,$18,$19)`,
        [
          params.tenantId,
          params.id,
          params.number,
          params.subject,
          params.description,
          params.requesterId,
          params.assigneeId ?? null,
          params.teamId ?? null,
          params.categoryId,
          params.priorityId,
          params.statusId,
          JSON.stringify(params.customFields),
          params.pendingReason ?? null,
          params.resolutionSummary ?? null,
          params.firstRespondedAt ?? null,
          params.resolvedAt ?? null,
          params.closedAt ?? null,
          params.createdAt,
          params.updatedAt,
        ],
      );

      const policy = (
        await client.query<{
          id: string;
          response_minutes: number;
          resolution_minutes: number;
        }>(
          `select id, response_minutes, resolution_minutes
           from sla_policies
           where tenant_id = $1 and is_active
             and not coalesce(business_hours_only, false)
             and (priority_id is null or priority_id = $2)
           order by (priority_id is not null) desc, created_at
           limit 1`,
          [params.tenantId, params.priorityId],
        )
      ).rows[0];
      if (policy) {
        const createdAt = new Date(params.createdAt).getTime();
        const responseDue = new Date(createdAt + policy.response_minutes * 60_000);
        const resolutionDue = new Date(createdAt + policy.resolution_minutes * 60_000);
        const responseWarn = new Date(createdAt + Math.round(policy.response_minutes * 0.8) * 60_000);
        const resolutionWarn = new Date(createdAt + Math.round(policy.resolution_minutes * 0.8) * 60_000);
        const responseStopped = params.firstRespondedAt ?? params.resolvedAt ?? params.closedAt;
        const resolutionStopped = params.resolvedAt ?? params.closedAt;
        const responseEnd = responseStopped ? new Date(responseStopped) : new Date();
        const resolutionEnd = resolutionStopped ? new Date(resolutionStopped) : new Date();
        const responseBreached = responseDue.getTime() < responseEnd.getTime();
        const resolutionBreached = resolutionDue.getTime() < resolutionEnd.getTime();
        await client.query(
          `update tickets set
             sla_policy_id = $3::uuid,
             sla_response_due_at = $4::timestamptz,
             sla_resolution_due_at = $5::timestamptz,
             sla_response_warn_due_at = $6::timestamptz,
             sla_resolution_warn_due_at = $7::timestamptz,
             sla_response_warning_at = case when $8::boolean then $6::timestamptz else null end,
             sla_resolution_warning_at = case when $9::boolean then $7::timestamptz else null end,
             sla_response_breached_at = case when $10::boolean then $4::timestamptz else null end,
             sla_resolution_breached_at = case when $11::boolean then $5::timestamptz else null end
           where tenant_id = $1 and id = $2`,
          [
            params.tenantId,
            params.id,
            policy.id,
            responseDue,
            resolutionDue,
            responseWarn,
            resolutionWarn,
            responseWarn.getTime() < responseEnd.getTime(),
            resolutionWarn.getTime() < resolutionEnd.getTime(),
            responseBreached,
            resolutionBreached,
          ],
        );
      }
    }

    // ==========================================
    // THAILAND TICKETS (acme)
    // ==========================================

    const seedRichTicket = async (def: {
      tenantId: string;
      id: string;
      number: number;
      subject: string;
      description: string;
      requesterId: string;
      assigneeId?: string | undefined;
      teamId?: string | undefined;
      categoryId: string;
      priorityId: string;
      statusId: string;
      customFields: Record<string, unknown>;
      pendingReason?: string | undefined;
      resolutionSummary?: string | undefined;
      firstRespondedAt?: string | undefined;
      resolvedAt?: string | undefined;
      closedAt?: string | undefined;
      createdAt: string;
      updatedAt: string;
      history: Array<{
        fromStatusId: string | null;
        toStatusId: string;
        actorId?: string;
        actorRole: "employee" | "agent" | "tenant_admin";
        reason?: string;
        createdAt: string;
      }>;
      assignments?: Array<{
        fromTeamId?: string | null;
        toTeamId?: string | null;
        fromAssigneeId?: string | null;
        toAssigneeId?: string | null;
        actorId?: string;
        actorRole: "employee" | "agent" | "tenant_admin";
        source?: "manual" | "automation";
        createdAt: string;
      }>;
      comments?: Array<{
        authorId: string;
        body: string;
        visibility: "public" | "internal";
        createdAt: string;
      }>;
    }) => {
      await insertTicket({
        tenantId: def.tenantId,
        id: def.id,
        number: def.number,
        subject: def.subject,
        description: def.description,
        requesterId: def.requesterId,
        assigneeId: def.assigneeId,
        teamId: def.teamId,
        categoryId: def.categoryId,
        priorityId: def.priorityId,
        statusId: def.statusId,
        customFields: def.customFields,
        pendingReason: def.pendingReason,
        resolutionSummary: def.resolutionSummary,
        firstRespondedAt: def.firstRespondedAt,
        resolvedAt: def.resolvedAt,
        closedAt: def.closedAt,
        createdAt: def.createdAt,
        updatedAt: def.updatedAt,
      });

      for (const h of def.history) {
        await client.query(
          `insert into ticket_status_history
            (tenant_id, ticket_id, from_status_id, to_status_id, actor_id, actor_role, reason, created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            def.tenantId,
            def.id,
            h.fromStatusId,
            h.toStatusId,
            h.actorId ?? null,
            h.actorRole,
            h.reason ?? null,
            h.createdAt,
          ],
        );
      }

      if (def.assignments) {
        for (const a of def.assignments) {
          await client.query(
            `insert into ticket_assignment_history
              (tenant_id, ticket_id, from_team_id, to_team_id, from_assignee_id, to_assignee_id, actor_id, actor_role, source, created_at)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [
              def.tenantId,
              def.id,
              a.fromTeamId ?? null,
              a.toTeamId ?? null,
              a.fromAssigneeId ?? null,
              a.toAssigneeId ?? null,
              a.actorId ?? null,
              a.actorRole,
              a.source ?? "manual",
              a.createdAt,
            ],
          );
        }
      }

      if (def.comments) {
        for (const c of def.comments) {
          await client.query(
            `insert into ticket_comments
              (tenant_id, ticket_id, author_id, body, visibility, created_at)
             values ($1,$2,$3,$4,$5,$6)`,
            [def.tenantId, def.id, c.authorId, c.body, c.visibility, c.createdAt],
          );
        }
      }
    };

    // ==========================================
    // THAILAND TICKETS (acme)
    // ==========================================

    // Ticket ACM-1: High priority DWDM link flap (In Progress)
    const acmeTicket1 = randomUUID();
    await seedRichTicket({
      tenantId: acme,
      id: acmeTicket1,
      number: 1,
      subject: "Bangkok Sathorn to Chiang Mai Nimman DWDM link latency spike",
      description:
        "Since 08:30 ICT, the 100Gbps DWDM backbone circuit between Bangkok Sathorn DC and Chiang Mai Nimman POP is experiencing intermittent packet loss (3.8%) and round-trip delay exceeding 48ms. Traffic automatically diverted to secondary route via Phitsanulok.",
      requesterId: employeeAcme,
      assigneeId: agentAcme,
      teamId: await team(acme, "network"),
      categoryId: await category(acme, "network"),
      priorityId: await priority(acme, "p2"),
      statusId: await status(acme, "in_progress"),
      customFields: { site: "HQ", asset_tag: "DWDM-BKK-01" },
      firstRespondedAt: "2026-10-28T09:15:00Z",
      createdAt: "2026-10-28T09:00:00Z",
      updatedAt: "2026-10-28T09:45:00Z",
      history: [
        {
          fromStatusId: null,
          toStatusId: await status(acme, "new"),
          actorId: employeeAcme,
          actorRole: "employee",
          createdAt: "2026-10-28T09:00:00Z",
        },
        {
          fromStatusId: await status(acme, "new"),
          toStatusId: await status(acme, "in_progress"),
          actorId: agentAcme,
          actorRole: "agent",
          reason: "Triage complete. Rerouting traffic and analyzing line telemetry.",
          createdAt: "2026-10-28T09:15:00Z",
        },
      ],
      assignments: [
        {
          toTeamId: await team(acme, "network"),
          actorRole: "employee",
          source: "automation",
          createdAt: "2026-10-28T09:00:00Z",
        },
        {
          fromTeamId: await team(acme, "network"),
          toTeamId: await team(acme, "network"),
          toAssigneeId: agentAcme,
          actorId: agentAcme,
          actorRole: "agent",
          source: "manual",
          createdAt: "2026-10-28T09:12:00Z",
        },
      ],
      comments: [
        {
          authorId: employeeAcme,
          body: "Customer NOC at Agoda Bangkok office reported latency spike reaching 52ms and intermittent packet drops.",
          visibility: "public",
          createdAt: "2026-10-28T09:05:00Z",
        },
        {
          authorId: agentAcme,
          body: "Acknowledged. Investigating telemetry metrics on the Sathorn-Nimman span. Initial tests confirm optical amplifier alarms.",
          visibility: "public",
          createdAt: "2026-10-28T09:15:00Z",
        },
        {
          authorId: agentAcme,
          body: "OTDR scan from Bangna shows optical reflection anomaly at KM 142 near Nakhon Sawan joint enclosure. Dispatching AIS field crew.",
          visibility: "internal",
          createdAt: "2026-10-28T09:20:00Z",
        },
        {
          authorId: agentAcme,
          body: "Traffic rerouted via secondary Eastern ring. Latency stabilized to 22ms while optical fiber inspection is ongoing.",
          visibility: "public",
          createdAt: "2026-10-28T09:30:00Z",
        },
        {
          authorId: employeeAcme,
          body: "Confirmed, latency has returned to normal across our Chiang Mai services. Awaiting field repair sign-off.",
          visibility: "public",
          createdAt: "2026-10-28T09:45:00Z",
        },
      ],
    });

    // Ticket ACM-2: 5G Private SIM cards provisioning (New)
    const acmeTicket2 = randomUUID();
    await seedRichTicket({
      tenantId: acme,
      id: acmeTicket2,
      number: 2,
      subject: "Procure 50 AIS 5G Private APN SIM cards for Rayong smart meter pilot",
      description:
        "Please provision 50 AIS 5G M2M private APN SIM cards with fixed static IPs for industrial telemetry deployment at Map Ta Phut Industrial Estate, Rayong.",
      requesterId: employeeAcme,
      categoryId: await category(acme, "hardware"),
      priorityId: await priority(acme, "p3"),
      statusId: await status(acme, "new"),
      customFields: { site: "HQ" },
      createdAt: "2026-10-29T10:00:00Z",
      updatedAt: "2026-10-29T10:00:00Z",
      history: [
        {
          fromStatusId: null,
          toStatusId: await status(acme, "new"),
          actorId: employeeAcme,
          actorRole: "employee",
          createdAt: "2026-10-29T10:00:00Z",
        },
      ],
      assignments: [
        {
          toTeamId: await team(acme, "service-desk"),
          actorRole: "employee",
          source: "automation",
          createdAt: "2026-10-29T10:00:00Z",
        },
      ],
      comments: [
        {
          authorId: employeeAcme,
          body: "Project budget approved under PO-2026-TH-882. We require SIM delivery to the Rayong Industrial Gateway site before Friday.",
          visibility: "public",
          createdAt: "2026-10-29T10:00:00Z",
        },
      ],
    });

    // Ticket ACM-3: Bangna DC Precision AC Unit compressor alert (Pending)
    const acmeTicket3 = randomUUID();
    await seedRichTicket({
      tenantId: acme,
      id: acmeTicket3,
      number: 3,
      subject: "Bangna Data Center Suite 4B precision cooling unit 2 compressor alarm",
      description:
        "Building Management System (BMS) triggered a high head pressure alarm on Stulz PAC Unit 2 in cold aisle 4B. Redundant PAC Unit 3 engaged automatically, maintaining aisle temperature at 21.4°C.",
      requesterId: employeeAcme,
      assigneeId: agentAcme,
      teamId: await team(acme, "service-desk"),
      categoryId: await category(acme, "hardware"),
      priorityId: await priority(acme, "p2"),
      statusId: await status(acme, "pending"),
      customFields: { site: "Bangkok Bangna DC", asset_tag: "PAC-BKK-04B2" },
      pendingReason: "Awaiting Daikin/Stulz HVAC technician arrival with replacement R410A expansion valve.",
      firstRespondedAt: "2026-10-30T04:45:00Z",
      createdAt: "2026-10-30T04:30:00Z",
      updatedAt: "2026-10-30T05:20:00Z",
      history: [
        {
          fromStatusId: null,
          toStatusId: await status(acme, "new"),
          actorId: employeeAcme,
          actorRole: "employee",
          createdAt: "2026-10-30T04:30:00Z",
        },
        {
          fromStatusId: await status(acme, "new"),
          toStatusId: await status(acme, "in_progress"),
          actorId: agentAcme,
          actorRole: "agent",
          reason: "Facilities emergency checklist initiated. Contacting HVAC vendor.",
          createdAt: "2026-10-30T04:45:00Z",
        },
        {
          fromStatusId: await status(acme, "in_progress"),
          toStatusId: await status(acme, "pending"),
          actorId: agentAcme,
          actorRole: "agent",
          reason: "Awaiting Daikin/Stulz HVAC technician arrival with replacement R410A expansion valve.",
          createdAt: "2026-10-30T05:15:00Z",
        },
      ],
      assignments: [
        {
          toTeamId: await team(acme, "service-desk"),
          actorRole: "employee",
          source: "automation",
          createdAt: "2026-10-30T04:30:00Z",
        },
        {
          fromTeamId: await team(acme, "service-desk"),
          toTeamId: await team(acme, "service-desk"),
          toAssigneeId: agentAcme,
          actorId: agentAcme,
          actorRole: "agent",
          source: "manual",
          createdAt: "2026-10-30T04:40:00Z",
        },
      ],
      comments: [
        {
          authorId: employeeAcme,
          body: "BMS alert shows PAC Unit 2 compressor #1 tripping on high head pressure. Temperature in Suite 4B currently 21.4°C.",
          visibility: "public",
          createdAt: "2026-10-30T04:30:00Z",
        },
        {
          authorId: agentAcme,
          body: "Confirmed PAC Unit 3 has taken over the thermal load. Cold aisle airflow remains within SLA specification.",
          visibility: "internal",
          createdAt: "2026-10-30T04:50:00Z",
        },
        {
          authorId: agentAcme,
          body: "Stulz authorized maintenance contractor dispatched; ETA 11:30 ICT with replacement expansion valve.",
          visibility: "internal",
          createdAt: "2026-10-30T05:10:00Z",
        },
        {
          authorId: agentAcme,
          body: "Redundant cooling is operating normally. Ticket set to pending awaiting contractor on-site arrival at 11:30 ICT.",
          visibility: "public",
          createdAt: "2026-10-30T05:20:00Z",
        },
      ],
    });

    // Ticket ACM-4: Metro Dark Fiber Cut (Resolved)
    const acmeTicket4 = randomUUID();
    await seedRichTicket({
      tenantId: acme,
      id: acmeTicket4,
      number: 4,
      subject: "Metro dark fiber ring 2 severed near MRT Khlong Toei station",
      description:
        "Metro dark fiber ring 2 broken during underground MRT construction excavation on Rama IV Road. BGP fast reroute preserved connectivity over northern route with zero dropped transit sessions.",
      requesterId: employeeAcme,
      assigneeId: agentAcme,
      teamId: await team(acme, "network"),
      categoryId: await category(acme, "network"),
      priorityId: await priority(acme, "p1"),
      statusId: await status(acme, "resolved"),
      customFields: { site: "Bangkok Sathorn HQ", asset_tag: "FIBER-METRO-02" },
      firstRespondedAt: "2026-10-27T02:12:00Z",
      resolvedAt: "2026-10-27T06:45:00Z",
      resolutionSummary:
        "Emergency splicing team reached subterranean duct near Khlong Toei junction. Fusion spliced all 48 single-mode optical cores. OTDR test confirmed loss under 0.2 dB/km.",
      createdAt: "2026-10-27T02:00:00Z",
      updatedAt: "2026-10-27T07:00:00Z",
      history: [
        {
          fromStatusId: null,
          toStatusId: await status(acme, "new"),
          actorId: employeeAcme,
          actorRole: "employee",
          createdAt: "2026-10-27T02:00:00Z",
        },
        {
          fromStatusId: await status(acme, "new"),
          toStatusId: await status(acme, "in_progress"),
          actorId: agentAcme,
          actorRole: "agent",
          reason: "P1 Major incident declared. Fiber emergency response team mobilized.",
          createdAt: "2026-10-27T02:15:00Z",
        },
        {
          fromStatusId: await status(acme, "in_progress"),
          toStatusId: await status(acme, "pending"),
          actorId: agentAcme,
          actorRole: "agent",
          reason: "Awaiting Bangkok Metropolitan Authority (BMA) emergency underground trench excavation permit.",
          createdAt: "2026-10-27T03:00:00Z",
        },
        {
          fromStatusId: await status(acme, "pending"),
          toStatusId: await status(acme, "in_progress"),
          actorId: agentAcme,
          actorRole: "agent",
          reason: "BMA permit approved, safety perimeter secured, excavation commenced.",
          createdAt: "2026-10-27T04:15:00Z",
        },
        {
          fromStatusId: await status(acme, "in_progress"),
          toStatusId: await status(acme, "resolved"),
          actorId: agentAcme,
          actorRole: "agent",
          reason: "Emergency splicing team reached subterranean duct near Khlong Toei junction. Fusion spliced all 48 single-mode optical cores. OTDR test confirmed loss under 0.2 dB/km.",
          createdAt: "2026-10-27T06:45:00Z",
        },
      ],
      assignments: [
        {
          toTeamId: await team(acme, "network"),
          actorRole: "employee",
          source: "automation",
          createdAt: "2026-10-27T02:00:00Z",
        },
        {
          fromTeamId: await team(acme, "network"),
          toTeamId: await team(acme, "network"),
          toAssigneeId: agentAcme,
          actorId: agentAcme,
          actorRole: "agent",
          source: "manual",
          createdAt: "2026-10-27T02:12:00Z",
        },
      ],
      comments: [
        {
          authorId: employeeAcme,
          body: "Critical LOS alarm on dark fiber ring 2 between Sathorn HQ and Bangna DC. Rama IV road construction work appears to have breached our conduit.",
          visibility: "public",
          createdAt: "2026-10-27T02:00:00Z",
        },
        {
          authorId: agentAcme,
          body: "Emergency acknowledged. Network Operations Center has confirmed fiber cut near MRT Khlong Toei. Mobile splicing crew BKK-9102 dispatched.",
          visibility: "public",
          createdAt: "2026-10-27T02:12:00Z",
        },
        {
          authorId: agentAcme,
          body: "OTDR scan confirms total fiber break at 1.42km from Sathorn ODF. Splicing team on site waiting for trench access clearance.",
          visibility: "internal",
          createdAt: "2026-10-27T02:30:00Z",
        },
        {
          authorId: agentAcme,
          body: "BMA permit cleared. Trench opened. 48 optical ribbons aligned and fusion splicing underway.",
          visibility: "internal",
          createdAt: "2026-10-27T04:15:00Z",
        },
        {
          authorId: agentAcme,
          body: "Fiber splicing complete and verified. Optical power levels restored to nominal -14.2 dBm.",
          visibility: "public",
          createdAt: "2026-10-27T06:40:00Z",
        },
        {
          authorId: employeeAcme,
          body: "Verified all DWDM circuits and transit links on Ring 2 are back online with zero errors. Thank you for the rapid turnaround!",
          visibility: "public",
          createdAt: "2026-10-27T07:00:00Z",
        },
      ],
    });

    // Ticket ACM-5: Phuket POP BGP Peer Session (Closed)
    const acmeTicket5 = randomUUID();
    await seedRichTicket({
      tenantId: acme,
      id: acmeTicket5,
      number: 5,
      subject: "Phuket Town POP Juniper MX204 BGP peering timer mismatch",
      description:
        "Upstream BGP peering session with National Telecom (NT) at Phuket Town internet exchange experienced 3 flaps due to hold timer mismatch during router maintenance window.",
      requesterId: employeeAcme,
      assigneeId: agentAcme,
      teamId: await team(acme, "network"),
      categoryId: await category(acme, "network"),
      priorityId: await priority(acme, "p3"),
      statusId: await status(acme, "closed"),
      customFields: { site: "Phuket Town Hub", asset_tag: "RTR-PKT-MX204" },
      firstRespondedAt: "2026-10-25T14:20:00Z",
      resolvedAt: "2026-10-25T15:10:00Z",
      closedAt: "2026-10-26T15:10:00Z",
      resolutionSummary:
        "Adjusted BGP keepalive to 30s and hold timer to 90s to match upstream NT configuration. Session verified stable over 24-hour observation.",
      createdAt: "2026-10-25T14:00:00Z",
      updatedAt: "2026-10-26T15:10:00Z",
      history: [
        {
          fromStatusId: null,
          toStatusId: await status(acme, "new"),
          actorId: employeeAcme,
          actorRole: "employee",
          createdAt: "2026-10-25T14:00:00Z",
        },
        {
          fromStatusId: await status(acme, "new"),
          toStatusId: await status(acme, "in_progress"),
          actorId: agentAcme,
          actorRole: "agent",
          reason: "Investigating BGP session flap events with National Telecom.",
          createdAt: "2026-10-25T14:20:00Z",
        },
        {
          fromStatusId: await status(acme, "in_progress"),
          toStatusId: await status(acme, "resolved"),
          actorId: agentAcme,
          actorRole: "agent",
          reason: "Adjusted BGP keepalive to 30s and hold timer to 90s to match upstream NT configuration. Session verified stable.",
          createdAt: "2026-10-25T15:10:00Z",
        },
        {
          fromStatusId: await status(acme, "resolved"),
          toStatusId: await status(acme, "closed"),
          actorId: agentAcme,
          actorRole: "agent",
          reason: "Session remained stable throughout 24-hour observation period. Ticket closed.",
          createdAt: "2026-10-26T15:10:00Z",
        },
      ],
      assignments: [
        {
          toTeamId: await team(acme, "network"),
          actorRole: "employee",
          source: "automation",
          createdAt: "2026-10-25T14:00:00Z",
        },
        {
          fromTeamId: await team(acme, "network"),
          toTeamId: await team(acme, "network"),
          toAssigneeId: agentAcme,
          actorId: agentAcme,
          actorRole: "agent",
          source: "manual",
          createdAt: "2026-10-25T14:15:00Z",
        },
      ],
      comments: [
        {
          authorId: employeeAcme,
          body: "Upstream BGP peering session with National Telecom (NT) at Phuket Town internet exchange experienced 3 flaps due to hold timer mismatch during router maintenance window.",
          visibility: "public",
          createdAt: "2026-10-25T14:00:00Z",
        },
        {
          authorId: agentAcme,
          body: "NT router peer configured with holdtime 90s. Our MX204 interface was set to aggressive 30s holdtime. Aligning timer values.",
          visibility: "internal",
          createdAt: "2026-10-25T14:35:00Z",
        },
        {
          authorId: agentAcme,
          body: "Timer values updated. BGP session re-established with 84,200 routes received.",
          visibility: "public",
          createdAt: "2026-10-25T15:10:00Z",
        },
        {
          authorId: employeeAcme,
          body: "BGP session has remained uninterrupted with zero route withdrawals for 24 hours. Closing ticket.",
          visibility: "public",
          createdAt: "2026-10-26T15:00:00Z",
        },
      ],
    });

    // Ticket ACM-6: Quarterly optical transceiver audit (New)
    const acmeTicket6 = randomUUID();
    await seedRichTicket({
      tenantId: acme,
      id: acmeTicket6,
      number: 6,
      subject: "Quarterly optical transceiver inventory count for Bangkok Sathorn HQ",
      description:
        "Please perform physical serial verification and inventory count of spare 100G QSFP28 LR4 and 400G QSFP-DD optical modules in the Sathorn HQ secure telecom cage.",
      requesterId: employeeAcme,
      categoryId: await category(acme, "access"),
      priorityId: await priority(acme, "p4"),
      statusId: await status(acme, "new"),
      customFields: { site: "Bangkok Sathorn HQ" },
      createdAt: "2026-11-01T08:00:00Z",
      updatedAt: "2026-11-01T08:00:00Z",
      history: [
        {
          fromStatusId: null,
          toStatusId: await status(acme, "new"),
          actorId: employeeAcme,
          actorRole: "employee",
          createdAt: "2026-11-01T08:00:00Z",
        },
      ],
      assignments: [
        {
          toTeamId: await team(acme, "service-desk"),
          actorRole: "employee",
          source: "automation",
          createdAt: "2026-11-01T08:00:00Z",
        },
      ],
      comments: [
        {
          authorId: employeeAcme,
          body: "Audit sheet uploaded to shared drive. Please verify physical serials against ERP ledger before end of month.",
          visibility: "public",
          createdAt: "2026-11-01T08:00:00Z",
        },
      ],
    });

    // ==========================================
    // MYANMAR TICKETS (globex)
    // ==========================================

    // Ticket GLX-1: Mandalay Hub Generator Switchover (New)
    const globexTicket1 = randomUUID();
    await seedRichTicket({
      tenantId: globex,
      id: globexTicket1,
      number: 1,
      subject: "Mandalay 78th Hub standby diesel generator auto-start on YESC grid failure",
      description:
        "Mandalay electricity supply dropped at 06:15 MMT across Chanayethazan township. Perkins 150kVA standby diesel generator started automatically. Server room UPS battery online, but bulk fuel tank is at 35% capacity.",
      requesterId: employeeGlobex,
      teamId: await team(globex, "it-ops"),
      categoryId: await category(globex, "software"),
      priorityId: await priority(globex, "p1"),
      statusId: await status(globex, "new"),
      customFields: { department: "Power & Infrastructure", site: "Mandalay 78th Hub" },
      createdAt: "2026-10-31T06:30:00Z",
      updatedAt: "2026-10-31T06:35:00Z",
      history: [
        {
          fromStatusId: null,
          toStatusId: await status(globex, "new"),
          actorId: employeeGlobex,
          actorRole: "employee",
          createdAt: "2026-10-31T06:30:00Z",
        },
      ],
      assignments: [
        {
          toTeamId: await team(globex, "it-ops"),
          actorRole: "employee",
          source: "automation",
          createdAt: "2026-10-31T06:30:00Z",
        },
      ],
      comments: [
        {
          authorId: employeeGlobex,
          body: "Municipal power offline. Requesting emergency fuel tanker dispatch from Denko Petroleum to avoid generator fuel starvation.",
          visibility: "public",
          createdAt: "2026-10-31T06:35:00Z",
        },
      ],
    });

    // Ticket GLX-2: Pyay Road MPT Fiber Circuit Resplicing (Resolved)
    const globexTicket2 = randomUUID();
    await seedRichTicket({
      tenantId: globex,
      id: globexTicket2,
      number: 2,
      subject: "MPT primary fiber link cut on Pyay Road near Hledan junction",
      description:
        "Primary 10Gbps terrestrial backhaul cut during drainage trenching near Hledan Centre. Automatic failover redirected core internet traffic through Starlink Business terminal.",
      requesterId: employeeGlobex,
      assigneeId: agentGlobex,
      teamId: await team(globex, "it-ops"),
      categoryId: await category(globex, "hardware"),
      priorityId: await priority(globex, "p3"),
      statusId: await status(globex, "resolved"),
      customFields: { department: "Network Operations", site: "Yangon Pyay Road HQ" },
      firstRespondedAt: "2026-10-26T08:20:00Z",
      resolvedAt: "2026-10-26T14:30:00Z",
      resolutionSummary:
        "MPT joint splicing crew repaired underground conduit. Traffic transitioned from Starlink backup back to low-latency terrestrial fiber. Ping to Singapore cloud gateway: 24ms.",
      createdAt: "2026-10-26T08:00:00Z",
      updatedAt: "2026-10-26T14:45:00Z",
      history: [
        {
          fromStatusId: null,
          toStatusId: await status(globex, "new"),
          actorId: employeeGlobex,
          actorRole: "employee",
          createdAt: "2026-10-26T08:00:00Z",
        },
        {
          fromStatusId: await status(globex, "new"),
          toStatusId: await status(globex, "in_progress"),
          actorId: agentGlobex,
          actorRole: "agent",
          reason: "Starlink failover active, monitoring MPT repair crew at Hledan.",
          createdAt: "2026-10-26T08:20:00Z",
        },
        {
          fromStatusId: await status(globex, "in_progress"),
          toStatusId: await status(globex, "pending"),
          actorId: agentGlobex,
          actorRole: "agent",
          reason: "Awaiting MPT joint engineering crew to complete underground conduit re-splicing.",
          createdAt: "2026-10-26T11:00:00Z",
        },
        {
          fromStatusId: await status(globex, "pending"),
          toStatusId: await status(globex, "in_progress"),
          actorId: agentGlobex,
          actorRole: "agent",
          reason: "MPT splicing complete. Initiating OTDR link verification and failback.",
          createdAt: "2026-10-26T13:45:00Z",
        },
        {
          fromStatusId: await status(globex, "in_progress"),
          toStatusId: await status(globex, "resolved"),
          actorId: agentGlobex,
          actorRole: "agent",
          reason: "MPT joint splicing crew repaired underground conduit. Traffic transitioned from Starlink backup back to low-latency terrestrial fiber. Ping to Singapore cloud gateway: 24ms.",
          createdAt: "2026-10-26T14:30:00Z",
        },
      ],
      assignments: [
        {
          toTeamId: await team(globex, "it-ops"),
          actorRole: "employee",
          source: "automation",
          createdAt: "2026-10-26T08:00:00Z",
        },
        {
          fromTeamId: await team(globex, "it-ops"),
          toTeamId: await team(globex, "it-ops"),
          toAssigneeId: agentGlobex,
          actorId: agentGlobex,
          actorRole: "agent",
          source: "manual",
          createdAt: "2026-10-26T08:15:00Z",
        },
      ],
      comments: [
        {
          authorId: employeeGlobex,
          body: "Primary 10Gbps terrestrial backhaul cut during drainage trenching near Hledan Centre. Automated failover shifted traffic to Starlink backup.",
          visibility: "public",
          createdAt: "2026-10-26T08:00:00Z",
        },
        {
          authorId: agentGlobex,
          body: "MPT engineering team reports severed 24-core cable during road widening. Joint box being installed.",
          visibility: "internal",
          createdAt: "2026-10-26T09:30:00Z",
        },
        {
          authorId: agentGlobex,
          body: "MPT optical splice complete. Signal levels tested at -16.8 dBm. Primary circuit restored.",
          visibility: "public",
          createdAt: "2026-10-26T14:30:00Z",
        },
        {
          authorId: employeeGlobex,
          body: "Confirmed low latency restored. Excellent failover performance throughout the incident.",
          visibility: "public",
          createdAt: "2026-10-26T14:45:00Z",
        },
      ],
    });

    // Ticket GLX-3: Yankin NOC Satellite Uplink Rain Fade (In Progress)
    const globexTicket3 = randomUUID();
    await seedRichTicket({
      tenantId: globex,
      id: globexTicket3,
      number: 3,
      subject: "Yankin NOC secondary satellite uplink severe rain fade during monsoon squall",
      description:
        "Tropical monsoon storm over Yankin township causing signal degradation on Ku-band satellite backup dish. Carrier-to-noise ratio dropped below threshold with 12% packet loss.",
      requesterId: employeeGlobex,
      assigneeId: agentGlobex,
      teamId: await team(globex, "it-ops"),
      categoryId: await category(globex, "network"),
      priorityId: await priority(globex, "p2"),
      statusId: await status(globex, "in_progress"),
      customFields: { department: "NOC Satellite", site: "Yangon Yankin NOC" },
      firstRespondedAt: "2026-10-30T11:15:00Z",
      createdAt: "2026-10-30T11:00:00Z",
      updatedAt: "2026-10-30T11:35:00Z",
      history: [
        {
          fromStatusId: null,
          toStatusId: await status(globex, "new"),
          actorId: employeeGlobex,
          actorRole: "employee",
          createdAt: "2026-10-30T11:00:00Z",
        },
        {
          fromStatusId: await status(globex, "new"),
          toStatusId: await status(globex, "in_progress"),
          actorId: agentGlobex,
          actorRole: "agent",
          reason: "Adjusting uplink power control (AUPC) and adaptive modulation.",
          createdAt: "2026-10-30T11:15:00Z",
        },
      ],
      assignments: [
        {
          toTeamId: await team(globex, "it-ops"),
          actorRole: "employee",
          source: "automation",
          createdAt: "2026-10-30T11:00:00Z",
        },
        {
          fromTeamId: await team(globex, "it-ops"),
          toTeamId: await team(globex, "it-ops"),
          toAssigneeId: agentGlobex,
          actorId: agentGlobex,
          actorRole: "agent",
          source: "manual",
          createdAt: "2026-10-30T11:12:00Z",
        },
      ],
      comments: [
        {
          authorId: employeeGlobex,
          body: "Monsoon squall over Yankin. Ku-band backup satellite packet loss reaching 12%. Carrier-to-noise ratio dropping.",
          visibility: "public",
          createdAt: "2026-10-30T11:00:00Z",
        },
        {
          authorId: agentGlobex,
          body: "Enabled MODCOD QPSK 1/2 fallback to stabilize link until the squall line moves past Yankin ridge.",
          visibility: "internal",
          createdAt: "2026-10-30T11:25:00Z",
        },
        {
          authorId: agentGlobex,
          body: "Rain attenuation mitigation active. Packet loss reduced to 1.5%. Monitoring weather radar.",
          visibility: "public",
          createdAt: "2026-10-30T11:30:00Z",
        },
      ],
    });

    // Ticket GLX-4: KBZPay Payment Webhook Timeout (Pending)
    const globexTicket4 = randomUUID();
    await seedRichTicket({
      tenantId: globex,
      id: globexTicket4,
      number: 4,
      subject: "KBZPay merchant webhook settlement endpoint intermittent HTTP 504 timeouts",
      description:
        "Telecom subscriber top-up portal experiencing delays receiving settlement webhooks from KBZPay banking gateway during evening peak hours.",
      requesterId: employeeGlobex,
      assigneeId: agentGlobex,
      teamId: await team(globex, "it-ops"),
      categoryId: await category(globex, "software"),
      priorityId: await priority(globex, "p3"),
      statusId: await status(globex, "pending"),
      customFields: { department: "Billing Systems", site: "Yangon Pyay Road HQ" },
      pendingReason: "Awaiting KBZ Bank API integration team verification of upstream rate limits.",
      firstRespondedAt: "2026-10-29T16:30:00Z",
      createdAt: "2026-10-29T16:00:00Z",
      updatedAt: "2026-10-29T17:10:00Z",
      history: [
        {
          fromStatusId: null,
          toStatusId: await status(globex, "new"),
          actorId: employeeGlobex,
          actorRole: "employee",
          createdAt: "2026-10-29T16:00:00Z",
        },
        {
          fromStatusId: await status(globex, "new"),
          toStatusId: await status(globex, "in_progress"),
          actorId: agentGlobex,
          actorRole: "agent",
          reason: "Tracing Nginx gateway logs and inspecting SSL handshake latencies.",
          createdAt: "2026-10-29T16:20:00Z",
        },
        {
          fromStatusId: await status(globex, "in_progress"),
          toStatusId: await status(globex, "pending"),
          actorId: agentGlobex,
          actorRole: "agent",
          reason: "Awaiting KBZ Bank API integration team verification of upstream rate limits.",
          createdAt: "2026-10-29T17:00:00Z",
        },
      ],
      assignments: [
        {
          toTeamId: await team(globex, "it-ops"),
          actorRole: "employee",
          source: "automation",
          createdAt: "2026-10-29T16:00:00Z",
        },
        {
          fromTeamId: await team(globex, "it-ops"),
          toTeamId: await team(globex, "it-ops"),
          toAssigneeId: agentGlobex,
          actorId: agentGlobex,
          actorRole: "agent",
          source: "manual",
          createdAt: "2026-10-29T16:15:00Z",
        },
      ],
      comments: [
        {
          authorId: employeeGlobex,
          body: "Subscribers reporting top-ups taking up to 10 minutes to reflect. Error logs indicate HTTP 504 gateway timeout from KBZPay webhook.",
          visibility: "public",
          createdAt: "2026-10-29T16:00:00Z",
        },
        {
          authorId: agentGlobex,
          body: "Our ingress webhook listener is healthy with zero queue backlog. Upstream KBZPay staging endpoint api.kbzpay.com/notify is dropping 15% of packets.",
          visibility: "internal",
          createdAt: "2026-10-29T16:45:00Z",
        },
        {
          authorId: agentGlobex,
          body: "Opened escalation ticket KBZ-89104 with KBZ Bank partner support. Placed ticket in pending status awaiting bank engineering response.",
          visibility: "public",
          createdAt: "2026-10-29T17:05:00Z",
        },
      ],
    });

    // Ticket GLX-5: Naypyidaw Router Flash Replacement (Closed)
    const globexTicket5 = randomUUID();
    await seedRichTicket({
      tenantId: globex,
      id: globexTicket5,
      number: 5,
      subject: "Naypyidaw Zabuthiri branch Cisco 4331 ISR router bootflash sector error",
      description:
        "Automated health monitor detected read I/O errors on internal bootflash storage in Naypyidaw branch aggregation router.",
      requesterId: employeeGlobex,
      assigneeId: agentGlobex,
      teamId: await team(globex, "it-ops"),
      categoryId: await category(globex, "hardware"),
      priorityId: await priority(globex, "p2"),
      statusId: await status(globex, "closed"),
      customFields: { department: "Enterprise Field Support", site: "Naypyidaw Zabuthiri Office" },
      firstRespondedAt: "2026-10-24T05:30:00Z",
      resolvedAt: "2026-10-24T10:00:00Z",
      closedAt: "2026-10-25T10:00:00Z",
      resolutionSummary:
        "Field engineer swapped flash module, flashed IOS-XE 17.6.4 image, and synced startup configuration from central Git repository.",
      createdAt: "2026-10-24T05:00:00Z",
      updatedAt: "2026-10-25T10:00:00Z",
      history: [
        {
          fromStatusId: null,
          toStatusId: await status(globex, "new"),
          actorId: employeeGlobex,
          actorRole: "employee",
          createdAt: "2026-10-24T05:00:00Z",
        },
        {
          fromStatusId: await status(globex, "new"),
          toStatusId: await status(globex, "in_progress"),
          actorId: agentGlobex,
          actorRole: "agent",
          reason: "Connecting via out-of-band console to diagnose bootflash integrity.",
          createdAt: "2026-10-24T05:30:00Z",
        },
        {
          fromStatusId: await status(globex, "in_progress"),
          toStatusId: await status(globex, "resolved"),
          actorId: agentGlobex,
          actorRole: "agent",
          reason: "Field engineer swapped flash module, flashed IOS-XE 17.6.4 image, and synced startup configuration from central Git repository.",
          createdAt: "2026-10-24T10:00:00Z",
        },
        {
          fromStatusId: await status(globex, "resolved"),
          toStatusId: await status(globex, "closed"),
          actorId: agentGlobex,
          actorRole: "agent",
          reason: "Branch verified uninterrupted operations over 24 hours. Closing ticket.",
          createdAt: "2026-10-25T10:00:00Z",
        },
      ],
      assignments: [
        {
          toTeamId: await team(globex, "it-ops"),
          actorRole: "employee",
          source: "automation",
          createdAt: "2026-10-24T05:00:00Z",
        },
        {
          fromTeamId: await team(globex, "it-ops"),
          toTeamId: await team(globex, "it-ops"),
          toAssigneeId: agentGlobex,
          actorId: agentGlobex,
          actorRole: "agent",
          source: "manual",
          createdAt: "2026-10-24T05:25:00Z",
        },
      ],
      comments: [
        {
          authorId: employeeGlobex,
          body: "Router bootflash partition reported multiple bad block sectors during weekly cron backup.",
          visibility: "public",
          createdAt: "2026-10-24T05:00:00Z",
        },
        {
          authorId: agentGlobex,
          body: "Ran fsck bootflash:. Found corrupt sector in IOS-XE image file. Formatting bootflash and staging clean image from TFTP.",
          visibility: "internal",
          createdAt: "2026-10-24T06:15:00Z",
        },
        {
          authorId: agentGlobex,
          body: "Flash module replaced. Router rebooted and running verified IOS-XE 17.6.4 release. All branch routing tables nominal.",
          visibility: "public",
          createdAt: "2026-10-24T10:00:00Z",
        },
        {
          authorId: employeeGlobex,
          body: "Branch internet and VoIP traffic stable with zero packet drop over 24 hours. Thank you!",
          visibility: "public",
          createdAt: "2026-10-25T09:45:00Z",
        },
      ],
    });

    // Ticket GLX-6: Taunggyi Tower Solar Battery (New)
    const globexTicket6 = randomUUID();
    await seedRichTicket({
      tenantId: globex,
      id: globexTicket6,
      number: 6,
      subject: "Taunggyi microwave repeater solar battery string voltage imbalance check",
      description:
        "Shan State mountain repeater telemetry reports 48V LiFePO4 battery rack cell 4 voltage deviation exceeding 0.15V after 3 days of heavy cloud cover.",
      requesterId: employeeGlobex,
      categoryId: await category(globex, "hardware"),
      priorityId: await priority(globex, "p3"),
      statusId: await status(globex, "new"),
      customFields: { department: "Remote Towers" },
      createdAt: "2026-11-01T09:00:00Z",
      updatedAt: "2026-11-01T09:00:00Z",
      history: [
        {
          fromStatusId: null,
          toStatusId: await status(globex, "new"),
          actorId: employeeGlobex,
          actorRole: "employee",
          createdAt: "2026-11-01T09:00:00Z",
        },
      ],
      assignments: [
        {
          toTeamId: await team(globex, "it-ops"),
          actorRole: "employee",
          source: "automation",
          createdAt: "2026-11-01T09:00:00Z",
        },
      ],
      comments: [
        {
          authorId: employeeGlobex,
          body: "Solar BMS telemetry indicates string #3 battery float voltage is 48.2V vs nominal 53.5V. Technician inspection requested.",
          visibility: "public",
          createdAt: "2026-11-01T09:00:00Z",
        },
      ],
    });

    // Ticket Links (Cross-references)
    await client.query(
      `insert into ticket_links (tenant_id, source_ticket_id, target_ticket_id, link_type, created_by, created_at)
       values ($1,$2,$3,'causes',$4,'2026-10-27T02:30:00Z')
       on conflict do nothing`,
      [acme, acmeTicket4, acmeTicket1, agentAcme],
    );
    await client.query(
      `insert into ticket_links (tenant_id, source_ticket_id, target_ticket_id, link_type, created_by, created_at)
       values ($1,$2,$3,'causes',$4,'2026-10-26T08:30:00Z')
       on conflict do nothing`,
      [globex, globexTicket2, globexTicket3, agentGlobex],
    );

    // ==========================================
    // AUDIT LOG
    // ==========================================
    const auditCorrelation = randomUUID();
    const auditRows: Array<{
      actorId: string;
      actorRole: string;
      action: string;
      entityType: string;
      entityId: string;
      before: unknown;
      after: unknown;
      createdAt: string;
    }> = [
      {
        actorId: agentAcme,
        actorRole: "agent",
        action: "ticket.status_changed",
        entityType: "ticket",
        entityId: acmeTicket1,
        before: { status: "new" },
        after: { status: "in_progress" },
        createdAt: "2026-10-28T09:15:00Z",
      },
      {
        actorId: agentAcme,
        actorRole: "agent",
        action: "ticket.assigned",
        entityType: "ticket",
        entityId: acmeTicket1,
        before: { assignee_id: null },
        after: { assignee_id: agentAcme },
        createdAt: "2026-10-28T09:10:00Z",
      },
      {
        actorId: employeeAcme,
        actorRole: "employee",
        action: "ticket.created",
        entityType: "ticket",
        entityId: acmeTicket1,
        before: null,
        after: { subject: "Bangkok Sathorn to Chiang Mai Nimman DWDM link latency spike" },
        createdAt: "2026-10-28T09:00:00Z",
      },
      {
        actorId: agentAcme,
        actorRole: "agent",
        action: "config.notification_template_updated",
        entityType: "notification_template",
        entityId: randomUUID(),
        before: null,
        after: { key: "ticket_created", subject: "Your telecom support ticket was created" },
        createdAt: "2026-10-27T16:45:00Z",
      },
    ];
    for (const row of auditRows) {
      await client.query(
        `insert into audit_log
          (tenant_id, actor_id, actor_role, action, entity_type, entity_id, before, after, correlation_id, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          acme,
          row.actorId,
          row.actorRole,
          row.action,
          row.entityType,
          row.entityId,
          row.before === null ? null : JSON.stringify(row.before),
          row.after === null ? null : JSON.stringify(row.after),
          auditCorrelation,
          row.createdAt,
        ],
      );
    }

    await client.query("commit");
    console.log("seeded Apex Cloud Systems and Nexus Global Logistics");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

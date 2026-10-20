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
    name: "Acme Corp",
    prefix: "ACM",
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
        options: ["HQ", "Remote"],
      },
      { key: "asset_tag", label: "Asset tag", type: "text", required: false, visibility: "internal" },
    ],
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    slug: "globex",
    name: "Globex",
    prefix: "GLX",
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
    ],
  },
];

type UserSeed = {
  id: string;
  email: string;
  name: string;
  memberships: Array<{ tenantSlug: string; role: Role }>;
};

const TEAM_ASSIGNMENTS: Record<string, string[]> = {
  "admin@acme.test": ["service-desk", "network"],
  "agent@acme.test": ["service-desk", "network"],
  "admin@globex.test": ["it-ops"],
  "agent@globex.test": ["it-ops"],
};

const users: UserSeed[] = [
  {
    id: "00000000-0000-4000-8000-000000001001",
    email: "admin@acme.test",
    name: "Avery Admin",
    memberships: [{ tenantSlug: "acme", role: "tenant_admin" }],
  },
  {
    id: "00000000-0000-4000-8000-000000001002",
    email: "agent@acme.test",
    name: "Alex Agent",
    memberships: [{ tenantSlug: "acme", role: "agent" }],
  },
  {
    id: "00000000-0000-4000-8000-000000001003",
    email: "employee@acme.test",
    name: "Erin Employee",
    memberships: [{ tenantSlug: "acme", role: "employee" }],
  },
  {
    id: "00000000-0000-4000-8000-000000002001",
    email: "admin@globex.test",
    name: "Gale Admin",
    memberships: [{ tenantSlug: "globex", role: "tenant_admin" }],
  },
  {
    id: "00000000-0000-4000-8000-000000002002",
    email: "agent@globex.test",
    name: "Gabe Agent",
    memberships: [{ tenantSlug: "globex", role: "agent" }],
  },
  {
    id: "00000000-0000-4000-8000-000000002003",
    email: "employee@globex.test",
    name: "Gina Employee",
    memberships: [{ tenantSlug: "globex", role: "employee" }],
  },
  {
    id: "00000000-0000-4000-8000-000000003001",
    email: "platform@opspilot.test",
    name: "Platform Operator",
    memberships: [],
  },
];

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
    const seedTenantIds = "select id from tenants where slug in ('acme', 'globex')";
    await client.query(`delete from ticket_comments where tenant_id in (${seedTenantIds})`);
    await client.query(`delete from tickets where tenant_id in (${seedTenantIds})`);
    await client.query(`delete from audit_log where tenant_id in (${seedTenantIds})`);
    await client.query("delete from tenants where slug in ('acme', 'globex')");
    const seedEmails = users.map((u) => `'${u.email}'`).join(",");
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
        [tenant.id, "Europe/London", tenant.prefix],
      );
      await client.query("insert into ticket_counters (tenant_id, next_number) values ($1, 3)", [tenant.id]);

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
          "insert into ticket_statuses (tenant_id, id, key, label, stage, sort_order) values ($1, $2, $3, $4, $5, $6)",
          [tenant.id, id, status.key, status.label, status.stage, status.sortOrder],
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
    }

    for (const user of users) {
      await client.query(
        "insert into users (id, email, password_hash, display_name) values ($1, $2, $3, $4)",
        [user.id, user.email, hashPassword(PASSWORD), user.name],
      );
      for (const membership of user.memberships) {
        const tenantId = tenantIdBySlug.get(membership.tenantSlug);
        if (!tenantId) throw new Error(`unknown tenant ${membership.tenantSlug}`);
        await client.query(
          "insert into memberships (tenant_id, user_id, role) values ($1, $2, $3)",
          [tenantId, user.id, membership.role],
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

    await client.query("insert into platform_admins (user_id) values ($1)", [
      "00000000-0000-4000-8000-000000003001",
    ]);

    const agentAcme = "00000000-0000-4000-8000-000000001002";
    const employeeAcme = "00000000-0000-4000-8000-000000001003";
    const agentGlobex = "00000000-0000-4000-8000-000000002002";
    const employeeGlobex = "00000000-0000-4000-8000-000000002003";
    const acme = tenantIdBySlug.get("acme")!;
    const globex = tenantIdBySlug.get("globex")!;

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

    const acmeTicket1 = randomUUID();
    await client.query(
      `insert into tickets
        (tenant_id, id, number, subject, description, requester_id, assignee_id, team_id,
         category_id, priority_id, status_id, custom_fields, version, first_responded_at, created_at, updated_at)
       values ($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,$12,$13,$13)`,
      [
        acme,
        acmeTicket1,
        "VPN drops every 10 minutes",
        "Since this morning the VPN disconnects every ten minutes. Working remotely.",
        employeeAcme,
        agentAcme,
        await team(acme, "network"),
        await category(acme, "network"),
        await priority(acme, "p2"),
        await status(acme, "in_progress"),
        JSON.stringify({ site: "Remote", asset_tag: "LT-1042" }),
        "2026-10-18T09:30:00Z",
        "2026-10-18T09:00:00Z",
      ],
    );
    await client.query(
      "insert into ticket_status_history (tenant_id, ticket_id, to_status_id, actor_id, actor_role, created_at) values ($1,$2,$3,$4,'agent','2026-10-18T09:30:00Z')",
      [acme, acmeTicket1, await status(acme, "in_progress"), agentAcme],
    );
    await client.query(
      `insert into ticket_assignment_history
        (tenant_id, ticket_id, to_assignee_id, to_team_id, actor_id, actor_role, source, created_at)
       values ($1,$2,$3,$4,$5,'agent','manual','2026-10-18T09:20:00Z')`,
      [acme, acmeTicket1, agentAcme, await team(acme, "network"), agentAcme],
    );
    await client.query(
      "insert into ticket_comments (tenant_id, ticket_id, author_id, body, visibility, created_at) values ($1,$2,$3,$4,'public','2026-10-18T09:05:00Z')",
      [acme, acmeTicket1, employeeAcme, "It drops on both Wi-Fi and wired connections."],
    );
    await client.query(
      "insert into ticket_comments (tenant_id, ticket_id, author_id, body, visibility, created_at) values ($1,$2,$3,$4,'internal','2026-10-18T09:25:00Z')",
      [acme, acmeTicket1, agentAcme, "Concentrator logs show rekey failures. Checking firmware."],
    );
    await client.query(
      "insert into ticket_comments (tenant_id, ticket_id, author_id, body, visibility, created_at) values ($1,$2,$3,$4,'public','2026-10-18T09:30:00Z')",
      [acme, acmeTicket1, agentAcme, "We found a concentrator firmware issue and are applying a fix."],
    );

    await client.query(
      `insert into tickets
        (tenant_id, id, number, subject, description, requester_id, category_id, priority_id, status_id,
         custom_fields, created_at, updated_at)
       values ($1,$2,2,$3,$4,$5,$6,$7,$8,$9,'2026-10-19T11:00:00Z','2026-10-19T11:00:00Z')`,
      [
        acme,
        randomUUID(),
        "New starter laptop",
        "Please prepare a laptop for a new starter on Monday.",
        employeeAcme,
        await category(acme, "hardware"),
        await priority(acme, "p3"),
        await status(acme, "new"),
        JSON.stringify({ site: "HQ" }),
      ],
    );

    const globexTicket1 = randomUUID();
    await client.query(
      `insert into tickets
        (tenant_id, id, number, subject, description, requester_id, team_id, category_id, priority_id,
         status_id, custom_fields, created_at, updated_at)
       values ($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10,'2026-10-20T08:00:00Z','2026-10-20T08:00:00Z')`,
      [
        globex,
        globexTicket1,
        "Password reset for finance shared mailbox",
        "The finance shared mailbox password expired.",
        employeeGlobex,
        await team(globex, "it-ops"),
        await category(globex, "software"),
        await priority(globex, "p1"),
        await status(globex, "new"),
        JSON.stringify({ department: "Finance" }),
      ],
    );
    await client.query(
      "insert into ticket_status_history (tenant_id, ticket_id, to_status_id, actor_role, created_at) values ($1,$2,$3,'employee','2026-10-20T08:00:00Z')",
      [globex, globexTicket1, await status(globex, "new")],
    );

    await client.query(
      `insert into tickets
        (tenant_id, id, number, subject, description, requester_id, assignee_id, team_id, category_id,
         priority_id, status_id, custom_fields, resolution_summary, resolved_at, first_responded_at,
         created_at, updated_at)
       values ($1,$2,2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)`,
      [
        globex,
        randomUUID(),
        "Printer offline on floor 2",
        "The floor 2 printer is not responding.",
        employeeGlobex,
        agentGlobex,
        await team(globex, "it-ops"),
        await category(globex, "hardware"),
        await priority(globex, "p3"),
        await status(globex, "resolved"),
        JSON.stringify({ department: "Operations" }),
        "Reconnected the printer to the network and cleared the queue.",
        "2026-10-17T14:00:00Z",
        "2026-10-17T12:30:00Z",
        "2026-10-17T12:00:00Z",
      ],
    );

    await client.query("commit");
    console.log("seeded acme and globex");
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

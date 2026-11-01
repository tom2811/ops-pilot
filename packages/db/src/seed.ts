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
    name: "Siam Telecom & Cloud (Thailand)",
    prefix: "ACM",
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
    name: "Irrawaddy Broadband & Telecom (Myanmar)",
    prefix: "GLX",
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
    name: "Somchai Prasert",
    memberships: [{ tenantSlug: "acme", role: "tenant_admin" }],
  },
  {
    id: "00000000-0000-4000-8000-000000001002",
    email: "agent@acme.test",
    name: "Nattaporn Srisai",
    memberships: [{ tenantSlug: "acme", role: "agent" }],
  },
  {
    id: "00000000-0000-4000-8000-000000001003",
    email: "employee@acme.test",
    name: "Kanya Wongsuwan",
    memberships: [{ tenantSlug: "acme", role: "employee" }],
  },
  {
    id: "00000000-0000-4000-8000-000000002001",
    email: "admin@globex.test",
    name: "Aung Kyaw",
    memberships: [{ tenantSlug: "globex", role: "tenant_admin" }],
  },
  {
    id: "00000000-0000-4000-8000-000000002002",
    email: "agent@globex.test",
    name: "Thida Win",
    memberships: [{ tenantSlug: "globex", role: "agent" }],
  },
  {
    id: "00000000-0000-4000-8000-000000002003",
    email: "employee@globex.test",
    name: "Min Thu",
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
    await client.query(`delete from inbound_emails where tenant_id in (${seedTenantIds})`);
    await client.query(`delete from ticket_links where tenant_id in (${seedTenantIds})`);
    await client.query(`delete from ticket_comments where tenant_id in (${seedTenantIds})`);
    await client.query(`delete from ticket_status_history where tenant_id in (${seedTenantIds})`);
    await client.query(`delete from ticket_assignment_history where tenant_id in (${seedTenantIds})`);
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
    }

    // ==========================================
    // THAILAND TICKETS (acme)
    // ==========================================

    // Ticket ACM-1: High priority DWDM link flap (In Progress)
    const acmeTicket1 = randomUUID();
    await insertTicket({
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
      updatedAt: "2026-10-28T09:30:00Z",
    });

    await client.query(
      "insert into ticket_status_history (tenant_id, ticket_id, to_status_id, actor_id, actor_role, created_at) values ($1,$2,$3,$4,'agent','2026-10-28T09:15:00Z')",
      [acme, acmeTicket1, await status(acme, "in_progress"), agentAcme],
    );
    await client.query(
      `insert into ticket_assignment_history
        (tenant_id, ticket_id, to_assignee_id, to_team_id, actor_id, actor_role, source, created_at)
       values ($1,$2,$3,$4,$5,'agent','manual','2026-10-28T09:10:00Z')`,
      [acme, acmeTicket1, agentAcme, await team(acme, "network"), agentAcme],
    );
    await client.query(
      "insert into ticket_comments (tenant_id, ticket_id, author_id, body, visibility, created_at) values ($1,$2,$3,$4,'public','2026-10-28T09:05:00Z')",
      [acme, acmeTicket1, employeeAcme, "Customer NOC at Agoda Bangkok office reported latency spike reaching 52ms."],
    );
    await client.query(
      "insert into ticket_comments (tenant_id, ticket_id, author_id, body, visibility, created_at) values ($1,$2,$3,$4,'internal','2026-10-28T09:20:00Z')",
      [
        acme,
        acmeTicket1,
        agentAcme,
        "OTDR scan from Bangna shows optical reflection anomaly at KM 142 near Nakhon Sawan joint enclosure. Dispatching AIS field crew.",
      ],
    );
    await client.query(
      "insert into ticket_comments (tenant_id, ticket_id, author_id, body, visibility, created_at) values ($1,$2,$3,$4,'public','2026-10-28T09:30:00Z')",
      [
        acme,
        acmeTicket1,
        agentAcme,
        "Traffic rerouted via secondary Eastern ring. Latency stabilized to 22ms while optical fiber inspection is ongoing.",
      ],
    );

    // Ticket ACM-2: 5G Private SIM cards provisioning (New)
    const acmeTicket2 = randomUUID();
    await insertTicket({
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
    });

    await client.query(
      "insert into ticket_status_history (tenant_id, ticket_id, to_status_id, actor_role, created_at) values ($1,$2,$3,'employee','2026-10-29T10:00:00Z')",
      [acme, acmeTicket2, await status(acme, "new")],
    );

    // Ticket ACM-3: Bangna DC Precision AC Unit compressor alert (Pending)
    const acmeTicket3 = randomUUID();
    await insertTicket({
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
      updatedAt: "2026-10-30T05:15:00Z",
    });

    await client.query(
      "insert into ticket_status_history (tenant_id, ticket_id, to_status_id, actor_id, actor_role, created_at) values ($1,$2,$3,$4,'agent','2026-10-30T05:15:00Z')",
      [acme, acmeTicket3, await status(acme, "pending"), agentAcme],
    );
    await client.query(
      "insert into ticket_comments (tenant_id, ticket_id, author_id, body, visibility, created_at) values ($1,$2,$3,$4,'internal','2026-10-30T05:10:00Z')",
      [acme, acmeTicket3, agentAcme, "Stulz authorized maintenance contractor dispatched; ETA 11:30 ICT."],
    );

    // Ticket ACM-4: Metro Dark Fiber Cut (Resolved)
    const acmeTicket4 = randomUUID();
    await insertTicket({
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
      updatedAt: "2026-10-27T06:45:00Z",
    });

    await client.query(
      "insert into ticket_status_history (tenant_id, ticket_id, to_status_id, actor_id, actor_role, created_at) values ($1,$2,$3,$4,'agent','2026-10-27T06:45:00Z')",
      [acme, acmeTicket4, await status(acme, "resolved"), agentAcme],
    );
    await client.query(
      "insert into ticket_comments (tenant_id, ticket_id, author_id, body, visibility, created_at) values ($1,$2,$3,$4,'public','2026-10-27T06:45:00Z')",
      [acme, acmeTicket4, agentAcme, "Fiber splicing complete and verified. Optical power levels restored to nominal -14.2 dBm."],
    );

    // Ticket ACM-5: Phuket POP BGP Peer Session (Closed)
    const acmeTicket5 = randomUUID();
    await insertTicket({
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
    });

    await client.query(
      "insert into ticket_status_history (tenant_id, ticket_id, to_status_id, actor_id, actor_role, created_at) values ($1,$2,$3,$4,'agent','2026-10-26T15:10:00Z')",
      [acme, acmeTicket5, await status(acme, "closed"), agentAcme],
    );

    // Ticket ACM-6: Quarterly optical transceiver audit (New)
    const acmeTicket6 = randomUUID();
    await insertTicket({
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
    });

    await client.query(
      "insert into ticket_status_history (tenant_id, ticket_id, to_status_id, actor_role, created_at) values ($1,$2,$3,'employee','2026-11-01T08:00:00Z')",
      [acme, acmeTicket6, await status(acme, "new")],
    );

    // ==========================================
    // MYANMAR TICKETS (globex)
    // ==========================================

    // Ticket GLX-1: Mandalay Hub Generator Switchover (New)
    const globexTicket1 = randomUUID();
    await insertTicket({
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
      updatedAt: "2026-10-31T06:30:00Z",
    });

    await client.query(
      "insert into ticket_status_history (tenant_id, ticket_id, to_status_id, actor_role, created_at) values ($1,$2,$3,'employee','2026-10-31T06:30:00Z')",
      [globex, globexTicket1, await status(globex, "new")],
    );
    await client.query(
      "insert into ticket_comments (tenant_id, ticket_id, author_id, body, visibility, created_at) values ($1,$2,$3,$4,'public','2026-10-31T06:35:00Z')",
      [globex, globexTicket1, employeeGlobex, "Municipal power offline. Requesting emergency fuel tanker dispatch from Denko Petroleum."],
    );

    // Ticket GLX-2: Pyay Road MPT Fiber Circuit Resplicing (Resolved)
    const globexTicket2 = randomUUID();
    await insertTicket({
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
      updatedAt: "2026-10-26T14:30:00Z",
    });

    await client.query(
      "insert into ticket_status_history (tenant_id, ticket_id, to_status_id, actor_id, actor_role, created_at) values ($1,$2,$3,$4,'agent','2026-10-26T14:30:00Z')",
      [globex, globexTicket2, await status(globex, "resolved"), agentGlobex],
    );
    await client.query(
      "insert into ticket_comments (tenant_id, ticket_id, author_id, body, visibility, created_at) values ($1,$2,$3,$4,'public','2026-10-26T14:30:00Z')",
      [globex, globexTicket2, agentGlobex, "MPT optical splice complete. Signal levels tested at -16.8 dBm. Primary circuit restored."],
    );

    // Ticket GLX-3: Yankin NOC Satellite Uplink Rain Fade (In Progress)
    const globexTicket3 = randomUUID();
    await insertTicket({
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
      updatedAt: "2026-10-30T11:30:00Z",
    });

    await client.query(
      "insert into ticket_status_history (tenant_id, ticket_id, to_status_id, actor_id, actor_role, created_at) values ($1,$2,$3,$4,'agent','2026-10-30T11:15:00Z')",
      [globex, globexTicket3, await status(globex, "in_progress"), agentGlobex],
    );

    // Ticket GLX-4: KBZPay Payment Webhook Timeout (Pending)
    const globexTicket4 = randomUUID();
    await insertTicket({
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
      updatedAt: "2026-10-29T17:00:00Z",
    });

    await client.query(
      "insert into ticket_status_history (tenant_id, ticket_id, to_status_id, actor_id, actor_role, created_at) values ($1,$2,$3,$4,'agent','2026-10-29T17:00:00Z')",
      [globex, globexTicket4, await status(globex, "pending"), agentGlobex],
    );

    // Ticket GLX-5: Naypyidaw Router Flash Replacement (Closed)
    const globexTicket5 = randomUUID();
    await insertTicket({
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
    });

    await client.query(
      "insert into ticket_status_history (tenant_id, ticket_id, to_status_id, actor_id, actor_role, created_at) values ($1,$2,$3,$4,'agent','2026-10-25T10:00:00Z')",
      [globex, globexTicket5, await status(globex, "closed"), agentGlobex],
    );

    // Ticket GLX-6: Taunggyi Tower Solar Battery (New)
    const globexTicket6 = randomUUID();
    await insertTicket({
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
    });

    await client.query(
      "insert into ticket_status_history (tenant_id, ticket_id, to_status_id, actor_role, created_at) values ($1,$2,$3,'employee','2026-11-01T09:00:00Z')",
      [globex, globexTicket6, await status(globex, "new")],
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
    console.log("seeded Siam Telecom & Cloud (Thailand) and Irrawaddy Broadband & Telecom (Myanmar)");
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

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hashPassword } from "@opspilot/core/password";
import { applyEscalations, markSlaBreaches, markSlaWarnings } from "../src/domain/sla.js";

vi.setConfig({ testTimeout: 20_000, hookTimeout: 120_000 });

const repoRoot = resolve(import.meta.dirname, "../..");
const dbDir = resolve(repoRoot, "packages/db");
const appPassword = "opspilot_test_pw";
const appRole = "opspilot_app";

type App = FastifyInstance;
type InjectOptions = {
  method?: string;
  url: string;
  payload?: unknown;
  headers?: Record<string, string>;
};

type Fixtures = {
  acme: { id: string; slug: string };
  globex: { id: string; slug: string };
  acmeStatus: (key: string) => Promise<string>;
  acmeCategory: string;
  acmePriority: string;
  acmeTeam: string;
  acmeAgentId: string;
  acmeEmployeeId: string;
  globexTicketId: string;
};

let container: { getConnectionUri: () => string; stop: () => Promise<unknown> };
let admin: pg.Pool;
let app: App;
let fixtures: Fixtures;

const cookieCache = new Map<string, string>();

async function login(email: string): Promise<string> {
  const cached = cookieCache.get(email);
  if (cached) return cached;
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password: "Passw0rd!" },
  });
  expect(response.statusCode, response.body).toBe(200);
  const setCookie = response.headers["set-cookie"];
  const values = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
  const session = values.find((value) => value.startsWith("opspilot_session="));
  if (!session) throw new Error("login returned no session cookie");
  const cookie = session.split(";")[0] ?? "";
  cookieCache.set(email, cookie);
  return cookie;
}

function inject(cookie: string | null, options: InjectOptions) {
  return app.inject({
    method: options.method ?? "GET",
    url: options.url,
    payload: options.payload,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(options.headers ?? {}),
    },
  } as never);
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine")
    .withDatabase("opspilot")
    .withUsername("postgres")
    .withPassword("opspilot")
    .start();
  const adminUrl = container.getConnectionUri();
  const appUrl = new URL(adminUrl);
  appUrl.username = appRole;
  appUrl.password = appPassword;

  Object.assign(process.env, {
    ADMIN_DATABASE_URL: adminUrl,
    APP_DATABASE_URL: appUrl.toString(),
    APP_DB_ROLE: appRole,
    APP_DB_PASSWORD: appPassword,
    PORT: "3000",
    WEB_ORIGIN: "http://127.0.0.1:5173",
    PUBLIC_API_URL: "http://127.0.0.1:3000/api",
    SESSION_COOKIE_SECURE: "false",
    LOG_LEVEL: "silent",
    UPLOAD_DIR: resolve(repoRoot, ".tmp-test-uploads"),
  });

  for (const script of ["role", "migrate", "seed"] as const) {
    const result = spawnSync("pnpm", ["--filter", "@opspilot/db", script], {
      cwd: repoRoot,
      env: process.env,
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(`db ${script} failed: status=${String(result.status)} signal=${String(result.signal)} error=${String(result.error)} out=${result.stdout} err=${result.stderr}`);
  }

  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
  admin = new pg.Pool({ connectionString: adminUrl, max: 4 });

  const tenants = await admin.query<{ id: string; slug: string }>("select id, slug from tenants");
  const acme = tenants.rows.find((row) => row.slug === "acme");
  const globex = tenants.rows.find((row) => row.slug === "globex");
  if (!acme || !globex) throw new Error("seed did not create tenants");

  const status = async (tenantId: string, key: string): Promise<string> => {
    const row = await admin.query<{ id: string }>(
      "select id from ticket_statuses where tenant_id = $1 and key = $2",
      [tenantId, key],
    );
    const id = row.rows[0]?.id;
    if (!id) throw new Error(`missing status ${key}`);
    return id;
  };
  const category = await admin.query<{ id: string }>(
    "select id from categories where tenant_id = $1 order by name limit 1",
    [acme.id],
  );
  const priority = await admin.query<{ id: string }>(
    "select id from priorities where tenant_id = $1 order by rank limit 1",
    [acme.id],
  );
  const team = await admin.query<{ id: string }>(
    "select id from teams where tenant_id = $1 and slug = 'service-desk'",
    [acme.id],
  );
  const agent = await admin.query<{ user_id: string }>(
    "select m.user_id from memberships m join users u on u.id = m.user_id where m.tenant_id = $1 and u.email = 'agent@acme.test'",
    [acme.id],
  );
  const employee = await admin.query<{ user_id: string }>(
    "select m.user_id from memberships m join users u on u.id = m.user_id where m.tenant_id = $1 and u.email = 'employee@acme.test'",
    [acme.id],
  );
  const globexTicket = await admin.query<{ id: string }>("select id from tickets where tenant_id = $1 limit 1", [
    globex.id,
  ]);

  const acmeCategory = category.rows[0]?.id;
  const acmePriority = priority.rows[0]?.id;
  const acmeTeam = team.rows[0]?.id;
  const acmeAgentId = agent.rows[0]?.user_id;
  const acmeEmployeeId = employee.rows[0]?.user_id;
  const globexTicketId = globexTicket.rows[0]?.id;
  if (!acmeCategory || !acmePriority || !acmeTeam || !acmeAgentId || !acmeEmployeeId || !globexTicketId) {
    throw new Error("seed fixtures missing");
  }
  fixtures = {
    acme,
    globex,
    acmeStatus: (key) => status(acme.id, key),
    acmeCategory,
    acmePriority,
    acmeTeam,
    acmeAgentId,
    acmeEmployeeId,
    globexTicketId,
  };
});

afterAll(async () => {
  try {
    const db = await import("../src/db.js");
    await app?.close();
    await db.pool.end();
    await db.adminPool.end();
  } finally {
    await admin?.end();
    await container?.stop();
  }
});

describe("authentication and tenant isolation", () => {
  it("rejects anonymous access and invalid passwords", async () => {
    const anonymous = await app.inject({ method: "GET", url: "/api/t/acme/tickets" });
    expect(anonymous.statusCode).toBe(401);

    const badLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@acme.test", password: "wrong-password" },
    });
    expect(badLogin.statusCode).toBe(401);
  });

  it("logs in without leaking password material", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@acme.test", password: "Passw0rd!" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("password");
    expect(response.json().memberships).toEqual(
      expect.arrayContaining([expect.objectContaining({ slug: "acme", role: "tenant_admin" })]),
    );
  });

  it("does not let one tenant address another tenant's routes", async () => {
    const acmeEmployee = await login("employee@acme.test");
    const globexAdmin = await login("admin@globex.test");

    expect((await inject(acmeEmployee, { method: "GET", url: "/api/t/globex/tickets" })).statusCode).toBe(404);
    expect((await inject(acmeEmployee, { method: "GET", url: "/api/t/globex/users" })).statusCode).toBe(404);
    expect((await inject(globexAdmin, { method: "GET", url: "/api/t/acme/tickets" })).statusCode).toBe(404);
  });

  it("returns 404 for a foreign ticket id instead of confirming it exists", async () => {
    const acmeAdmin = await login("admin@acme.test");
    const response = await inject(acmeAdmin, {
      method: "GET",
      url: `/api/t/acme/tickets/${fixtures.globexTicketId}`,
    });
    expect(response.statusCode).toBe(404);
  });

  it("blocks a suspended tenant on the next request", async () => {
    const globexAdmin = await login("admin@globex.test");
    await admin.query("update tenants set status = 'suspended' where id = $1", [fixtures.globex.id]);
    try {
      const response = await inject(globexAdmin, { method: "GET", url: "/api/t/globex/tickets" });
      expect(response.statusCode).toBe(404);
    } finally {
      await admin.query("update tenants set status = 'active' where id = $1", [fixtures.globex.id]);
    }
  });

  it("sets baseline security headers and correlation id", async () => {
    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    expect(health.headers["x-content-type-options"]).toBe("nosniff");
    expect(health.headers["x-frame-options"]).toBe("DENY");
    expect(health.headers["x-correlation-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("role permissions", () => {
  it("keeps employee accounts out of admin surfaces", async () => {
    const employee = await login("employee@acme.test");
    const paths = [
      "/api/t/acme/users",
      "/api/t/acme/reports",
      "/api/t/acme/audit-log",
    ];
    for (const url of paths) {
      const response = await inject(employee, { method: "GET", url });
      expect(response.statusCode, `${url} should be forbidden`).toBe(403);
    }
    const config = await inject(employee, { method: "GET", url: "/api/t/acme/config" });
    expect(config.statusCode, config.body).toBe(200);
    expect(config.json().routing_rules).toEqual([]);
    expect(config.json().agents).toEqual([]);
    expect(
      (
        await inject(employee, {
          method: "POST",
          url: "/api/t/acme/invitations",
          payload: { email: "blocked@acme.test", role: "employee", teamIds: [] },
        })
      ).statusCode,
    ).toBe(403);
  });

  it("allows agents to read reports but not manage users", async () => {
    const agent = await login("agent@acme.test");
    expect((await inject(agent, { method: "GET", url: "/api/t/acme/reports" })).statusCode).toBe(200);
    expect((await inject(agent, { method: "GET", url: "/api/t/acme/users" })).statusCode).toBe(403);
  });

  it("separates platform administration from tenant administration", async () => {
    const platform = await login("platform@opspilot.test");
    const acmeAdmin = await login("admin@acme.test");
    expect((await inject(platform, { method: "GET", url: "/api/platform/tenants" })).statusCode).toBe(200);
    expect((await inject(acmeAdmin, { method: "GET", url: "/api/platform/tenants" })).statusCode).toBe(403);
  });

  it("requires config.manage for configuration writes", async () => {
    const employee = await login("employee@acme.test");
    const agent = await login("agent@acme.test");
    const adminCookie = await login("admin@acme.test");
    const payload = { slug: `audit-team-${Date.now()}`, name: "Audit Team" };

    expect((await inject(employee, { method: "POST", url: "/api/t/acme/teams", payload })).statusCode).toBe(403);
    expect((await inject(agent, { method: "POST", url: "/api/t/acme/teams", payload })).statusCode).toBe(403);
    const created = await inject(adminCookie, { method: "POST", url: "/api/t/acme/teams", payload });
    expect(created.statusCode, created.body).toBe(200);
    const row = await admin.query("select 1 from teams where tenant_id = $1 and slug = $2", [
      fixtures.acme.id,
      payload.slug,
    ]);
    expect(row.rowCount).toBe(1);
  });

  it("rejects automation callbacks without a valid run token", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/automation/runs/00000000-0000-4000-8000-000000009999/complete",
      payload: { status: "completed" },
    });
    expect(response.statusCode).toBe(401);

    const forged = await app.inject({
      method: "POST",
      url: "/api/automation/runs/00000000-0000-4000-8000-000000009999/complete",
      headers: { "x-opspilot-run-token": "forged-token-that-is-long-enough" },
      payload: { status: "completed" },
    });
    expect(forged.statusCode).toBe(401);
  });

  it("allows only tenant admins to delete tickets", async () => {
    const agent = await login("agent@acme.test");
    const response = await inject(agent, {
      method: "DELETE",
      url: `/api/t/acme/tickets/${fixtures.globexTicketId}`,
    });
    expect(response.statusCode).toBe(403);
  });
});

describe("configuration validation", () => {
  it("names the colliding priority rank or key", async () => {
    const adminCookie = await login("admin@acme.test");
    const duplicateRank = await inject(adminCookie, {
      method: "POST",
      url: "/api/t/acme/priorities",
      payload: {
        key: `rank-${Date.now()}`,
        label: "Rank collision",
        rank: 1,
        color: "red",
      },
    });
    expect(duplicateRank.statusCode).toBe(409);
    expect(duplicateRank.json().error).toBe("That priority rank is already in use");

    const duplicateKey = await inject(adminCookie, {
      method: "POST",
      url: "/api/t/acme/priorities",
      payload: {
        key: "p1",
        label: "Key collision",
        rank: 999,
        color: "red",
      },
    });
    expect(duplicateKey.statusCode).toBe(409);
    expect(duplicateKey.json().error).toBe("That priority key is already in use");
  });

  it("lets a new routing rule override the seeded category rule", async () => {
    const adminCookie = await login("admin@acme.test");
    const hardware = await admin.query<{ id: string }>(
      "select id from categories where tenant_id = $1 and slug = 'hardware'",
      [fixtures.acme.id],
    );
    const network = await admin.query<{ id: string }>(
      "select id from teams where tenant_id = $1 and slug = 'network'",
      [fixtures.acme.id],
    );
    const preview = (categoryId: string) =>
      inject(adminCookie, {
        method: "POST",
        url: "/api/t/acme/routing/preview",
        payload: { categoryId, priorityId: fixtures.acmePriority, customFields: {} },
      });

    const created = await inject(adminCookie, {
      method: "POST",
      url: "/api/t/acme/routing-rules",
      payload: {
        name: `Hardware override ${Date.now()}`,
        teamId: network.rows[0]?.id,
        sortOrder: 0,
        conditions: { all: [{ field: "category_id", op: "eq", value: hardware.rows[0]?.id }] },
      },
    });
    expect(created.statusCode, created.body).toBe(200);

    const matched = await preview(hardware.rows[0]?.id ?? "");
    expect(matched.statusCode, matched.body).toBe(200);
    expect(matched.json().teamName).toBe("Network Team");
    expect(matched.json().ruleId).toBe(created.json().id);

    const removed = await inject(adminCookie, {
      method: "DELETE",
      url: `/api/t/acme/routing-rules/${created.json().id}`,
    });
    expect(removed.statusCode).toBe(204);

    const fallback = await preview(hardware.rows[0]?.id ?? "");
    expect(fallback.statusCode, fallback.body).toBe(200);
    expect(fallback.json().teamName).toBe("Service Desk");
    expect(fallback.json().ruleId).not.toBe(created.json().id);
  });
});

describe("ticket lifecycle and CSAT", () => {
  it("creates, updates with optimistic concurrency, resolves, and collects feedback", async () => {
    const employee = await login("employee@acme.test");
    const adminCookie = await login("admin@acme.test");
    const subject = `Integration audit ${Date.now()}`;

    const created = await inject(employee, {
      method: "POST",
      url: "/api/t/acme/tickets",
      payload: {
        subject,
        description: "The VPN disconnects every ten minutes.",
        categoryId: fixtures.acmeCategory,
        priorityId: fixtures.acmePriority,
        customFields: { site: "HQ" },
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    const ticket = created.json() as {
      id: string;
      number: number | string;
      version: number;
      status_stage: string;
      team_id: string | null;
    };
    expect(ticket.status_stage).toBe("new");
    expect(Number(ticket.number)).toBeGreaterThan(0);
    const routedTeam = await admin.query<{ default_team_id: string }>(
      "select default_team_id from categories where tenant_id = $1 and id = $2",
      [fixtures.acme.id, fixtures.acmeCategory],
    );
    expect(ticket.team_id).toBe(routedTeam.rows[0]?.default_team_id);

    const stale = await inject(employee, {
      method: "PATCH",
      url: `/api/t/acme/tickets/${ticket.id}`,
      payload: { subject: `${subject} edited`, expectedVersion: ticket.version + 99 },
    });
    expect(stale.statusCode).toBe(409);

    const updated = await inject(employee, {
      method: "PATCH",
      url: `/api/t/acme/tickets/${ticket.id}`,
      payload: { subject: `${subject} edited`, expectedVersion: ticket.version },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json().version).toBe(ticket.version + 1);

    const detail = await inject(employee, { method: "GET", url: `/api/t/acme/tickets/${ticket.id}` });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actor_role: "employee", actor_name: expect.any(String) }),
      ]),
    );

    const comment = await inject(employee, {
      method: "POST",
      url: `/api/t/acme/tickets/${ticket.id}/comments`,
      payload: { body: "Adding my latest logs.", visibility: "public" },
    });
    expect(comment.statusCode, comment.body).toBe(200);

    const assigned = await inject(adminCookie, {
      method: "POST",
      url: `/api/t/acme/tickets/${ticket.id}/assign`,
      payload: {
        teamId: fixtures.acmeTeam,
        assigneeId: fixtures.acmeAgentId,
        expectedVersion: updated.json().version,
      },
    });
    expect(assigned.statusCode, assigned.body).toBe(200);
    expect(assigned.json().status_stage).toBe("open");

    const resolvedStatus = await fixtures.acmeStatus("resolved");
    const resolved = await inject(adminCookie, {
      method: "POST",
      url: `/api/t/acme/tickets/${ticket.id}/transitions`,
      payload: {
        toStatusId: resolvedStatus,
        expectedVersion: assigned.json().version,
        resolutionSummary: "Replaced the flaky VPN profile.",
      },
    });
    expect(resolved.statusCode, resolved.body).toBe(200);
    expect(resolved.json().status_stage).toBe("resolved");

    const feedbackEmail = await admin.query<{ body: string }>(
      `select body from email_messages
       where tenant_id = $1 and subject = $2
       order by created_at desc limit 1`,
      [fixtures.acme.id, `How did we do? Ticket #${ticket.number}`],
    );
    const body = feedbackEmail.rows[0]?.body;
    expect(body).toBeTruthy();
    const token = body?.match(/feedback\?token=([^\s]+)/)?.[1];
    expect(token).toBeTruthy();

    const publicCheck = await app.inject({
      method: "GET",
      url: `/api/feedback/${encodeURIComponent(token ?? "")}`,
    });
    expect(publicCheck.statusCode, publicCheck.body).toBe(200);
    expect(publicCheck.json()).toMatchObject({ ticketNumber: String(ticket.number), submitted: false });

    const submit = await app.inject({
      method: "POST",
      url: `/api/feedback/${encodeURIComponent(token ?? "")}`,
      payload: { rating: 5, comment: "Fast and clear." },
    });
    expect(submit.statusCode, submit.body).toBe(200);

    const duplicate = await app.inject({
      method: "POST",
      url: `/api/feedback/${encodeURIComponent(token ?? "")}`,
      payload: { rating: 1, comment: "Should not overwrite." },
    });
    expect(duplicate.statusCode).toBe(400);

    const report = await inject(adminCookie, { method: "GET", url: "/api/t/acme/reports?days=30" });
    expect(report.statusCode, report.body).toBe(200);
    expect(report.json().csat.responses).toBeGreaterThanOrEqual(1);
    expect(report.json().csat.average).toBeGreaterThanOrEqual(5);

    const audit = await inject(adminCookie, {
      method: "GET",
      url: "/api/t/acme/audit-log?action=ticket.status_changed&pageSize=10",
    });
    expect(audit.statusCode, audit.body).toBe(200);
    expect(audit.json().items.some((item: { entity_id: string }) => item.entity_id === ticket.id)).toBe(true);
  });

  it("rejects malformed and unknown feedback links", async () => {
    const malformed = await app.inject({ method: "GET", url: "/api/feedback/short" });
    expect(malformed.statusCode).toBe(400);

    const unknown = await app.inject({ method: "GET", url: "/api/feedback/aaaaaaaaaaaaaaaaaaaa" });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error).toBe("Feedback link not found");
  });

  it("claims an unassigned ticket once", async () => {
    const employee = await login("employee@acme.test");
    const adminCookie = await login("admin@acme.test");
    const created = await inject(employee, {
      method: "POST",
      url: "/api/t/acme/tickets",
      payload: {
        subject: `Claim once ${Date.now()}`,
        description: "Needs an owner.",
        categoryId: fixtures.acmeCategory,
        priorityId: fixtures.acmePriority,
        customFields: { site: "HQ" },
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    const ticket = created.json() as { id: string; version: number; team_id: string | null };
    expect(ticket.team_id).toBeTruthy();

    const claimed = await inject(adminCookie, {
      method: "POST",
      url: `/api/t/acme/tickets/${ticket.id}/claim`,
      payload: { expectedVersion: ticket.version },
    });
    expect(claimed.statusCode, claimed.body).toBe(200);
    expect(claimed.json().assignee_id).toBeTruthy();
    expect(claimed.json().status_stage).toBe("open");

    const again = await inject(adminCookie, {
      method: "POST",
      url: `/api/t/acme/tickets/${ticket.id}/claim`,
      payload: { expectedVersion: claimed.json().version },
    });
    expect(again.statusCode).toBe(409);
  });

  it("rejects a category from another tenant", async () => {
    const employee = await login("employee@acme.test");
    const foreignCategory = await admin.query<{ id: string }>(
      "select id from categories where tenant_id = $1 limit 1",
      [fixtures.globex.id],
    );
    const response = await inject(employee, {
      method: "POST",
      url: "/api/t/acme/tickets",
      payload: {
        subject: "Cross tenant category",
        description: "Should fail.",
        categoryId: foreignCategory.rows[0]?.id,
        priorityId: fixtures.acmePriority,
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it("does not let an employee set an arbitrary priority on create", async () => {
    const employee = await login("employee@acme.test");
    const category = await admin.query<{ id: string; default_priority_id: string }>(
      "select id, default_priority_id from categories where tenant_id = $1 and id = $2",
      [fixtures.acme.id, fixtures.acmeCategory],
    );
    const otherPriority = await admin.query<{ id: string }>(
      `select id from priorities
       where tenant_id = $1 and id <> $2
       order by rank
       limit 1`,
      [fixtures.acme.id, category.rows[0]?.default_priority_id],
    );
    expect(category.rows[0]?.default_priority_id).toBeTruthy();
    expect(otherPriority.rows[0]?.id).toBeTruthy();
    expect(otherPriority.rows[0]?.id).not.toBe(category.rows[0]?.default_priority_id);

    const created = await inject(employee, {
      method: "POST",
      url: "/api/t/acme/tickets",
      payload: {
        subject: `Employee priority ${Date.now()}`,
        description: "Should use the category default, not the requested priority.",
        categoryId: fixtures.acmeCategory,
        priorityId: otherPriority.rows[0]?.id,
        customFields: { site: "HQ" },
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json().priority_id).toBe(category.rows[0]?.default_priority_id);
    expect(created.json().priority_id).not.toBe(otherPriority.rows[0]?.id);
  });
});

describe("SLA clock stop rules", () => {
  async function createTicket(subject: string): Promise<{ id: string; number: number | string }> {
    const employee = await login("employee@acme.test");
    const response = await inject(employee, {
      method: "POST",
      url: "/api/t/acme/tickets",
      payload: {
        subject,
        description: "SLA clock regression test.",
        categoryId: fixtures.acmeCategory,
        priorityId: fixtures.acmePriority,
        customFields: { site: "HQ" },
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as { id: string; number: number | string };
  }

  type SlaRow = {
    sla_response_breached_at: Date | null;
    sla_resolution_breached_at: Date | null;
    sla_response_warning_at: Date | null;
    sla_resolution_warning_at: Date | null;
  };

  async function readSla(id: string): Promise<SlaRow> {
    const row = await admin.query<SlaRow>(
      `select sla_response_breached_at, sla_resolution_breached_at,
              sla_response_warning_at, sla_resolution_warning_at
       from tickets where tenant_id = $1 and id = $2`,
      [fixtures.acme.id, id],
    );
    const value = row.rows[0];
    if (!value) throw new Error("ticket not found");
    return value;
  }

  it("does not breach a ticket closed before its deadline", async () => {
    const ticket = await createTicket(`Closed early ${Date.now()}`);
    const createdAt = new Date(Date.now() - 2 * 60 * 60_000);
    const closedAt = new Date(createdAt.getTime() + 60 * 60_000);
    const dueAt = new Date(closedAt.getTime() + 60 * 60_000);
    await admin.query(
      `update tickets
       set status_id = $2, created_at = $3, closed_at = $4, resolved_at = null,
           first_responded_at = null,
           sla_response_due_at = $5, sla_resolution_due_at = $5,
           sla_response_breached_at = null, sla_resolution_breached_at = null,
           sla_response_warning_at = null, sla_resolution_warning_at = null,
           sla_paused_at = null, merged_into_ticket_id = null
       where tenant_id = $1 and id = $6`,
      [fixtures.acme.id, await fixtures.acmeStatus("closed"), createdAt, closedAt, dueAt, ticket.id],
    );

    await markSlaBreaches(admin, "response");
    await markSlaBreaches(admin, "resolution");

    const sla = await readSla(ticket.id);
    expect(sla.sla_response_breached_at).toBeNull();
    expect(sla.sla_resolution_breached_at).toBeNull();
  });

  it("stamps a closed-late breach at the closure time", async () => {
    const ticket = await createTicket(`Closed late ${Date.now()}`);
    const createdAt = new Date(Date.now() - 4 * 60 * 60_000);
    const dueAt = new Date(Date.now() - 2 * 60 * 60_000);
    const closedAt = new Date(Date.now() - 60 * 60_000);
    await admin.query(
      `update tickets
       set status_id = $2, created_at = $3, closed_at = $4, resolved_at = null,
           first_responded_at = null,
           sla_response_due_at = $5, sla_resolution_due_at = $5,
           sla_response_breached_at = null, sla_resolution_breached_at = null,
           sla_response_warning_at = null, sla_resolution_warning_at = null,
           sla_paused_at = null, merged_into_ticket_id = null
       where tenant_id = $1 and id = $6`,
      [fixtures.acme.id, await fixtures.acmeStatus("closed"), createdAt, closedAt, dueAt, ticket.id],
    );

    await markSlaBreaches(admin, "response");
    await markSlaBreaches(admin, "resolution");

    const sla = await readSla(ticket.id);
    expect(sla.sla_response_breached_at).not.toBeNull();
    expect(sla.sla_resolution_breached_at).not.toBeNull();
    expect(Math.abs((sla.sla_response_breached_at as Date).getTime() - closedAt.getTime())).toBeLessThan(2_000);
    expect(Math.abs((sla.sla_resolution_breached_at as Date).getTime() - closedAt.getTime())).toBeLessThan(2_000);
  });

  it("does not stamp breaches on merged or deleted tickets", async () => {
    const primary = await createTicket(`Merge primary ${Date.now()}`);
    const merged = await createTicket(`Merged secondary ${Date.now()}`);
    const deleted = await createTicket(`Deleted ${Date.now()}`);
    const createdAt = new Date(Date.now() - 4 * 60 * 60_000);
    const dueAt = new Date(Date.now() - 2 * 60 * 60_000);
    const closedAt = new Date(Date.now() - 60 * 60_000);

    await admin.query(
      `update tickets
       set status_id = $2, created_at = $3, closed_at = $4, resolved_at = null,
           first_responded_at = null,
           sla_response_due_at = $5, sla_resolution_due_at = $5,
           sla_response_breached_at = null, sla_resolution_breached_at = null,
           sla_paused_at = null, merged_into_ticket_id = $6
       where tenant_id = $1 and id = $7`,
      [
        fixtures.acme.id,
        await fixtures.acmeStatus("closed"),
        createdAt,
        closedAt,
        dueAt,
        primary.id,
        merged.id,
      ],
    );

    await admin.query(
      `update tickets
       set created_at = $2, deleted_at = now(),
           sla_response_due_at = $3, sla_resolution_due_at = $3,
           sla_response_breached_at = null, sla_resolution_breached_at = null,
           closed_at = null, resolved_at = null, first_responded_at = null,
           merged_into_ticket_id = null
       where tenant_id = $1 and id = $4`,
      [fixtures.acme.id, createdAt, dueAt, deleted.id],
    );

    await markSlaBreaches(admin, "response");
    await markSlaBreaches(admin, "resolution");

    const mergedSla = await readSla(merged.id);
    expect(mergedSla.sla_response_breached_at).toBeNull();
    expect(mergedSla.sla_resolution_breached_at).toBeNull();
    const deletedSla = await readSla(deleted.id);
    expect(deletedSla.sla_response_breached_at).toBeNull();
    expect(deletedSla.sla_resolution_breached_at).toBeNull();
  });

  it("suppresses warnings after closure but still warns open tickets", async () => {
    const closed = await createTicket(`Warning closed ${Date.now()}`);
    const open = await createTicket(`Warning open ${Date.now()}`);
    const createdAt = new Date(Date.now() - 9 * 60 * 60_000);
    const dueAt = new Date(Date.now() + 60 * 60_000);

    await admin.query(
      `update tickets
       set status_id = $2, created_at = $3, closed_at = now(), resolved_at = null,
           first_responded_at = null,
           sla_response_due_at = $4, sla_resolution_due_at = $4,
           sla_response_warn_due_at = null, sla_resolution_warn_due_at = null,
           sla_response_breached_at = null, sla_resolution_breached_at = null,
           sla_response_warning_at = null, sla_resolution_warning_at = null,
           sla_paused_at = null, merged_into_ticket_id = null
       where tenant_id = $1 and id = $5`,
      [fixtures.acme.id, await fixtures.acmeStatus("closed"), createdAt, dueAt, closed.id],
    );

    await admin.query(
      `update tickets
       set created_at = $2, closed_at = null, resolved_at = null,
           first_responded_at = null, assignee_id = null, team_id = null,
           sla_response_due_at = $3, sla_resolution_due_at = $3,
           sla_response_warn_due_at = null, sla_resolution_warn_due_at = null,
           sla_response_breached_at = null, sla_resolution_breached_at = null,
           sla_response_warning_at = null, sla_resolution_warning_at = null,
           sla_paused_at = null, merged_into_ticket_id = null
       where tenant_id = $1 and id = $4`,
      [fixtures.acme.id, createdAt, dueAt, open.id],
    );

    await markSlaWarnings(admin, "resolution");
    await markSlaWarnings(admin, "response");

    const closedSla = await readSla(closed.id);
    expect(closedSla.sla_resolution_warning_at).toBeNull();
    expect(closedSla.sla_response_warning_at).toBeNull();

    const openSla = await readSla(open.id);
    expect(openSla.sla_resolution_warning_at).not.toBeNull();
    expect(openSla.sla_response_warning_at).not.toBeNull();
  });
});

describe("SLA pause flag", () => {
  async function openTicket(): Promise<{ id: string; version: number }> {
    const employee = await login("employee@acme.test");
    const adminCookie = await login("admin@acme.test");
    const created = await inject(employee, {
      method: "POST",
      url: "/api/t/acme/tickets",
      payload: {
        subject: `Pause flag ${Date.now()}`,
        description: "Pending pause flag coverage.",
        categoryId: fixtures.acmeCategory,
        customFields: { site: "HQ" },
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    const assigned = await inject(adminCookie, {
      method: "POST",
      url: `/api/t/acme/tickets/${created.json().id}/assign`,
      payload: {
        teamId: fixtures.acmeTeam,
        assigneeId: fixtures.acmeAgentId,
        expectedVersion: created.json().version,
      },
    });
    expect(assigned.statusCode, assigned.body).toBe(200);
    return assigned.json() as { id: string; version: number };
  }

  it("pauses for waiting on customer and keeps the clock running for waiting on vendor", async () => {
    const adminCookie = await login("admin@acme.test");
    const customer = await openTicket();
    const customerStatus = await fixtures.acmeStatus("pending");
    const paused = await inject(adminCookie, {
      method: "POST",
      url: `/api/t/acme/tickets/${customer.id}/transitions`,
      payload: {
        toStatusId: customerStatus,
        expectedVersion: customer.version,
        reason: "Need more detail from the requester.",
      },
    });
    expect(paused.statusCode, paused.body).toBe(200);
    expect(paused.json().status_stage).toBe("pending");
    expect(paused.json().sla_paused_at).toBeTruthy();

    const vendor = await openTicket();
    const vendorStatus = await fixtures.acmeStatus("waiting_on_vendor");
    const running = await inject(adminCookie, {
      method: "POST",
      url: `/api/t/acme/tickets/${vendor.id}/transitions`,
      payload: {
        toStatusId: vendorStatus,
        expectedVersion: vendor.version,
        reason: "Waiting on the circuit provider.",
      },
    });
    expect(running.statusCode, running.body).toBe(200);
    expect(running.json().status_stage).toBe("pending");
    expect(running.json().sla_paused_at).toBeNull();
  });
});

describe("SLA escalation", () => {
  it("pages the team lead once at the resolution breach threshold", async () => {
    const employee = await login("employee@acme.test");
    const created = await inject(employee, {
      method: "POST",
      url: "/api/t/acme/tickets",
      payload: {
        subject: `Escalate lead ${Date.now()}`,
        description: "Needs a page at breach.",
        categoryId: fixtures.acmeCategory,
        customFields: { site: "HQ" },
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    const ticket = created.json() as { id: string; team_id: string | null };
    expect(ticket.team_id).toBeTruthy();

    const lead = await admin.query<{ lead_user_id: string }>(
      "select lead_user_id from teams where tenant_id = $1 and id = $2",
      [fixtures.acme.id, ticket.team_id],
    );
    expect(lead.rows[0]?.lead_user_id).toBeTruthy();

    await admin.query(
      `update tickets
       set sla_resolution_due_at = now() - interval '1 minute',
           sla_paused_at = null, resolved_at = null, closed_at = null,
           deleted_at = null, merged_into_ticket_id = null
       where tenant_id = $1 and id = $2`,
      [fixtures.acme.id, ticket.id],
    );

    const first = await applyEscalations(admin);
    expect(first).toBeGreaterThanOrEqual(1);
    const pages = await admin.query<{ id: string; threshold_percent: number }>(
      `select id, threshold_percent from ticket_escalations
       where tenant_id = $1 and ticket_id = $2`,
      [fixtures.acme.id, ticket.id],
    );
    expect(pages.rowCount).toBe(1);
    expect(pages.rows[0]?.threshold_percent).toBe(100);

    const notices = await admin.query<{ recipient_id: string }>(
      `select recipient_id from notifications
       where tenant_id = $1 and ticket_id = $2 and dedupe_key like '%sla_escalated%'`,
      [fixtures.acme.id, ticket.id],
    );
    expect(notices.rows.map((row) => row.recipient_id)).toContain(lead.rows[0]?.lead_user_id);

    const second = await applyEscalations(admin);
    expect(second).toBeGreaterThanOrEqual(0);
    const again = await admin.query(
      "select id from ticket_escalations where tenant_id = $1 and ticket_id = $2",
      [fixtures.acme.id, ticket.id],
    );
    expect(again.rowCount).toBe(1);
  });

  it("does not persist an escalation when nobody can be notified", async () => {
    const adminCookie = await login("admin@acme.test");
    const employee = await login("employee@acme.test");
    const policy = await inject(adminCookie, {
      method: "POST",
      url: "/api/t/acme/escalation-policies",
      payload: {
        name: `Manager only ${Date.now()}`,
        slaKind: "response",
        thresholdPercent: 100,
        targetType: "manager",
      },
    });
    expect(policy.statusCode, policy.body).toBe(200);

    const created = await inject(employee, {
      method: "POST",
      url: "/api/t/acme/tickets",
      payload: {
        subject: `Escalate nobody ${Date.now()}`,
        description: "Unassigned, so manager target has no recipient.",
        categoryId: fixtures.acmeCategory,
        customFields: { site: "HQ" },
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    const ticket = created.json() as { id: string; assignee_id: string | null };
    expect(ticket.assignee_id).toBeNull();

    await admin.query(
      `update tickets
       set sla_response_due_at = now() - interval '1 minute',
           first_responded_at = null, sla_paused_at = null, closed_at = null,
           deleted_at = null, merged_into_ticket_id = null
       where tenant_id = $1 and id = $2`,
      [fixtures.acme.id, ticket.id],
    );

    await applyEscalations(admin);
    const pages = await admin.query(
      `select e.id from ticket_escalations e
       where e.tenant_id = $1 and e.ticket_id = $2 and e.policy_id = $3`,
      [fixtures.acme.id, ticket.id, policy.json().id],
    );
    expect(pages.rowCount).toBe(0);
  });
});

describe("first response vs acknowledgement", () => {
  it("does not stop the clock when a ticket is created with auto-email", async () => {
    const employee = await login("employee@acme.test");
    const created = await inject(employee, {
      method: "POST",
      url: "/api/t/acme/tickets",
      payload: {
        subject: `Auto email clock ${Date.now()}`,
        description: "Creation auto-email should not stop clock.",
        categoryId: fixtures.acmeCategory,
        customFields: { site: "HQ" },
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    const ticketId = created.json().id;

    const row = await admin.query<{ first_responded_at: Date | null }>(
      "select first_responded_at from tickets where tenant_id = $1 and id = $2",
      [fixtures.acme.id, ticketId],
    );
    expect(row.rows[0]?.first_responded_at).toBeNull();
  });

  it("does not stop the clock on acknowledgement comment", async () => {
    const employee = await login("employee@acme.test");
    const adminCookie = await login("admin@acme.test");
    const created = await inject(employee, {
      method: "POST",
      url: "/api/t/acme/tickets",
      payload: {
        subject: `Ack comment clock ${Date.now()}`,
        description: "Ack comment should not stop clock.",
        categoryId: fixtures.acmeCategory,
        customFields: { site: "HQ" },
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    const ticketId = created.json().id;

    const ack = await inject(adminCookie, {
      method: "POST",
      url: `/api/t/acme/tickets/${ticketId}/comments`,
      payload: {
        body: "Thanks for reaching out. We have logged your request.",
        visibility: "public",
        countsAsFirstResponse: false,
      },
    });
    expect(ack.statusCode, ack.body).toBe(200);

    const row = await admin.query<{ first_responded_at: Date | null }>(
      "select first_responded_at from tickets where tenant_id = $1 and id = $2",
      [fixtures.acme.id, ticketId],
    );
    expect(row.rows[0]?.first_responded_at).toBeNull();
  });

  it("stops the clock on explicit first response public reply", async () => {
    const employee = await login("employee@acme.test");
    const adminCookie = await login("admin@acme.test");
    const created = await inject(employee, {
      method: "POST",
      url: "/api/t/acme/tickets",
      payload: {
        subject: `First response clock ${Date.now()}`,
        description: "Explicit reply should stop clock.",
        categoryId: fixtures.acmeCategory,
        customFields: { site: "HQ" },
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    const ticketId = created.json().id;

    const reply = await inject(adminCookie, {
      method: "POST",
      url: `/api/t/acme/tickets/${ticketId}/comments`,
      payload: {
        body: "We have analyzed the issue and resolved the configuration error.",
        visibility: "public",
        countsAsFirstResponse: true,
      },
    });
    expect(reply.statusCode, reply.body).toBe(200);

    const row = await admin.query<{ first_responded_at: Date | null }>(
      "select first_responded_at from tickets where tenant_id = $1 and id = $2",
      [fixtures.acme.id, ticketId],
    );
    expect(row.rows[0]?.first_responded_at).not.toBeNull();
  });
});

describe("invitations", () => {
  it("queues an invitation and forbids employees from creating one", async () => {
    const adminCookie = await login("admin@acme.test");
    const employee = await login("employee@acme.test");
    const email = `invite-${Date.now()}@acme.test`;

    const created = await inject(adminCookie, {
      method: "POST",
      url: "/api/t/acme/invitations",
      payload: { email, role: "employee", teamIds: [] },
    });
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json().link).toContain("/invite/");

    const queued = await admin.query<{ recipient: string; delivery_status: string; body: string }>(
      "select recipient, delivery_status, body from email_messages where tenant_id = $1 and recipient = $2",
      [fixtures.acme.id, email],
    );
    expect(queued.rows[0]?.delivery_status).toBe("pending");
    expect(queued.rows[0]?.body).toContain("/invite/");

    const forbidden = await inject(employee, {
      method: "POST",
      url: "/api/t/acme/invitations",
      payload: { email: `blocked-${Date.now()}@acme.test`, role: "employee", teamIds: [] },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it("allows an existing user to join a second tenant by membership without duplicating user row", async () => {
    const globexAdmin = await login("admin@globex.test");
    const email = "employee@acme.test";

    const invite = await inject(globexAdmin, {
      method: "POST",
      url: "/api/t/globex/invitations",
      payload: { email, role: "employee", teamIds: [] },
    });
    expect(invite.statusCode, invite.body).toBe(200);

    const queued = await admin.query<{ body: string }>(
      `select body from email_messages
       where tenant_id = $1 and recipient = $2
       order by created_at desc limit 1`,
      [fixtures.globex.id, email],
    );
    const token = queued.rows[0]?.body.match(/\/invite\/([^\s\n]+)/)?.[1];
    expect(token).toBeTruthy();

    const check = await app.inject({
      method: "GET",
      url: `/api/auth/invitations/${encodeURIComponent(token ?? "")}`,
    });
    expect(check.statusCode).toBe(200);
    expect(check.json().existingUser).toBe(true);

    const accept = await app.inject({
      method: "POST",
      url: `/api/auth/invitations/${encodeURIComponent(token ?? "")}/accept`,
      payload: { password: "Passw0rd!" },
    });
    expect(accept.statusCode, accept.body).toBe(200);

    const userRows = await admin.query(
      "select id from users where email = $1",
      [email],
    );
    expect(userRows.rowCount).toBe(1);

    const memberRows = await admin.query<{ tenant_id: string }>(
      "select tenant_id from memberships where user_id = $1",
      [userRows.rows[0]?.id],
    );
    expect(memberRows.rowCount).toBe(2);
    const tenantIds = memberRows.rows.map((r) => r.tenant_id);
    expect(tenantIds).toContain(fixtures.acme.id);
    expect(tenantIds).toContain(fixtures.globex.id);

    const dupInvite = await inject(globexAdmin, {
      method: "POST",
      url: "/api/t/globex/invitations",
      payload: { email, role: "employee", teamIds: [] },
    });
    expect(dupInvite.statusCode).toBe(400);
  });
});

describe("SLA reporting: stopped clocks and business hours", () => {
  it("reports breached, met, and still running separately and uses stopped clocks for compliance", async () => {
    const adminCookie = await login("admin@acme.test");
    const baseRes = await inject(adminCookie, {
      method: "GET",
      url: "/api/t/acme/reports?days=30",
    });
    expect(baseRes.statusCode).toBe(200);
    const baseSummary = baseRes.json().summary;

    const policyResult = await admin.query<{ id: string }>(
      "select id from sla_policies where tenant_id = $1 limit 1",
      [fixtures.acme.id],
    );
    const policyId = policyResult.rows[0]?.id;
    if (!policyId) throw new Error("No policy found");
    const resolvedStatus = await fixtures.acmeStatus("resolved");
    const openStatus = await fixtures.acmeStatus("open");

    // 1. Ticket still running within window
    await admin.query(
      `insert into tickets (
        tenant_id, number, subject, description, requester_id, status_id, priority_id, category_id, sla_policy_id,
        created_at, sla_response_due_at, sla_resolution_due_at
      ) values (
        $1, 9991, 'Running Ticket', 'Running SLA', $2, $3, $4, $5, $6,
        now() - interval '2 hours', now() + interval '2 hours', now() + interval '10 hours'
      )`,
      [fixtures.acme.id, fixtures.acmeEmployeeId, openStatus, fixtures.acmePriority, fixtures.acmeCategory, policyId],
    );

    // 2. Ticket met SLA (stopped clock, resolved on time)
    await admin.query(
      `insert into tickets (
        tenant_id, number, subject, description, requester_id, status_id, priority_id, category_id, sla_policy_id,
        created_at, resolved_at, first_responded_at, sla_response_due_at, sla_resolution_due_at
      ) values (
        $1, 9992, 'Met Ticket', 'Met SLA', $2, $3, $4, $5, $6,
        now() - interval '3 hours', now() - interval '1 hour', now() - interval '2 hours',
        now() + interval '1 hour', now() + interval '5 hours'
      )`,
      [fixtures.acme.id, fixtures.acmeEmployeeId, resolvedStatus, fixtures.acmePriority, fixtures.acmeCategory, policyId],
    );

    // 3. Ticket breached SLA
    await admin.query(
      `insert into tickets (
        tenant_id, number, subject, description, requester_id, status_id, priority_id, category_id, sla_policy_id,
        created_at, sla_response_breached_at, sla_response_due_at, sla_resolution_due_at
      ) values (
        $1, 9993, 'Breached Ticket', 'Breached SLA', $2, $3, $4, $5, $6,
        now() - interval '4 hours', now() - interval '1 hour',
        now() - interval '2 hours', now() + interval '2 hours'
      )`,
      [fixtures.acme.id, fixtures.acmeEmployeeId, openStatus, fixtures.acmePriority, fixtures.acmeCategory, policyId],
    );

    const reportRes = await inject(adminCookie, {
      method: "GET",
      url: "/api/t/acme/reports?days=30",
    });
    expect(reportRes.statusCode).toBe(200);
    const summary = reportRes.json().summary;

    expect(summary.sla_still_running).toBe(baseSummary.sla_still_running + 1);
    expect(summary.sla_met).toBe(baseSummary.sla_met + 1);
    expect(summary.sla_breached).toBe(baseSummary.sla_breached + 1);

    // Compliance percent uses only stopped clocks: met / (met + breached) * 100
    const expectedCompliance = Number(
      ((summary.sla_met / (summary.sla_met + summary.sla_breached)) * 100).toFixed(1),
    );
    expect(summary.sla_compliance_percent).toBeCloseTo(expectedCompliance, 1);
  });
});

describe("ticket merge", () => {
  it("keeps secondary requester as participant, copies attachments, and writes internal note without stamping first response", async () => {
    const adminCookie = await login("admin@acme.test");
    const emp1Cookie = await login("employee@acme.test");

    const emp2Id = "00000000-0000-0000-0000-000000000099";
    const emp2Email = "employee2@acme.test";
    await admin.query(
      `insert into users (id, email, password_hash, display_name)
       values ($1, $2, $3, 'Employee Two')
       on conflict (email) do nothing`,
      [emp2Id, emp2Email, hashPassword("Passw0rd!")],
    );
    await admin.query(
      `insert into memberships (tenant_id, user_id, role)
       values ($1, $2, 'employee')
       on conflict (tenant_id, user_id) do nothing`,
      [fixtures.acme.id, emp2Id],
    );
    const emp2Cookie = await login(emp2Email);

    // 1. Employee 1 creates Ticket A (primary)
    const ticketARes = await inject(emp1Cookie, {
      method: "POST",
      url: "/api/t/acme/tickets",
      payload: {
        subject: `Primary Ticket ${Date.now()}`,
        description: "Primary ticket body",
        categoryId: fixtures.acmeCategory,
        customFields: { site: "HQ" },
      },
    });
    expect(ticketARes.statusCode).toBe(200);
    const ticketA = ticketARes.json() as { id: string; number: number; first_responded_at: string | null };
    expect(ticketA.first_responded_at).toBeNull();

    // 2. Employee 2 creates Ticket B (secondary)
    const ticketBRes = await inject(emp2Cookie, {
      method: "POST",
      url: "/api/t/acme/tickets",
      payload: {
        subject: `Secondary Ticket ${Date.now()}`,
        description: "Secondary ticket body",
        categoryId: fixtures.acmeCategory,
        customFields: { site: "HQ" },
      },
    });
    expect(ticketBRes.statusCode).toBe(200);
    const ticketB = ticketBRes.json() as { id: string; number: number };

    // Attach a file to Ticket B
    const attId = "00000000-0000-0000-0000-000000000088";
    await admin.query(
      `insert into ticket_attachments (tenant_id, id, ticket_id, uploader_id, filename, content_type, size, storage_key)
       values ($1, $2, $3, $4, 'document.pdf', 'application/pdf', 1024, 'acme/test/document.pdf')`,
      [fixtures.acme.id, attId, ticketB.id, emp2Id],
    );

    // Verify Employee 2 cannot read Ticket A before merge
    const preCheck = await inject(emp2Cookie, {
      method: "GET",
      url: `/api/t/acme/tickets/${ticketA.id}`,
    });
    expect(preCheck.statusCode).toBe(404);

    // 3. Admin merges Ticket B into Ticket A
    const mergeRes = await inject(adminCookie, {
      method: "POST",
      url: `/api/t/acme/tickets/${ticketA.id}/merge`,
      payload: {
        targetTicketNumber: ticketB.number,
        direction: "merge_into_this",
        reason: "Duplicate issue",
      },
    });
    expect(mergeRes.statusCode, mergeRes.body).toBe(200);

    // 4. Verify attachments were copied to Ticket A and remain on Ticket B
    const attsOnPrimary = await admin.query<{ filename: string }>(
      `select id, filename from ticket_attachments where tenant_id = $1 and ticket_id = $2`,
      [fixtures.acme.id, ticketA.id],
    );
    expect(attsOnPrimary.rowCount).toBe(1);
    expect(attsOnPrimary.rows[0]?.filename).toBe("document.pdf");

    const attsOnSecondary = await admin.query(
      `select id from ticket_attachments where tenant_id = $1 and ticket_id = $2`,
      [fixtures.acme.id, ticketB.id],
    );
    expect(attsOnSecondary.rowCount).toBe(1);

    // 5. Verify Employee 2 is participant on Ticket A and can read Ticket A
    const participantRows = await admin.query(
      `select user_id from ticket_participants where tenant_id = $1 and ticket_id = $2 and user_id = $3`,
      [fixtures.acme.id, ticketA.id, emp2Id],
    );
    expect(participantRows.rowCount).toBe(1);

    const postCheck = await inject(emp2Cookie, {
      method: "GET",
      url: `/api/t/acme/tickets/${ticketA.id}`,
    });
    expect(postCheck.statusCode).toBe(200);

    const listRes = await inject(emp2Cookie, {
      method: "GET",
      url: "/api/t/acme/tickets",
    });
    expect(listRes.statusCode).toBe(200);
    const listedIds = (listRes.json().items as Array<{ id: string }>).map((item) => item.id);
    expect(listedIds).toContain(ticketA.id);

    // 6. Verify merge note is internal and first_responded_at was not stamped
    const detailAfter = (await inject(adminCookie, {
      method: "GET",
      url: `/api/t/acme/tickets/${ticketA.id}`,
    })).json() as { first_responded_at: string | null; comments: Array<{ visibility: string; body: string }> };
    expect(detailAfter.first_responded_at).toBeNull();

    const mergeNotes = detailAfter.comments.filter((c) => c.body.includes(`Merged ticket #${ticketB.number}`));
    expect(mergeNotes.length).toBeGreaterThan(0);
    for (const note of mergeNotes) {
      expect(note.visibility).toBe("internal");
    }

    // 7. Verify Employee 2 was notified of merge
    const notice = await admin.query<{ subject: string }>(
      `select subject, body, recipient_id from notifications
       where tenant_id = $1 and recipient_id = $2 and dedupe_key like '%ticket_merged%'`,
      [fixtures.acme.id, emp2Id],
    );
    expect(notice.rowCount).toBe(1);
    expect(notice.rows[0]?.subject).toContain(String(ticketA.number));
  });
});

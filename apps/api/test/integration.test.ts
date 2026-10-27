import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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
    const acmeAdmin = await login("admin@acme.test");
    const globexAdmin = await login("admin@globex.test");

    expect((await inject(acmeAdmin, { method: "GET", url: "/api/t/globex/tickets" })).statusCode).toBe(404);
    expect((await inject(acmeAdmin, { method: "GET", url: "/api/t/globex/users" })).statusCode).toBe(404);
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
    const ticket = created.json() as { id: string; number: number | string; version: number; status_stage: string };
    expect(ticket.status_stage).toBe("new");
    expect(Number(ticket.number)).toBeGreaterThan(0);

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
});

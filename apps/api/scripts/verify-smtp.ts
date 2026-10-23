import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer as createNetServer, type AddressInfo, type Server, type Socket } from "node:net";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { GenericContainer, Wait } from "testcontainers";
import pg from "pg";

const repoRoot = resolve(import.meta.dirname, "../../..");
const apiDir = resolve(repoRoot, "apps/api");
const dbDir = resolve(repoRoot, "packages/db");
const decoderPath = resolve(apiDir, "scripts/smtp-decoder.py");
const artifactDir = resolve(repoRoot, "docs/audit/evidence");
const appRole = "opspilot_app";
const appPassword = "opspilot_app_pw";
const python = process.env.PYTHON ?? "python3";

type EmailRow = {
  id: string;
  tenant_id: string | null;
  recipient: string;
  subject: string;
  body: string;
  delivery_status: string;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  provider_message_id: string | null;
  locked_until: string | null;
  sent_at: string | null;
};

type NotificationRow = {
  id: string;
  delivery_status: string;
  status: string;
  attempts: number;
  last_error: string | null;
  sent_at: string | null;
  subject: string;
  body: string;
};

type ScenarioResult = {
  name: string;
  status: "ok" | "error";
  durationMs: number;
  details?: unknown;
  error?: string;
};

type Decoded = {
  from: string;
  to: string;
  subject: string;
  messageId: string;
  returnPath: string;
  contentType: string;
  body: string;
  headers: Record<string, string[]>;
};

type MailpitMessage = {
  ID: string;
  Subject: string;
  To: Array<{ Address: string }>;
  From: Array<{ Address: string }>;
  Created: string;
  Size: number;
};

type SmtpAttempt = {
  at: string;
  from: string;
  to: string[];
  data: string;
  dialogue: string[];
  response: string;
};

type SmtpBehavior = (attempt: SmtpAttempt, index: number) => Promise<{ code: number; message: string; withhold?: boolean }>;

const results: ScenarioResult[] = [];
const activeChildren = new Set<ChildProcess>();

function line(message: string): void {
  console.error(`[verify:smtp] ${message}`);
}

async function waitFor<T>(label: string, timeoutMs: number, probe: () => Promise<T | null | undefined | false>): Promise<T> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await probe();
      if (value) return value as T;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${String(lastError)}` : ""}`);
}

class ScriptedSmtp {
  private server: Server | null = null;
  private sockets = new Set<Socket>();
  private behavior: SmtpBehavior;
  attempts: SmtpAttempt[] = [];
  accepted: SmtpAttempt[] = [];
  rejected: SmtpAttempt[] = [];

  constructor(behavior: SmtpBehavior) {
    this.behavior = behavior;
  }

  setBehavior(behavior: SmtpBehavior): void {
    this.behavior = behavior;
  }

  async start(): Promise<number> {
    this.server = createNetServer((socket) => this.handle(socket));
    await new Promise<void>((resolveListen) => this.server?.listen(0, "127.0.0.1", resolveListen));
    const address = this.server.address() as AddressInfo;
    return address.port;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (this.server) await new Promise<void>((resolveClose) => this.server?.close(() => resolveClose()));
    this.server = null;
  }

  private handle(socket: Socket): void {
    this.sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    let inData = false;
    let data = "";
    let from = "";
    let to: string[] = [];
    const dialogue: string[] = [];

    const write = (value: string): void => {
      dialogue.push(`S: ${value.trimEnd()}`);
      socket.write(value);
    };
    const reset = (): void => {
      from = "";
      to = [];
      data = "";
    };

    write("220 opspilot-audit ESMTP\r\n");

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (inData) {
        const marker = buffer.indexOf("\r\n.\r\n");
        if (marker === -1) return;
        data += buffer.slice(0, marker);
        buffer = buffer.slice(marker + 5);
        inData = false;
        const attempt: SmtpAttempt = {
          at: new Date().toISOString(),
          from,
          to,
          data,
          dialogue: [...dialogue],
          response: "",
        };
        dialogue.push("C: [DATA payload]");
        dialogue.push("C: .");
        this.attempts.push(attempt);
        void this.finish(attempt, indexForAttempt(this.attempts, attempt), write);
        return;
      }

      let newline = buffer.indexOf("\r\n");
      while (newline >= 0) {
        const command = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        dialogue.push(`C: ${command}`);
        const upper = command.toUpperCase();
        if (upper.startsWith("EHLO") || upper.startsWith("HELO")) {
          write("250 opspilot-audit\r\n");
        } else if (upper.startsWith("MAIL FROM:")) {
          reset();
          from = command.replace(/^MAIL FROM:\s*/i, "").replace(/[<>]/g, "").trim();
          write("250 2.1.0 OK\r\n");
        } else if (upper.startsWith("RCPT TO:")) {
          to.push(command.replace(/^RCPT TO:\s*/i, "").replace(/[<>]/g, "").trim());
          write("250 2.1.5 OK\r\n");
        } else if (upper === "DATA") {
          inData = true;
          data = "";
          write("354 End data with <CR><LF>.<CR><LF>\r\n");
        } else if (upper === "RSET") {
          reset();
          write("250 2.0.0 OK\r\n");
        } else if (upper === "NOOP") {
          write("250 2.0.0 OK\r\n");
        } else if (upper === "QUIT") {
          write("221 2.0.0 Bye\r\n");
          socket.end();
        } else if (upper.startsWith("AUTH")) {
          write("502 5.5.1 AUTH not supported\r\n");
        } else {
          write("250 2.0.0 OK\r\n");
        }
        newline = buffer.indexOf("\r\n");
      }
    });
    socket.on("error", () => this.sockets.delete(socket));
    socket.on("close", () => this.sockets.delete(socket));
  }

  private async finish(attempt: SmtpAttempt, index: number, write: (value: string) => void): Promise<void> {
    try {
      const response = await this.behavior(attempt, index);
      attempt.response = `${response.code} ${response.message}`;
      if (response.withhold) {
        attempt.dialogue.push("S: [NO RESPONSE - connection held open]");
        return;
      }
      if (response.code >= 200 && response.code < 300) this.accepted.push(attempt);
      else this.rejected.push(attempt);
      write(`${response.code} ${response.message}\r\n`);
    } catch (error) {
      attempt.response = `server error: ${String(error)}`;
      write("451 4.3.0 audit server error\r\n");
    }
  }
}

function indexForAttempt(attempts: SmtpAttempt[], attempt: SmtpAttempt): number {
  return attempts.indexOf(attempt);
}

function decodeMime(raw: string): Decoded {
  const stdout = execFileSync(python, [decoderPath], { input: raw, maxBuffer: 20 * 1024 * 1024 });
  return JSON.parse(stdout.toString()) as Decoded;
}

function redactToken(value: string): string {
  return value.length <= 8 ? "***" : `${value.slice(0, 6)}...(${value.length})`;
}

function tokenFromUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.pathname.startsWith("/invite/")) return decodeURIComponent(parsed.pathname.slice("/invite/".length));
  return parsed.searchParams.get("token") ?? "";
}

async function main(): Promise<void> {
  await mkdir(artifactDir, { recursive: true });
  line("starting Postgres, Mailpit, and GreenMail containers");
  const postgres = await new PostgreSqlContainer("postgres:17-alpine")
    .withDatabase("opspilot")
    .withUsername("postgres")
    .withPassword("opspilot")
    .start();
  const mailpit = await new GenericContainer("axllent/mailpit:v1.21.8")
    .withExposedPorts(1025, 8025)
    .withWaitStrategy(Wait.forHttp("/api/v1/messages", 8025).forStatusCode(200).withStartupTimeout(60_000))
    .start();
  const greenmail = await new GenericContainer("greenmail/standalone:2.1.0")
    .withExposedPorts(3025, 8080)
    .withWaitStrategy(Wait.forHttp("/api/user", 8080).forStatusCode(200).withStartupTimeout(60_000))
    .start();

  const adminUrl = postgres.getConnectionUri();
  const parsed = new URL(adminUrl);
  parsed.username = appRole;
  parsed.password = appPassword;
  const appUrl = parsed.toString();
  const mailpitHttp = `http://${mailpit.getHost()}:${mailpit.getMappedPort(8025)}`;
  const mailpitPort = mailpit.getMappedPort(1025);
  const greenmailHttp = `http://${greenmail.getHost()}:${greenmail.getMappedPort(8080)}`;
  const greenmailPort = greenmail.getMappedPort(3025);

  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ADMIN_DATABASE_URL: adminUrl,
    APP_DATABASE_URL: appUrl,
    APP_DB_ROLE: appRole,
    APP_DB_PASSWORD: appPassword,
    WORKER_DATABASE_URL: adminUrl,
    PUBLIC_API_URL: "http://127.0.0.1:4310/api",
    WEB_ORIGIN: "http://127.0.0.1:5173",
    SESSION_COOKIE_SECURE: "false",
    N8N_WEBHOOK_URL: "http://127.0.0.1:9/audit-disabled",
    N8N_WEBHOOK_SECRET: "smtp-audit-disabled",
    LOG_LEVEL: "info",
    WORKER_POLL_MS: "200",
    MAINTENANCE_INTERVAL_MS: "600000",
    SMTP_HOST: "",
    SMTP_PORT: "",
    SMTP_SECURE: "false",
    SMTP_USER: "",
    SMTP_PASS: "",
    SMTP_FROM: "OpsPilot Audit <no-reply@opspilot.local>",
    SMTP_REPLY_TO: "",
  };

  const runDb = (script: "role" | "migrate" | "seed"): void => {
    const result = spawnSync(process.execPath, ["--import", "tsx", `src/${script}.ts`], {
      cwd: dbDir,
      env: baseEnv,
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(`db ${script} failed: ${result.stderr || result.stdout}`);
    line(`db ${script} done`);
  };
  runDb("role");
  runDb("migrate");
  runDb("seed");

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();

  const tenant = await admin.query<{ id: string; slug: string; name: string }>(
    "select id, slug, name from tenants where slug = 'acme'",
  );
  const tenantId = tenant.rows[0]?.id;
  if (!tenantId) throw new Error("seed did not create acme tenant");
  const recipient = await admin.query<{ user_id: string; email: string }>(
    `select m.user_id, u.email from memberships m join users u on u.id = m.user_id
     where m.tenant_id = $1 and u.email = 'employee@acme.test'`,
    [tenantId],
  );
  const recipientId = recipient.rows[0]?.user_id;
  const recipientEmail = recipient.rows[0]?.email;
  if (!recipientId || !recipientEmail) throw new Error("seed did not create employee@acme.test");

  const insertEmail = async (input: {
    subject: string;
    body: string;
    recipient?: string;
    attempts?: number;
    tenant?: string | null;
  }): Promise<EmailRow> => {
    const row = await admin.query<EmailRow>(
      `insert into email_messages (tenant_id, recipient, subject, body, attempts)
       values ($1, $2, $3, $4, $5) returning *`,
      [input.tenant === undefined ? tenantId : input.tenant, input.recipient ?? recipientEmail, input.subject, input.body, input.attempts ?? 0],
    );
    const created = row.rows[0];
    if (!created) throw new Error("failed to insert email_messages row");
    return created;
  };

  const insertNotification = async (input: { subject: string; body: string; recipientId?: string }): Promise<NotificationRow> => {
    const event = await admin.query<{ id: string }>(
      `insert into outbox_events
         (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, payload, idempotency_key)
       values ($1, 'smtp_audit', $2, 1, 'smtp.audit', '{}'::jsonb, $3)
       returning id`,
      [tenantId, randomUUID(), `smtp-audit-${randomUUID()}`],
    );
    const eventId = event.rows[0]?.id;
    if (!eventId) throw new Error("failed to insert outbox event");
    const ticket = await admin.query<{ id: string }>("select id from tickets where tenant_id = $1 limit 1", [tenantId]);
    const ticketId = ticket.rows[0]?.id;
    if (!ticketId) throw new Error("seed did not create a ticket");
    const row = await admin.query<NotificationRow>(
      `insert into notifications
         (tenant_id, event_id, ticket_id, recipient_id, channel, dedupe_key, status, subject, body)
       values ($1, $2, $3, $4, 'email', $5, 'sent', $6, $7)
       returning id, delivery_status, status, attempts, last_error, sent_at, subject, body`,
      [tenantId, eventId, ticketId, input.recipientId ?? recipientId, `smtp-audit-${randomUUID()}`, input.subject, input.body],
    );
    const created = row.rows[0];
    if (!created) throw new Error("failed to insert notifications row");
    return created;
  };

  const emailRow = async (id: string): Promise<EmailRow> => {
    const row = await admin.query<EmailRow>("select * from email_messages where id = $1", [id]);
    const value = row.rows[0];
    if (!value) throw new Error(`email ${id} disappeared`);
    return value;
  };

  const notificationRow = async (id: string): Promise<NotificationRow> => {
    const row = await admin.query<NotificationRow>(
      "select id, delivery_status, status, attempts, last_error, sent_at, subject, body from notifications where id = $1",
      [id],
    );
    const value = row.rows[0];
    if (!value) throw new Error(`notification ${id} disappeared`);
    return value;
  };

  const resetQueue = async (): Promise<void> => {
    await admin.query("drop trigger if exists smtp_audit_slow_update on email_messages");
    await admin.query("delete from notifications");
    await admin.query("delete from email_messages");
    await admin.query("update tenants set status = 'active'");
    await admin.query("delete from user_invitations where email = 'invitee-audit@acme.test'");
  };

  const startWorker = (extra: NodeJS.ProcessEnv = {}, dbUrl = adminUrl): ChildProcess => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/worker.ts"], {
      cwd: apiDir,
      env: { ...baseEnv, WORKER_DATABASE_URL: dbUrl, ...extra },
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeChildren.add(child);
    const logs: string[] = [];
    child.stdout?.on("data", (data: Buffer) => logs.push(data.toString()));
    child.stderr?.on("data", (data: Buffer) => logs.push(data.toString()));
    child.on("exit", () => activeChildren.delete(child));
    (child as ChildProcess & { auditLogs?: string[] }).auditLogs = logs;
    return child;
  };

  const stopChild = async (child: ChildProcess | null, signal: NodeJS.Signals = "SIGTERM"): Promise<void> => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolveStop) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolveStop();
      }, 3000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolveStop();
      });
      child.kill(signal);
    });
    activeChildren.delete(child);
  };

  const workerLogs = (child: ChildProcess): string[] => (child as ChildProcess & { auditLogs?: string[] }).auditLogs ?? [];

  const mailpitList = async (): Promise<MailpitMessage[]> => {
    const response = await fetch(`${mailpitHttp}/api/v1/messages`);
    if (!response.ok) throw new Error(`Mailpit list failed: ${response.status}`);
    const data = (await response.json()) as { messages?: MailpitMessage[] };
    return data.messages ?? [];
  };

  const mailpitForSubject = async (subject: string): Promise<MailpitMessage[]> =>
    (await mailpitList()).filter((message) => message.Subject === subject);

  const mailpitRaw = async (id: string): Promise<string> => {
    const response = await fetch(`${mailpitHttp}/api/v1/message/${encodeURIComponent(id)}/raw`);
    if (!response.ok) throw new Error(`Mailpit raw failed: ${response.status}`);
    return response.text();
  };

  const greenmailRaw = async (address: string): Promise<string[]> => {
    const response = await fetch(`${greenmailHttp}/api/user/${encodeURIComponent(address)}/messages`);
    if (!response.ok) return [];
    const data = (await response.json()) as Array<{ mimeMessage: string }>;
    return data.map((entry) => entry.mimeMessage);
  };

  const installSlowTrigger = async (subject: string): Promise<void> => {
    const escaped = subject.replaceAll("'", "''");
    await admin.query(`
      create or replace function smtp_audit_slow_update() returns trigger language plpgsql as $fn$
      begin
        if new.subject = '${escaped}' then perform pg_sleep(8); end if;
        return new;
      end
      $fn$`);
    await admin.query("drop trigger if exists smtp_audit_slow_update on email_messages");
    await admin.query(`
      create trigger smtp_audit_slow_update before update on email_messages
      for each row execute function smtp_audit_slow_update()`);
  };

  const dropSlowTrigger = async (): Promise<void> => {
    await admin.query("drop trigger if exists smtp_audit_slow_update on email_messages");
  };

  const scenario = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
    line(`scenario ${name}`);
    await resetQueue();
    const started = Date.now();
    try {
      const details = await fn();
      results.push({ name, status: "ok", durationMs: Date.now() - started, details });
      line(`scenario ${name} ok`);
    } catch (error) {
      results.push({ name, status: "error", durationMs: Date.now() - started, error: String(error) });
      line(`scenario ${name} ERROR ${String(error)}`);
    } finally {
      for (const child of [...activeChildren]) await stopChild(child, "SIGKILL");
    }
  };

  const apiBase = async (): Promise<{ url: string; port: number }> => {
    const probe = createNetServer();
    await new Promise<void>((resolveListen) => probe.listen(0, "127.0.0.1", resolveListen));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolveClose) => probe.close(() => resolveClose()));
    return { url: `http://127.0.0.1:${port}`, port };
  };

  const startApi = async (port: number): Promise<ChildProcess> => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: apiDir,
      env: { ...baseEnv, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeChildren.add(child);
    const logs: string[] = [];
    child.stdout?.on("data", (data: Buffer) => logs.push(data.toString()));
    child.stderr?.on("data", (data: Buffer) => logs.push(data.toString()));
    child.on("exit", () => activeChildren.delete(child));
    (child as ChildProcess & { auditLogs?: string[] }).auditLogs = logs;
    await waitFor("API health", 20_000, async () => {
      if (child.exitCode !== null) throw new Error(`API exited: ${logs.join("")}`);
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      return response.ok;
    });
    return child;
  };

  const archiveCount = async (subject: string): Promise<number> => (await mailpitForSubject(subject)).length;

  await scenario("baseline-real-reset-and-invite", async () => {
    const { url, port } = await apiBase();
    const api = await startApi(port);
    try {
      const login = await fetch(`${url}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "admin@acme.test", password: "Passw0rd!" }),
      });
      if (!login.ok) throw new Error(`login failed: ${login.status} ${await login.text()}`);
      const setCookies = login.headers.getSetCookie();
      const cookie = setCookies.map((value) => value.split(";")[0]).find((value) => value?.startsWith("opspilot_session="));
      if (!cookie) throw new Error("login did not return a session cookie");

      const resetResponse = await fetch(`${url}/api/auth/password/reset/request`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: recipientEmail }),
      });
      if (!resetResponse.ok) throw new Error(`reset request failed: ${resetResponse.status} ${await resetResponse.text()}`);

      const inviteResponse = await fetch(`${url}/api/t/acme/invitations`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ email: "invitee-audit@acme.test", role: "employee", teamIds: [] }),
      });
      if (!inviteResponse.ok) throw new Error(`invite failed: ${inviteResponse.status} ${await inviteResponse.text()}`);
    } finally {
      await stopChild(api);
    }

    const pending = await waitFor("two queued emails", 10_000, async () => {
      const rows = await admin.query<EmailRow>(
        "select * from email_messages where recipient in ($1, 'invitee-audit@acme.test') order by created_at",
        [recipientEmail],
      );
      return rows.rows.length >= 2 ? rows.rows : null;
    });

    const worker = startWorker({ SMTP_HOST: "127.0.0.1", SMTP_PORT: String(mailpitPort) });
    await waitFor("baseline emails sent", 20_000, async () => {
      const sent = await admin.query<{ count: number }>(
        "select count(*)::int as count from email_messages where delivery_status = 'sent'",
      );
      return sent.rows[0]?.count === 2;
    });
    await stopChild(worker);

    const evidence = [];
    for (const row of pending) {
      const messages = await mailpitForSubject(row.subject);
      if (messages.length !== 1) throw new Error(`expected one archive row for ${row.subject}, got ${messages.length}`);
      const first = messages[0];
      if (!first) throw new Error("archive message disappeared");
      const raw = await mailpitRaw(first.ID);
      const decoded = decodeMime(raw);
      const urls = row.body.match(/https?:\/\/[^\s]+/g) ?? [];
      const url = urls.find((candidate) => candidate.includes("token=") || candidate.includes("/invite/"));
      if (!url) throw new Error(`no token URL in queued body for ${row.subject}`);
      const token = tokenFromUrl(url);
      evidence.push({
        subject: row.subject,
        recipient: row.recipient,
        queuedBodyContainsExactUrl: row.body.includes(url),
        archivedBodyContainsExactUrl: decoded.body.includes(url),
        tokenSha256: createHash("sha256").update(token).digest("hex"),
        tokenRedacted: redactToken(token),
        archiveCount: messages.length,
        from: decoded.from,
        to: decoded.to,
        messageId: decoded.messageId,
        contentType: decoded.contentType,
      });
    }
    const tokenBodies = pending.map((row) => row.body).join("\n");
    const tokens = [...tokenBodies.matchAll(/https?:\/\/[^\s]+/g)]
      .map((match) => tokenFromUrl(match[0]))
      .filter(Boolean);
    return {
      emailsQueued: pending.length,
      evidence,
      workerLogContainsToken: workerLogs(worker).some((entry) => tokens.some((token) => entry.includes(token))),
    };
  });

  await scenario("backup-contains-cleartext-token", async () => {
    const token = `backup-token-${randomUUID()}`;
    const row = await insertEmail({
      subject: "Audit backup token",
      body: `Reset: http://127.0.0.1:5173/reset-password?token=${token}`,
    });
    const dump = spawnSync("docker", ["exec", postgres.getId(), "pg_dump", "-U", "postgres", "opspilot"], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    if (dump.status !== 0) throw new Error(`pg_dump failed: ${dump.stderr}`);
    const worker = startWorker({ SMTP_HOST: "127.0.0.1", SMTP_PORT: String(mailpitPort) });
    await waitFor("backup email sent", 20_000, async () => (await emailRow(row.id)).delivery_status === "sent");
    await stopChild(worker);
    return {
      tokenSha256: createHash("sha256").update(token).digest("hex"),
      tokenOccurrencesInDump: dump.stdout.split(token).length - 1,
      tokenPresentInWorkerLogs: workerLogs(worker).some((entry) => entry.includes(token)),
      tokenRecipientVisibleInDump: dump.stdout.includes(recipientEmail),
    };
  });

  await scenario("greenmail-independent-archive", async () => {
    const subject = "Audit GreenMail token";
    const url = `http://127.0.0.1:5173/reset-password?token=greenmail-token-${randomUUID()}`;
    const row = await insertEmail({ subject, body: `GreenMail body\n\nReset: ${url}\n` });
    const worker = startWorker({ SMTP_HOST: "127.0.0.1", SMTP_PORT: String(greenmailPort) });
    await waitFor("greenmail email sent", 20_000, async () => (await emailRow(row.id)).delivery_status === "sent");
    await stopChild(worker);
    const archived = await waitFor("greenmail archive", 10_000, async () => {
      const messages = await greenmailRaw(recipientEmail);
      return messages.length > 0 ? messages : null;
    });
    const decoded = decodeMime(archived[0] ?? "");
    return {
      archivedCount: archived.length,
      subject: decoded.subject,
      to: decoded.to,
      exactUrlPresent: decoded.body.includes(url),
      tokenSha256: createHash("sha256").update(tokenFromUrl(url)).digest("hex"),
    };
  });

  await scenario("skipped-is-terminal", async () => {
    const token = `skipped-token-${randomUUID()}`;
    const email = await insertEmail({
      subject: "Audit skipped email",
      body: `Reset: http://127.0.0.1:5173/reset-password?token=${token}`,
    });
    const notification = await insertNotification({
      subject: "Audit skipped notification",
      body: `Notification reset token ${token}`,
    });

    const noSmtp = startWorker({ SMTP_HOST: "", SMTP_PORT: "" });
    await waitFor("email skipped", 15_000, async () => (await emailRow(email.id)).delivery_status === "skipped");
    await waitFor("notification skipped", 15_000, async () => (await notificationRow(notification.id)).delivery_status === "skipped");
    await stopChild(noSmtp);
    const afterSkip = {
      email: await emailRow(email.id),
      notification: await notificationRow(notification.id),
    };

    const withSmtp = startWorker({ SMTP_HOST: "127.0.0.1", SMTP_PORT: String(mailpitPort) });
    await sleep(4000);
    await stopChild(withSmtp);
    return {
      afterSkip: {
        emailStatus: afterSkip.email.delivery_status,
        emailError: afterSkip.email.last_error,
        notificationDelivery: afterSkip.notification.delivery_status,
        notificationLegacyStatus: afterSkip.notification.status,
        notificationError: afterSkip.notification.last_error,
      },
      afterSmtpConfigured: {
        emailStatus: (await emailRow(email.id)).delivery_status,
        emailAttempts: (await emailRow(email.id)).attempts,
        notificationDelivery: (await notificationRow(notification.id)).delivery_status,
        notificationLegacyStatus: (await notificationRow(notification.id)).status,
        archivedEmails: await archiveCount(email.subject),
      },
      cleartextTokenStillInBody: (await emailRow(email.id)).body.includes(token),
    };
  });

  await scenario("retry-451-then-250", async () => {
    const subject = "Audit 451 retry";
    const row = await insertEmail({ subject, body: "451 retry body" });
    let attempt = 0;
    const smtp = new ScriptedSmtp(async () => {
      attempt += 1;
      return attempt === 1
        ? { code: 451, message: "4.3.0 temporary failure" }
        : { code: 250, message: "2.0.0 accepted" };
    });
    const port = await smtp.start();
    const worker = startWorker({ SMTP_HOST: "127.0.0.1", SMTP_PORT: String(port) });
    try {
      await waitFor("451 then successful retry", 20_000, async () => (await emailRow(row.id)).delivery_status === "sent");
    } finally {
      await stopChild(worker);
      await smtp.stop();
    }
    return {
      smtpAttempts: smtp.attempts.length,
      smtpAccepted: smtp.accepted.length,
      smtpRejected: smtp.rejected.length,
      firstResponse: smtp.attempts[0]?.response,
      secondResponse: smtp.attempts[1]?.response,
      row: await emailRow(row.id),
      firstDialogue: smtp.attempts[0]?.dialogue,
    };
  });

  await scenario("permanent-550", async () => {
    const subject = "Audit 550 permanent";
    const row = await insertEmail({ subject, body: "550 body", attempts: 4 });
    const smtp = new ScriptedSmtp(async () => ({ code: 550, message: "5.1.1 no such user" }));
    const port = await smtp.start();
    const worker = startWorker({ SMTP_HOST: "127.0.0.1", SMTP_PORT: String(port) });
    try {
      await waitFor("550 row failed", 20_000, async () => (await emailRow(row.id)).delivery_status === "failed");
    } finally {
      await stopChild(worker);
      await smtp.stop();
    }
    return {
      smtpAttempts: smtp.attempts.length,
      smtpRejected: smtp.rejected.length,
      archivedEmails: await archiveCount(subject),
      row: await emailRow(row.id),
      dialogue: smtp.attempts[0]?.dialogue,
    };
  });

  await scenario("accept-then-withhold-stalls-worker", async () => {
    const first = await insertEmail({ subject: "Audit hang first", body: "hang first" });
    const second = await insertEmail({ subject: "Audit hang second", body: "hang second" });
    const smtp = new ScriptedSmtp(async () => ({ code: 250, message: "2.0.0 queued but response withheld", withhold: true }));
    const port = await smtp.start();
    const worker = startWorker({ SMTP_HOST: "127.0.0.1", SMTP_PORT: String(port), WORKER_POLL_MS: "500" });
    const started = Date.now();
    let after5s: { first: EmailRow; second: EmailRow; attempts: number } | null = null;
    let afterTimeout: { first: EmailRow; second: EmailRow; attempts: number; elapsedMs: number } | null = null;
    try {
      await waitFor("server received DATA", 15_000, async () => smtp.attempts.length >= 1);
      await sleep(5000);
      after5s = { first: await emailRow(first.id), second: await emailRow(second.id), attempts: smtp.attempts.length };
      await waitFor("worker to abandon withheld response", 45_000, async () => smtp.attempts.length >= 2);
      await sleep(500);
      afterTimeout = {
        first: await emailRow(first.id),
        second: await emailRow(second.id),
        attempts: smtp.attempts.length,
        elapsedMs: Date.now() - started,
      };
    } finally {
      await stopChild(worker, "SIGKILL");
      await smtp.stop();
    }
    return {
      after5s: {
        smtpAttempts: after5s?.attempts,
        firstStatus: after5s?.first.delivery_status,
        firstAttempts: after5s?.first.attempts,
        firstLockedUntil: after5s?.first.locked_until,
        secondStatus: after5s?.second.delivery_status,
        secondAttempts: after5s?.second.attempts,
        secondLockedUntil: after5s?.second.locked_until,
      },
      afterTimeout: {
        smtpAttempts: afterTimeout?.attempts,
        firstStatus: afterTimeout?.first.delivery_status,
        firstAttempts: afterTimeout?.first.attempts,
        firstLastError: afterTimeout?.first.last_error,
        firstLockedUntil: afterTimeout?.first.locked_until,
        secondStatus: afterTimeout?.second.delivery_status,
        secondAttempts: afterTimeout?.second.attempts,
        secondLockedUntil: afterTimeout?.second.locked_until,
        elapsedMs: afterTimeout?.elapsedMs,
      },
      secondWasStarvedAt5s: after5s?.second.attempts === 0 && after5s?.second.delivery_status === "pending",
      recoveredAfterTimeout: (afterTimeout?.attempts ?? 0) >= 2,
      serverDialogue: smtp.attempts[0]?.dialogue,
    };
  });

  await scenario("kill-after-250-before-update", async () => {
    const subject = "Audit kill after 250";
    const row = await insertEmail({ subject, body: "kill after 250" });
    await installSlowTrigger(subject);
    const smtp = new ScriptedSmtp(async () => ({ code: 250, message: "2.0.0 accepted" }));
    const port = await smtp.start();
    const worker = startWorker({ SMTP_HOST: "127.0.0.1", SMTP_PORT: String(port) });
    let postKill: EmailRow | null = null;
    try {
      await waitFor("SMTP 250", 15_000, async () => smtp.accepted.length >= 1);
      await sleep(1000);
      await stopChild(worker, "SIGKILL");
      await sleep(500);
      postKill = await emailRow(row.id);
    } finally {
      await dropSlowTrigger();
    }
    await sleep(9000);
    const afterDbSleep = await emailRow(row.id);
    const acceptedBeforeRestart = smtp.accepted.length;
    if (afterDbSleep.delivery_status === "pending") {
      await admin.query("update email_messages set locked_until = null where id = $1", [row.id]);
      const restarted = startWorker({ SMTP_HOST: "127.0.0.1", SMTP_PORT: String(port) });
      try {
        await waitFor("second send after crash", 20_000, async () => smtp.accepted.length >= 2);
      } catch {
        // A non-retry means the orphaned UPDATE committed after the worker died.
      } finally {
        await stopChild(restarted);
      }
    }
    await smtp.stop();
    return {
      smtpAcceptedBeforeRestart: acceptedBeforeRestart,
      smtpAcceptedAfterRestart: smtp.accepted.length,
      postKill: postKill && {
        deliveryStatus: postKill.delivery_status,
        attempts: postKill.attempts,
        lockedUntil: postKill.locked_until,
      },
      afterDbSleep: {
        deliveryStatus: afterDbSleep.delivery_status,
        attempts: afterDbSleep.attempts,
        sentAt: afterDbSleep.sent_at,
        providerMessageId: afterDbSleep.provider_message_id,
      },
      orphanedUpdateCommitted: afterDbSleep.delivery_status === "sent",
      duplicated: smtp.accepted.length > 1,
    };
  });

  await scenario("terminate-pg-backend-after-250", async () => {
    const subject = "Audit terminate backend";
    const row = await insertEmail({ subject, body: "terminate backend" });
    await installSlowTrigger(subject);
    const smtp = new ScriptedSmtp(async () => ({ code: 250, message: "2.0.0 accepted" }));
    const port = await smtp.start();
    const worker = startWorker({ SMTP_HOST: "127.0.0.1", SMTP_PORT: String(port) });
    let terminatedPid: number | null = null;
    let postTerminate: EmailRow | null = null;
    try {
      await waitFor("SMTP 250", 15_000, async () => smtp.accepted.length >= 1);
      const backend = await waitFor("worker UPDATE backend", 10_000, async () => {
        const query = await admin.query<{ pid: number }>(
          `select pid from pg_stat_activity
           where datname = current_database() and pid <> pg_backend_pid()
             and state = 'active' and query ilike 'update email_messages%'
           limit 1`,
        );
        return query.rows[0]?.pid ?? null;
      });
      terminatedPid = backend;
      await admin.query("select pg_terminate_backend($1)", [backend]);
      await sleep(300);
      await stopChild(worker, "SIGKILL");
      await sleep(300);
      postTerminate = await emailRow(row.id);
    } finally {
      await dropSlowTrigger();
    }
    const acceptedBeforeRestart = smtp.accepted.length;
    if (postTerminate.delivery_status === "pending") {
      await admin.query("update email_messages set locked_until = null where id = $1", [row.id]);
      const restarted = startWorker({ SMTP_HOST: "127.0.0.1", SMTP_PORT: String(port) });
      try {
        await waitFor("second send after backend termination", 20_000, async () => smtp.accepted.length >= 2);
      } catch {
        // no retry
      } finally {
        await stopChild(restarted);
      }
    }
    await smtp.stop();
    return {
      terminatedPid,
      smtpAcceptedBeforeRestart: acceptedBeforeRestart,
      smtpAcceptedAfterRestart: smtp.accepted.length,
      postTerminate: postTerminate && {
        deliveryStatus: postTerminate.delivery_status,
        attempts: postTerminate.attempts,
        lastError: postTerminate.last_error,
        lockedUntil: postTerminate.locked_until,
        sentAt: postTerminate.sent_at,
        providerMessageId: postTerminate.provider_message_id,
      },
      duplicated: smtp.accepted.length > 1,
      workerLogs: workerLogs(worker).slice(-8),
    };
  });

  await scenario("two-workers-one-queue", async () => {
    const subjects: string[] = [];
    for (let index = 0; index < 20; index += 1) {
      const subject = `Audit concurrent ${index}`;
      subjects.push(subject);
      await insertEmail({ subject, body: `concurrent body ${index}` });
    }
    const first = startWorker({ SMTP_HOST: "127.0.0.1", SMTP_PORT: String(mailpitPort) });
    const second = startWorker({ SMTP_HOST: "127.0.0.1", SMTP_PORT: String(mailpitPort) });
    try {
      await waitFor("20 concurrent emails sent", 30_000, async () => {
        const sent = await admin.query<{ count: number }>(
          "select count(*)::int as count from email_messages where delivery_status = 'sent'",
        );
        return sent.rows[0]?.count === 20;
      });
    } finally {
      await stopChild(first);
      await stopChild(second);
    }
    const archive = await mailpitList();
    const counts = subjects.map((subject) => ({
      subject,
      archived: archive.filter((message) => message.Subject === subject).length,
    }));
    return {
      sent: 20,
      archivedTotal: counts.reduce((total, entry) => total + entry.archived, 0),
      maxCopiesPerSubject: Math.max(...counts.map((entry) => entry.archived)),
      missing: counts.filter((entry) => entry.archived === 0).map((entry) => entry.subject),
      duplicated: counts.filter((entry) => entry.archived > 1),
    };
  });

  await scenario("app-role-cannot-see-notifications", async () => {
    const email = await insertEmail({ subject: "Audit app role email", body: "app role email" });
    const notification = await insertNotification({ subject: "Audit app role notification", body: "app role notification" });
    const appClient = new pg.Client({ connectionString: appUrl });
    await appClient.connect();
    let visibility: { email: number; notifications: number; tenants: number };
    try {
      const emailCount = await appClient.query<{ count: number }>("select count(*)::int as count from email_messages");
      const notificationCount = await appClient.query<{ count: number }>("select count(*)::int as count from notifications");
      const tenantCount = await appClient.query<{ count: number }>("select count(*)::int as count from tenants");
      visibility = {
        email: emailCount.rows[0]?.count ?? -1,
        notifications: notificationCount.rows[0]?.count ?? -1,
        tenants: tenantCount.rows[0]?.count ?? -1,
      };
    } finally {
      await appClient.end();
    }
    const worker = startWorker({ SMTP_HOST: "127.0.0.1", SMTP_PORT: String(mailpitPort) }, appUrl);
    try {
      await waitFor("email sent under app role", 20_000, async () => (await emailRow(email.id)).delivery_status === "sent");
      await sleep(1000);
    } finally {
      await stopChild(worker);
    }
    return {
      appRoleVisibility: visibility,
      emailStatus: (await emailRow(email.id)).delivery_status,
      notificationDelivery: (await notificationRow(notification.id)).delivery_status,
      notificationLegacyStatus: (await notificationRow(notification.id)).status,
      notificationStillPending: (await notificationRow(notification.id)).delivery_status === "pending",
      workerLogs: workerLogs(worker).slice(-6),
    };
  });

  await scenario("suspended-tenant-still-sends", async () => {
    const subject = "Audit suspended tenant";
    await admin.query("update tenants set status = 'suspended' where id = $1", [tenantId]);
    const row = await insertEmail({ subject, body: "suspended tenant body" });
    const worker = startWorker({ SMTP_HOST: "127.0.0.1", SMTP_PORT: String(mailpitPort) });
    try {
      await waitFor("suspended tenant email sent", 20_000, async () => (await emailRow(row.id)).delivery_status === "sent");
    } finally {
      await stopChild(worker);
      await admin.query("update tenants set status = 'active' where id = $1", [tenantId]);
    }
    return {
      tenantStatusAtSend: "suspended",
      emailStatus: (await emailRow(row.id)).delivery_status,
      archivedEmails: await archiveCount(subject),
    };
  });

  await scenario("notification-delivery-and-legacy-status", async () => {
    const email = await insertEmail({
      subject: "Audit final email token",
      body: "Reset: http://127.0.0.1:5173/reset-password?token=final-audit-token",
    });
    const notification = await insertNotification({
      subject: "Audit notification delivery",
      body: "notification delivery body",
    });
    const worker = startWorker({ SMTP_HOST: "127.0.0.1", SMTP_PORT: String(mailpitPort) });
    try {
      await waitFor("notification delivered", 20_000, async () => (await notificationRow(notification.id)).delivery_status === "sent");
      await waitFor("email delivered", 20_000, async () => (await emailRow(email.id)).delivery_status === "sent");
    } finally {
      await stopChild(worker);
    }
    const messages = await mailpitForSubject(notification.subject);
    const decoded = messages[0] ? decodeMime(await mailpitRaw(messages[0].ID)) : null;
    return {
      notification: await notificationRow(notification.id),
      notificationArchived: messages.length,
      notificationDecodedSubject: decoded?.subject,
      notificationTo: decoded?.to,
      emailStatus: (await emailRow(email.id)).delivery_status,
      legacyStatusAlwaysSent: (await notificationRow(notification.id)).status === "sent",
    };
  });

  const invariantScript = resolve(apiDir, "scripts/smtp-invariants.ts");
  const invariant = spawnSync(process.execPath, ["--import", "tsx", invariantScript], {
    cwd: apiDir,
    env: { ...baseEnv, AUDIT_DATABASE_URL: adminUrl, APP_DATABASE_URL: appUrl },
    encoding: "utf8",
  });
  const invariantOutput = invariant.stdout || invariant.stderr;
  const sourceHashes = {
    worker: createHash("sha256").update(await readFile(resolve(apiDir, "src/worker.ts"))).digest("hex"),
    mailer: createHash("sha256").update(await readFile(resolve(apiDir, "src/mailer.ts"))).digest("hex"),
    emailQueue: createHash("sha256").update(await readFile(resolve(apiDir, "src/emailQueue.ts"))).digest("hex"),
  };
  const output = {
    generatedAt: new Date().toISOString(),
    host: process.platform,
    node: process.version,
    sourceHashes,
    containers: {
      postgres: postgres.getHost(),
      mailpit: mailpitHttp,
      greenmail: greenmailHttp,
    },
    results,
    invariants: invariantOutput,
  };
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  await writeFile(resolve(artifactDir, `smtp-run-${timestamp}.json`), JSON.stringify(output, null, 2));
  await writeFile(resolve(artifactDir, "latest.json"), JSON.stringify(output, null, 2));
  console.log(JSON.stringify({
    artifact: resolve(artifactDir, "latest.json"),
    scenarios: results.map((result) => ({ name: result.name, status: result.status, durationMs: result.durationMs, error: result.error })),
  }, null, 2));

  await admin.end();
  await Promise.allSettled([postgres.stop(), mailpit.stop(), greenmail.stop()]);

  if (results.some((result) => result.status === "error")) process.exitCode = 1;
}

main().catch(async (error) => {
  for (const child of activeChildren) {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore cleanup errors
    }
  }
  console.error(error);
  process.exitCode = 1;
});

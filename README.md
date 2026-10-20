# OpsPilot

Multi-tenant IT service desk with a TypeScript API, React UI, PostgreSQL row-level security, and n8n automation.

## Status

The product core is implemented: tenant-aware ticket lifecycle, role-scoped queues, configuration, SLA tracking, attachments, queued email/SMTP delivery, audit history, transactional outbox, n8n routing, workspace people management, custom roles, platform tenant onboarding, reporting dashboards, and feedback/CSAT collection.

## Stack

- pnpm workspace, TypeScript, Node 24
- React 19, React Router, Vite
- Fastify, Zod, `pg`
- PostgreSQL 17 with RLS
- n8n Community Edition, self-hosted

## Layout

| Path | Purpose |
|---|---|
| `apps/api` | Fastify API, session auth, ticket/domain routes, outbox worker |
| `apps/web` | React UI: queue, ticket detail, workspace admin |
| `packages/core` | Shared Zod schemas, roles, stages, routing matcher, password hashing |
| `packages/db` | SQL migrations, app role creation, demo seed |
| `deploy/n8n` | Importable routing workflow |
| `deploy/nginx.conf` | Static web serving and `/api` proxy |
| `compose.yaml` | PostgreSQL, bootstrap, API, worker, web, n8n |

## Local setup

Requires Node 24+, Corepack, and PostgreSQL 17.

```bash
cp .env.example .env
createdb opspilot
corepack enable
pnpm install
pnpm db:role
pnpm db:migrate
pnpm db:seed
pnpm dev:api
```

In a second terminal:

```bash
pnpm dev:web
```

API: `http://localhost:3000`  
Web: `http://localhost:5173`

Start the automation worker when n8n is available:

```bash
pnpm worker
```

Demo accounts use password `Passw0rd!`:

| Tenant | Email | Role |
|---|---|---|
| acme | admin@acme.test | tenant_admin |
| acme | agent@acme.test | agent |
| acme | employee@acme.test | employee |
| globex | admin@globex.test | tenant_admin |
| globex | agent@globex.test | agent |
| globex | employee@globex.test | employee |
| — | platform@opspilot.test | platform admin |

## Docker Compose demo

```bash
docker compose up --build
```

- Web: `http://localhost:8080`
- API: `http://localhost:3000`
- n8n: `http://localhost:5678`
- PostgreSQL: `localhost:5433`

The one-shot `bootstrap` service creates the non-owner app role, applies migrations, and seeds the demo tenants. It re-seeds on every `docker compose up`, resetting demo data. The n8n container imports and activates `deploy/n8n/workflow.json`.

## Tenancy and security

- Shared schema, `tenant_id` on every tenant-owned row, RLS enabled and forced.
- The API connects as a non-owner role without `BYPASSRLS`; transactions set `app.user_id` and `app.tenant_id`.
- Composite foreign keys include `tenant_id`, so cross-tenant references fail even if a client bypasses a route check.
- Global users with per-tenant memberships; tenant URLs are path-based (`/t/:tenantSlug`).
- Platform admins are modeled separately and are not tenant members by default.
- Passwords use scrypt; sessions use random tokens stored as SHA-256 hashes in HttpOnly cookies.
- Users can review and revoke their sessions, change passwords, and use one-time password-reset links.
- Workspace admins invite people, assign roles and teams, deactivate members, and cannot remove the last active administrator.
- Custom roles keep a base role for ticket lifecycle semantics while granting a tenant-defined permission set.
- Permission checks cover configuration, people management, ticket assignment, ticket deletion, and reporting. Built-in agents receive assignment and reporting permissions by default.
- Invitation and reset tokens are single-use and stored as SHA-256 hashes.
- Audit rows are append-only for the app role.

The lifecycle stages are fixed (`new`, `open`, `in_progress`, `pending`, `resolved`, `closed`). Tenants configure teams, categories, priorities, custom fields, routing rules, notification text, and custom roles. Arbitrary transition graphs and per-tenant SMTP are deferred.

## Configuration and routing

`GET /api/t/:tenantSlug/config` returns the tenant's teams, categories, priorities, statuses, public custom fields, routing rules, agents, and settings. Tenant admins can create teams, categories, priorities, custom fields, and routing rules from the Admin UI.

Routing rules contain `{ "all": [...] }` conditions over category, priority, priority rank, and custom fields. The first active matching rule wins; otherwise the category default team is used. `POST /api/t/:tenantSlug/routing/preview` previews the result.

## Automation flow

1. Ticket creation inserts a `ticket.created` outbox event in the same transaction.
2. The worker claims pending events with `FOR UPDATE SKIP LOCKED`.
3. For `ticket.created`, the worker creates an `automation_runs` row, issues a short-lived run token, signs the payload with HMAC-SHA256, and posts to n8n.
4. n8n calls allowlisted automation commands with `x-opspilot-run-token`: preview route, assign, record notification, complete.
5. Commands are tenant-scoped by the run token and idempotent via `command_receipts`.
6. Successful delivery marks the outbox event delivered; failures back off and become dead after five attempts.

The worker marks non-`ticket.created` events delivered in milestone 1.

Manual n8n setup: import `deploy/n8n/workflow.json`, activate it, and set `N8N_WEBHOOK_URL` plus `N8N_WEBHOOK_SECRET` for the worker. The Compose setup does this automatically.

## API surface

| Method | Path | Notes |
|---|---|---|
| POST | `/api/auth/login` | Email/password session |
| POST | `/api/auth/logout` | Clear session |
| GET | `/api/auth/me` | User and memberships |
| GET/DELETE | `/api/auth/sessions[/:id]` | List or revoke active sessions |
| POST | `/api/auth/password/change` | Change current password |
| POST | `/api/auth/password/reset/request` | Queue a reset link |
| POST | `/api/auth/password/reset/confirm` | Consume a reset token |
| GET/POST | `/api/auth/invitations/:token[/accept]` | Inspect or accept an invitation |
| GET | `/api/t/:tenantSlug/users` | Members and pending invitations |
| POST/DELETE | `/api/t/:tenantSlug/invitations[/:id]` | Invite or revoke |
| PATCH | `/api/t/:tenantSlug/users/:userId` | Update role, custom role, teams, or active state |
| GET/POST | `/api/t/:tenantSlug/custom-roles` | List or create custom roles |
| PATCH/DELETE | `/api/t/:tenantSlug/custom-roles/:id` | Update or delete custom roles |
| GET/POST | `/api/platform/tenants` | List or onboard workspaces |
| PATCH | `/api/platform/tenants/:id` | Suspend or reactivate a workspace |
| GET | `/api/t/:tenantSlug/tickets` | Role-scoped list, filters, pagination |
| POST | `/api/t/:tenantSlug/tickets` | Create ticket |
| GET | `/api/t/:tenantSlug/tickets/:id` | Detail, visible comments, history, transitions |
| POST | `/api/t/:tenantSlug/tickets/:id/transitions` | Version-checked lifecycle move |
| POST | `/api/t/:tenantSlug/tickets/:id/assign` | Team/assignee update |
| POST | `/api/t/:tenantSlug/tickets/:id/comments` | Public reply or internal note |
| GET | `/api/t/:tenantSlug/reports?days=30` | Visibility-scoped summary, trends, and CSAT |
| GET/POST | `/api/feedback/:token` | Public feedback page data and rating submission |
| POST | `/api/t/:tenantSlug/routing/preview` | Routing preview |
| GET | `/api/t/:tenantSlug/config` | Tenant configuration |
| POST | `/api/t/:tenantSlug/{teams,categories,priorities,custom-fields,routing-rules}` | Admin config |
| POST | `/api/automation/runs/:runId/*` | Run-token automation commands |

## Scripts

| Command | Purpose |
|---|---|
| `pnpm db:role` | Create/update the non-owner app DB role |
| `pnpm db:migrate` | Apply SQL migrations and grants |
| `pnpm db:seed` | Reset and seed two demo tenants |
| `pnpm dev:api` | API with watch |
| `pnpm dev:web` | Vite UI |
| `pnpm worker` | Outbox dispatcher |
| `pnpm typecheck` | TypeScript across the workspace |
| `pnpm test` | Unit tests |
| `pnpm build` | Production web build |

## Scope

Included: RLS tenancy, session auth and management, invitations, password reset, built-in and custom roles with permission checks, configuration, custom fields, routing, ticket lifecycle, comments, assignment, SLA policies and breach tracking, attachments, queued email/SMTP delivery, feedback/CSAT links with public rating pages, reports dashboards, audit, outbox, idempotent automation, n8n workflow, responsive UI.

Platform operators can onboard a workspace with a complete default configuration and email an administrator invitation; suspending a workspace immediately blocks tenant access.

Resolving or closing a ticket queues a one-time feedback link valid for 30 days. Ratings and comments appear in workspace reports for users with `reports.view`; admins see everything, agents see their teams and assignments, and employees see only their own tickets.

Deferred: arbitrary workflow graphs and per-tenant SMTP.

## Branching

- `main` is release-ready.
- Work happens on `feat/<topic>` branches.
- Merge with `--no-ff` when a milestone is reviewable.
- Version tags use `vMAJOR.MINOR.PATCH`.

Only this README is committed as documentation. Design notes and use cases stay untracked under `docs/`.

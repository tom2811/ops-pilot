# OpsPilot

Multi-tenant IT service desk with a TypeScript API, React UI, Postgres RLS, and n8n automation.

## Status

Milestone 1: tenant-aware ticket core, transactional outbox, and ticket-created routing workflow.

## Stack

- pnpm workspace
- React, Vite, Tailwind, TanStack Query, React Router, React Hook Form, Zod
- Fastify, Zod, `pg`
- PostgreSQL 17 with row-level security
- n8n Community Edition (self-hosted)

## Quick start

```bash
cp .env.example .env
createdb opspilot
pnpm install
pnpm db:role
pnpm db:migrate
pnpm db:seed
pnpm dev:api
pnpm dev:web
```

API: `http://localhost:3000`  
Web: `http://localhost:5173`

Demo accounts use password `Passw0rd!`:

| Tenant | Email | Role |
|---|---|---|
| acme | admin@acme.test | tenant_admin |
| acme | agent@acme.test | agent |
| acme | employee@acme.test | employee |
| globex | admin@globex.test | tenant_admin |
| globex | agent@globex.test | agent |

## Scripts

| Command | Purpose |
|---|---|
| `pnpm db:role` | Create/update the non-owner app DB role |
| `pnpm db:migrate` | Apply SQL migrations and grants |
| `pnpm db:seed` | Seed two demo tenants |
| `pnpm dev:api` | API with watch |
| `pnpm dev:web` | Vite UI |
| `pnpm worker` | Outbox dispatcher |
| `pnpm typecheck` | TypeScript across workspace |
| `pnpm test` | Unit tests |
| `pnpm build` | Production web build |

## Automation

Import `infra/n8n/workflows/ticket-created.json` into a local n8n instance. Set `OPSPILOT_WEBHOOK_SECRET` to the same value as `N8N_WEBHOOK_SECRET`, and start the worker. The workflow verifies the signature, previews routing, assigns the ticket, and records a notification.

## Scope

Included: multi-tenancy with RLS, session auth, tenant roles, ticket creation/list/detail, configurable statuses and priorities, comments, transitions, assignment, outbox, n8n routing, audit history.

Deferred: SLA engine, feedback, email delivery, tenant admin UI, invitations, attachments, dashboards.

## Branching

- `main` is release-ready.
- Work happens on `feat/<topic>` branches.
- Merge with `--no-ff` when a milestone is reviewable.
- Version tags use `vMAJOR.MINOR.PATCH`.

Only this README is committed as documentation. Design notes and use cases stay untracked under `docs/`.

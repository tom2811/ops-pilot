import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requireTenant } from "../auth.js";
import { withTenant } from "../db.js";
import { assertCanRead, loadTicket } from "../domain/tickets.js";
import { env } from "../env.js";
import { badRequest, forbidden, notFound } from "../errors.js";

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const ticketParams = z.object({ tenantSlug: z.string().min(1), ticketId: z.string().uuid() });
const attachmentParams = z.object({
  tenantSlug: z.string().min(1),
  attachmentId: z.string().uuid(),
});

type AttachmentRow = {
  id: string;
  ticket_id: string;
  uploader_id: string;
  filename: string;
  content_type: string;
  size: number;
  storage_key: string;
  content: Buffer | null;
  created_at: Date;
  uploader_name: string;
};

function context(req: {
  authUser?: { id: string };
  tenant?: { id: string; role: "tenant_admin" | "agent" | "employee" };
}): { userId: string; tenantId: string; role: "tenant_admin" | "agent" | "employee" } {
  if (!req.authUser || !req.tenant) throw new Error("Missing auth context");
  return { userId: req.authUser.id, tenantId: req.tenant.id, role: req.tenant.role };
}

function safeName(value: string): string {
  const name = basename(value || "attachment").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (name || "attachment").slice(0, 255);
}

export async function attachmentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);
  app.addHook("preHandler", requireTenant);

  app.post("/t/:tenantSlug/tickets/:ticketId/attachments", async (req) => {
    const { userId, tenantId, role } = context(req);
    const { ticketId } = ticketParams.parse(req.params);

    await withTenant(tenantId, userId, async (client) => {
      const ticket = await loadTicket(client, tenantId, ticketId);
      if (!ticket) notFound();
      await assertCanRead(client, ticket, userId, role);
    });

    const file = await req.file();
    if (!file) badRequest("Choose a file to upload");

    let content: Buffer;
    try {
      content = await file.toBuffer();
    } catch {
      return badRequest("File is larger than 10 MB");
    }
    if (file.file.truncated || content.length > MAX_ATTACHMENT_BYTES) {
      badRequest("File is larger than 10 MB");
    }

    const id = randomUUID();
    const storageKey = `${tenantId}/${ticketId}/${id}`;

    return withTenant(tenantId, userId, async (client) => {
      const result = await client.query<AttachmentRow>(
        `insert into ticket_attachments
          (tenant_id, id, ticket_id, uploader_id, filename, content_type, size, storage_key, content)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         returning id, ticket_id, uploader_id, filename, content_type, size, storage_key, created_at,
                   (select display_name from users where id = $4) as uploader_name`,
        [tenantId, id, ticketId, userId, safeName(file.filename), file.mimetype, content.length, storageKey, content],
      );
      return result.rows[0];
    });
  });

  app.get("/t/:tenantSlug/attachments/:attachmentId/download", async (req, reply) => {
    const { userId, tenantId, role } = context(req);
    const { attachmentId } = attachmentParams.parse(req.params);

    const attachment = await withTenant(tenantId, userId, async (client) => {
      const result = await client.query<AttachmentRow>(
        `select a.id, a.ticket_id, a.uploader_id, a.filename, a.content_type, a.size, a.storage_key,
                a.content, a.created_at, u.display_name as uploader_name
         from ticket_attachments a
         join users u on u.id = a.uploader_id
         where a.tenant_id = $1 and a.id = $2`,
        [tenantId, attachmentId],
      );
      const row = result.rows[0];
      if (!row) notFound("Attachment not found");
      const ticket = await loadTicket(client, tenantId, row.ticket_id);
      if (!ticket) notFound("Attachment not found");
      await assertCanRead(client, ticket, userId, role);
      return row;
    });

    reply.type(attachment.content_type);
    reply.header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`);

    if (attachment.content !== null) {
      return reply.send(attachment.content);
    }

    const root = resolve(env.UPLOAD_DIR);
    const target = resolve(env.UPLOAD_DIR, attachment.storage_key);
    if (!target.startsWith(`${root}${sep}`)) notFound("Attachment not found");
    try {
      await stat(target);
    } catch {
      notFound("Attachment file is missing");
    }

    return reply.send(createReadStream(target));
  });

  app.delete("/t/:tenantSlug/attachments/:attachmentId", async (req, reply) => {
    const { userId, tenantId, role } = context(req);
    const { attachmentId } = attachmentParams.parse(req.params);

    const stored = await withTenant(tenantId, userId, async (client) => {
      const result = await client.query<AttachmentRow>(
        `select id, ticket_id, uploader_id, filename, content_type, size, storage_key, content
         from ticket_attachments where tenant_id = $1 and id = $2`,
        [tenantId, attachmentId],
      );
      const attachment = result.rows[0];
      if (!attachment) notFound("Attachment not found");
      const ticket = await loadTicket(client, tenantId, attachment.ticket_id);
      if (!ticket) notFound("Attachment not found");
      await assertCanRead(client, ticket, userId, role);
      if (role !== "tenant_admin" && attachment.uploader_id !== userId) {
        forbidden("Only the uploader or an administrator can delete this attachment");
      }
      await client.query("delete from ticket_attachments where tenant_id = $1 and id = $2", [tenantId, attachmentId]);
      return { storageKey: attachment.storage_key, hasBlob: attachment.content !== null };
    });

    if (!stored.hasBlob) {
      await unlink(resolve(env.UPLOAD_DIR, stored.storageKey)).catch(() => undefined);
    }
    return reply.status(204).send();
  });
}

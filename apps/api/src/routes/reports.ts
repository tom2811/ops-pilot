import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requirePermission, requireTenant } from "../auth.js";
import { withTenant } from "../db.js";

const querySchema = z.object({
  days: z.coerce.number().int().min(7).max(365).default(30),
});

export async function reportRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);
  app.addHook("preHandler", requireTenant);
  app.addHook("preHandler", requirePermission("reports.view"));

  app.get("/t/:tenantSlug/reports", async (req) => {
    if (!req.tenant || !req.authUser) throw new Error("Missing auth context");
    const tenantId = req.tenant.id;
    const userId = req.authUser.id;
    const role = req.tenant.role;
    const { days } = querySchema.parse(req.query);

    return withTenant(tenantId, userId, async (client) => {
      const visibleCte = `with visible as (
        select t.*, s.stage
        from tickets t
        join ticket_statuses s on s.tenant_id = t.tenant_id and s.id = t.status_id
        where t.tenant_id = $1 and t.deleted_at is null
          and (
            $2 = 'tenant_admin'
            or ($2 = 'employee' and t.requester_id = $3)
            or ($2 = 'agent' and (
              t.assignee_id = $3
              or exists (
                select 1 from team_members tm
                where tm.tenant_id = t.tenant_id and tm.user_id = $3 and tm.team_id = t.team_id
              )
              or (t.assignee_id is null and t.team_id is null)
            ))
          )
      )`;
      const params = [tenantId, role, userId];

      const [summary, byStatus, byPriority, byTeam, trend, csat, recentFeedback] = await Promise.all([
        client.query(
          `${visibleCte}
           select count(*)::int as total,
                  count(*) filter (where stage not in ('resolved', 'closed'))::int as open,
                  count(*) filter (where stage not in ('resolved', 'closed') and assignee_id is null)::int as unassigned,
                  count(*) filter (where sla_response_breached_at is not null or sla_resolution_breached_at is not null)::int as sla_breached,
                  count(*) filter (where resolved_at >= now() - interval '7 days')::int as resolved_week,
                  count(*) filter (where created_at >= now() - ($4::int || ' days')::interval)::int as created_period,
                  coalesce(avg(extract(epoch from (resolved_at - created_at)) / 3600)
                    filter (where resolved_at is not null and resolved_at >= now() - ($4::int || ' days')::interval), 0)::float as avg_resolution_hours,
                  coalesce(avg(extract(epoch from (first_responded_at - created_at)) / 60)
                    filter (where first_responded_at is not null and first_responded_at >= now() - ($4::int || ' days')::interval), 0)::float as avg_response_minutes
           from visible`,
          [...params, days],
        ),
        client.query(
          `${visibleCte}
           select s.label, s.stage, count(*)::int as count
           from visible v
           join ticket_statuses s on s.tenant_id = $1 and s.id = v.status_id
           group by s.label, s.stage, s.sort_order
           order by s.sort_order`,
          params,
        ),
        client.query(
          `${visibleCte}
           select p.label, p.color, count(*)::int as count
           from visible v
           join priorities p on p.tenant_id = $1 and p.id = v.priority_id
           group by p.label, p.color, p.rank
           order by p.rank`,
          params,
        ),
        client.query(
          `${visibleCte}
           select coalesce(tm.name, 'Unassigned') as label, count(*)::int as count
           from visible v
           left join teams tm on tm.tenant_id = $1 and tm.id = v.team_id
           group by tm.name
           order by count(*) desc`,
          params,
        ),
        client.query(
          `${visibleCte}
           select to_char(d, 'YYYY-MM-DD') as day,
                  (select count(*)::int from visible
                   where created_at >= d and created_at < d + interval '1 day') as created,
                  (select count(*)::int from visible
                   where resolved_at >= d and resolved_at < d + interval '1 day') as resolved
           from generate_series(
             current_date - ($4::int - 1) * interval '1 day',
             current_date,
             interval '1 day'
           ) as d
           order by d`,
          [...params, days],
        ),
        client.query(
          `${visibleCte}
           select coalesce(avg(f.rating), 0)::float as average,
                  count(*)::int as responses,
                  count(*) filter (where f.comment is not null and f.comment <> '')::int as comments
           from ticket_feedback f
           join visible v on v.id = f.ticket_id
           where f.submitted_at is not null`,
          params,
        ),
        client.query(
          `${visibleCte}
           select f.rating, f.comment, f.submitted_at, v.number, v.subject,
                  u.display_name as requester_name
           from ticket_feedback f
           join visible v on v.id = f.ticket_id
           join users u on u.id = v.requester_id
           where f.submitted_at is not null
           order by f.submitted_at desc
           limit 5`,
          params,
        ),
      ]);

      const defaultSummary = {
        total: 0,
        open: 0,
        unassigned: 0,
        sla_breached: 0,
        resolved_week: 0,
        created_period: 0,
        avg_resolution_hours: 0,
        avg_response_minutes: 0,
      };
      const rawSummary = summary.rows[0] ?? defaultSummary;
      const cleanSummary = {
        total: Number(rawSummary.total ?? 0),
        open: Number(rawSummary.open ?? 0),
        unassigned: Number(rawSummary.unassigned ?? 0),
        sla_breached: Number(rawSummary.sla_breached ?? 0),
        resolved_week: Number(rawSummary.resolved_week ?? 0),
        created_period: Number(rawSummary.created_period ?? 0),
        avg_resolution_hours: Number(rawSummary.avg_resolution_hours ?? 0),
        avg_response_minutes: Number(rawSummary.avg_response_minutes ?? 0),
      };

      return {
        periodDays: days,
        summary: cleanSummary,
        by_status: byStatus.rows,
        by_priority: byPriority.rows,
        by_team: byTeam.rows,
        trend: trend.rows,
        csat: csat.rows[0] ?? { average: 0, responses: 0, comments: 0 },
        recent_feedback: recentFeedback.rows,
      };
    });
  });
}

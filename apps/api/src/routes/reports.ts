import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { businessMinutesBetween } from "@opspilot/core";
import { requireAuth, requirePermission, requireTenant } from "../auth.js";
import { withTenant } from "../db.js";
import { getBusinessHoursConfig } from "../domain/tickets.js";

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
              or (t.assignee_id is null and t.team_id is null)
              or exists (
                select 1 from team_members tm
                where tm.tenant_id = t.tenant_id and tm.user_id = $3 and tm.team_id = t.team_id
              )
            ))
          )
      )`;
      const params = [tenantId, role, userId];
      const bhConfig = await getBusinessHoursConfig(client, tenantId);

      const [summary, byStatus, byPriority, byTeam, byCategory, trend, csat, recentFeedback, durationRows] = await Promise.all([
        client.query(
          `${visibleCte}
           select count(*)::int as total,
                  count(*) filter (where stage not in ('resolved', 'closed'))::int as open,
                  count(*) filter (where stage not in ('resolved', 'closed') and assignee_id is null)::int as unassigned,
                  count(*) filter (where (sla_response_breached_at is not null or sla_resolution_breached_at is not null) and merged_into_ticket_id is null)::int as sla_breached,
                  count(*) filter (where sla_policy_id is not null and merged_into_ticket_id is null
                    and created_at >= now() - ($4::int || ' days')::interval
                    and (sla_response_breached_at is not null or sla_resolution_breached_at is not null))::int as sla_period_breached,
                  count(*) filter (where sla_policy_id is not null and merged_into_ticket_id is null
                    and created_at >= now() - ($4::int || ' days')::interval
                    and sla_response_breached_at is null and sla_resolution_breached_at is null
                    and (resolved_at is not null or closed_at is not null))::int as sla_met,
                  count(*) filter (where sla_policy_id is not null and merged_into_ticket_id is null
                    and created_at >= now() - ($4::int || ' days')::interval
                    and sla_response_breached_at is null and sla_resolution_breached_at is null
                    and resolved_at is null and closed_at is null)::int as sla_still_running,
                  case when (
                    count(*) filter (where sla_policy_id is not null and merged_into_ticket_id is null
                      and created_at >= now() - ($4::int || ' days')::interval
                      and (sla_response_breached_at is not null or sla_resolution_breached_at is not null or resolved_at is not null or closed_at is not null))
                  ) > 0
                  then round(
                    (count(*) filter (where sla_policy_id is not null and merged_into_ticket_id is null
                      and created_at >= now() - ($4::int || ' days')::interval
                      and sla_response_breached_at is null and sla_resolution_breached_at is null
                      and (resolved_at is not null or closed_at is not null))::numeric * 100.0) /
                    count(*) filter (where sla_policy_id is not null and merged_into_ticket_id is null
                      and created_at >= now() - ($4::int || ' days')::interval
                      and (sla_response_breached_at is not null or sla_resolution_breached_at is not null or resolved_at is not null or closed_at is not null)),
                    1
                  )
                  else 100.0
                  end::float as sla_compliance_percent,
                  count(*) filter (where resolved_at >= now() - interval '7 days')::int as resolved_week,
                  count(*) filter (where created_at >= now() - ($4::int || ' days')::interval)::int as created_period
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
           select coalesce(c.name, 'Uncategorized') as label, count(*)::int as count
           from visible v
           left join categories c on c.tenant_id = $1 and c.id = v.category_id
           group by c.name
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
        client.query<{
          id: string;
          created_at: Date;
          resolved_at: Date | null;
          first_responded_at: Date | null;
          business_hours_only: boolean;
        }>(
          `${visibleCte}
           select v.id, v.created_at, v.resolved_at, v.first_responded_at,
                  coalesce(p.business_hours_only, false) as business_hours_only
           from visible v
           left join sla_policies p on p.tenant_id = $1 and p.id = v.sla_policy_id
           where (v.resolved_at is not null and v.resolved_at >= now() - ($4::int || ' days')::interval)
              or (v.first_responded_at is not null and v.first_responded_at >= now() - ($4::int || ' days')::interval)`,
          [...params, days],
        ),
      ]);

      let totalResolutionMinutes = 0;
      let resolvedCount = 0;
      let totalResponseMinutes = 0;
      let responseCount = 0;

      for (const row of durationRows.rows) {
        if (row.resolved_at) {
          const resMinutes = row.business_hours_only
            ? businessMinutesBetween(new Date(row.created_at), new Date(row.resolved_at), bhConfig)
            : Math.max(0, (new Date(row.resolved_at).getTime() - new Date(row.created_at).getTime()) / 60000);
          totalResolutionMinutes += resMinutes;
          resolvedCount += 1;
        }
        if (row.first_responded_at) {
          const respMinutes = row.business_hours_only
            ? businessMinutesBetween(new Date(row.created_at), new Date(row.first_responded_at), bhConfig)
            : Math.max(0, (new Date(row.first_responded_at).getTime() - new Date(row.created_at).getTime()) / 60000);
          totalResponseMinutes += respMinutes;
          responseCount += 1;
        }
      }

      const avgResolutionHours = resolvedCount > 0 ? Number((totalResolutionMinutes / resolvedCount / 60).toFixed(1)) : 0;
      const avgResponseMinutes = responseCount > 0 ? Number((totalResponseMinutes / responseCount).toFixed(1)) : 0;

      const defaultSummary = {
        total: 0,
        open: 0,
        unassigned: 0,
        sla_breached: 0,
        sla_period_breached: 0,
        sla_met: 0,
        sla_still_running: 0,
        sla_compliance_percent: 100,
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
        sla_breached: Number(rawSummary.sla_period_breached ?? rawSummary.sla_breached ?? 0),
        sla_met: Number(rawSummary.sla_met ?? 0),
        sla_still_running: Number(rawSummary.sla_still_running ?? 0),
        sla_compliance_percent: Number(rawSummary.sla_compliance_percent ?? 100),
        resolved_week: Number(rawSummary.resolved_week ?? 0),
        created_period: Number(rawSummary.created_period ?? 0),
        avg_resolution_hours: avgResolutionHours,
        avg_response_minutes: avgResponseMinutes,
      };

      return {
        periodDays: days,
        summary: cleanSummary,
        by_status: byStatus.rows,
        by_priority: byPriority.rows,
        by_team: byTeam.rows,
        by_category: byCategory.rows,
        trend: trend.rows,
        csat: csat.rows[0] ?? { average: 0, responses: 0, comments: 0 },
        recent_feedback: recentFeedback.rows,
      };
    });
  });
}

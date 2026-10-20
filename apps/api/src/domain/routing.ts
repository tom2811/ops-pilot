import type pg from "pg";
import { matchesRoutingConditions } from "@opspilot/core";
import { badRequest } from "../errors.js";

export type RoutePreview = {
  teamId: string;
  teamName: string;
  ruleId: string | null;
  explanation: string;
};

type RuleRow = {
  id: string;
  name: string;
  conditions: unknown;
  team_id: string;
  team_name: string;
};

export async function previewRoute(
  client: pg.PoolClient,
  tenantId: string,
  input: { categoryId: string; priorityId: string; customFields: Record<string, unknown> },
): Promise<RoutePreview | null> {
  const category = await client.query<{ id: string; name: string; default_team_id: string | null }>(
    "select id, name, default_team_id from categories where tenant_id = $1 and id = $2 and is_active",
    [tenantId, input.categoryId],
  );
  const categoryRow = category.rows[0];
  if (!categoryRow) return badRequest("Unknown category");

  const priority = await client.query<{ id: string; rank: number }>(
    "select id, rank from priorities where tenant_id = $1 and id = $2 and is_active",
    [tenantId, input.priorityId],
  );
  const priorityRow = priority.rows[0];
  if (!priorityRow) return badRequest("Unknown priority");

  const rules = await client.query<RuleRow>(
    `select r.id, r.name, r.conditions, r.team_id, t.name as team_name
     from routing_rules r
     join teams t on t.tenant_id = r.tenant_id and t.id = r.team_id
     where r.tenant_id = $1 and r.is_active
     order by jsonb_array_length(r.conditions->'all') desc, r.sort_order, r.id`,
    [tenantId],
  );

  for (const rule of rules.rows) {
    if (
      matchesRoutingConditions(rule.conditions, {
        categoryId: input.categoryId,
        priorityId: input.priorityId,
        priorityRank: priorityRow.rank,
        customFields: input.customFields,
      })
    ) {
      return {
        teamId: rule.team_id,
        teamName: rule.team_name,
        ruleId: rule.id,
        explanation: `Matched rule "${rule.name}"`,
      };
    }
  }

  if (categoryRow.default_team_id) {
    const team = await client.query<{ name: string }>(
      "select name from teams where tenant_id = $1 and id = $2 and is_active",
      [tenantId, categoryRow.default_team_id],
    );
    const teamRow = team.rows[0];
    if (teamRow) {
      return {
        teamId: categoryRow.default_team_id,
        teamName: teamRow.name,
        ruleId: null,
        explanation: `Used default team for category "${categoryRow.name}"`,
      };
    }
  }

  return null;
}

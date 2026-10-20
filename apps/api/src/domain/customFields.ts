import type pg from "pg";
import type { Role } from "@opspilot/core";
import { badRequest } from "../errors.js";

export type CustomFieldDefinition = {
  id: string;
  key: string;
  label: string;
  type: string;
  required: boolean;
  visibility: "public" | "internal";
  options: unknown;
  applies_to_category_id: string | null;
  sort_order: number;
};

function optionsOf(definition: CustomFieldDefinition): string[] {
  return Array.isArray(definition.options)
    ? definition.options.filter((value): value is string => typeof value === "string")
    : [];
}

function isMissing(value: unknown): boolean {
  return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
}

function validateValue(definition: CustomFieldDefinition, value: unknown): unknown {
  if (definition.type === "number") {
    if (typeof value !== "number" || Number.isNaN(value)) return badRequest(`${definition.label} must be a number`);
    return value;
  }
  if (definition.type === "checkbox") {
    if (typeof value !== "boolean") return badRequest(`${definition.label} must be true or false`);
    return value;
  }
  if (definition.type === "date") {
    if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
      return badRequest(`${definition.label} must be a date`);
    }
    return value;
  }
  if (definition.type === "select") {
    if (typeof value !== "string" || !optionsOf(definition).includes(value)) {
      return badRequest(`${definition.label} has an invalid option`);
    }
    return value;
  }
  if (definition.type === "multiselect") {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      return badRequest(`${definition.label} must be a list`);
    }
    const allowed = optionsOf(definition);
    if (value.some((item) => !allowed.includes(item as string))) {
      return badRequest(`${definition.label} has an invalid option`);
    }
    return value;
  }
  if (typeof value !== "string") return badRequest(`${definition.label} must be text`);
  if (value.length > 5000) return badRequest(`${definition.label} is too long`);
  return value;
}

export async function validateCustomFields(
  client: pg.PoolClient,
  tenantId: string,
  categoryId: string,
  input: Record<string, unknown>,
  role: Role,
): Promise<Record<string, unknown>> {
  const result = await client.query<CustomFieldDefinition>(
    `select id, key, label, type, required, visibility, options, applies_to_category_id, sort_order
     from custom_field_definitions
     where tenant_id = $1 and is_active
       and (applies_to_category_id is null or applies_to_category_id = $2)`,
    [tenantId, categoryId],
  );

  const definitions = new Map(result.rows.map((definition) => [definition.key, definition]));
  const output: Record<string, unknown> = {};

  for (const key of Object.keys(input)) {
    const definition = definitions.get(key);
    if (!definition) return badRequest(`Unknown custom field: ${key}`);
    if (role === "employee" && definition.visibility === "internal") {
      return badRequest(`Custom field is not editable: ${key}`);
    }
  }

  for (const definition of result.rows) {
    if (role === "employee" && definition.visibility === "internal") continue;
    const value = input[definition.key];
    if (isMissing(value)) {
      if (definition.required) return badRequest(`${definition.label} is required`);
      continue;
    }
    output[definition.key] = validateValue(definition, value);
  }

  return output;
}

export async function filterVisibleCustomFields<
  T extends { category_id: string; custom_fields: Record<string, unknown> },
>(client: pg.PoolClient, tenantId: string, rows: T[], role: Role): Promise<T[]> {
  if (role !== "employee" || rows.length === 0) return rows;

  const result = await client.query<CustomFieldDefinition>(
    `select id, key, label, type, required, visibility, options, applies_to_category_id, sort_order
     from custom_field_definitions
     where tenant_id = $1 and is_active`,
    [tenantId],
  );

  return rows.map((row) => {
    const output: Record<string, unknown> = {};
    for (const definition of result.rows) {
      if (definition.visibility === "internal") continue;
      if (definition.applies_to_category_id && definition.applies_to_category_id !== row.category_id) continue;
      if (definition.key in row.custom_fields) output[definition.key] = row.custom_fields[definition.key];
    }
    return { ...row, custom_fields: output };
  });
}

export async function visibleCustomFields(
  client: pg.PoolClient,
  tenantId: string,
  categoryId: string,
  values: Record<string, unknown>,
  role: Role,
): Promise<Record<string, unknown>> {
  const result = await client.query<CustomFieldDefinition>(
    `select id, key, label, type, required, visibility, options, applies_to_category_id, sort_order
     from custom_field_definitions
     where tenant_id = $1 and is_active
       and (applies_to_category_id is null or applies_to_category_id = $2)
     order by sort_order, label`,
    [tenantId, categoryId],
  );

  const output: Record<string, unknown> = {};
  for (const definition of result.rows) {
    if (role === "employee" && definition.visibility === "internal") continue;
    if (definition.key in values) output[definition.key] = values[definition.key];
  }
  return output;
}

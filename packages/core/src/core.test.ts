import { describe, expect, it } from "vitest";
import { formatTicketNumber, matchesRoutingConditions, renderTemplate } from "./index.js";
import { hashPassword, verifyPassword } from "./password.js";

describe("matchesRoutingConditions", () => {
  const context = {
    categoryId: "00000000-0000-4000-8000-000000000010",
    priorityId: "00000000-0000-4000-8000-000000000020",
    priorityRank: 2,
    customFields: { site: "HQ", asset_tag: "ACM-100" },
  };

  it("matches all conditions", () => {
    expect(
      matchesRoutingConditions(
        {
          all: [
            { field: "category_id", op: "eq", value: context.categoryId },
            { field: "priority_rank", op: "lte", value: 2 },
            { field: "custom.site", op: "eq", value: "HQ" },
          ],
        },
        context,
      ),
    ).toBe(true);
  });

  it("fails when one condition does not match", () => {
    expect(
      matchesRoutingConditions(
        {
          all: [
            { field: "category_id", op: "eq", value: context.categoryId },
            { field: "custom.asset_tag", op: "contains", value: "GLX" },
          ],
        },
        context,
      ),
    ).toBe(false);
  });

  it("ignores invalid rules instead of crashing", () => {
    expect(matchesRoutingConditions({ all: [{ field: "nonsense" }] }, context)).toBe(false);
  });
});

describe("formatTicketNumber", () => {
  it("pads ticket numbers", () => {
    expect(formatTicketNumber("ACM", 42)).toBe("ACM-000042");
    expect(formatTicketNumber("GLX", "7")).toBe("GLX-000007");
  });
});

describe("password hashing", () => {
  it("verifies the right password and rejects the wrong one", () => {
    const stored = hashPassword("Passw0rd!");
    expect(verifyPassword("Passw0rd!", stored)).toBe(true);
    expect(verifyPassword("wrong-password", stored)).toBe(false);
  });
});

describe("renderTemplate", () => {
  it("replaces placeholders and leaves unknown values empty", () => {
    expect(renderTemplate("Hi {{name}}, ticket {{number}} {{missing}}", { name: "Sam", number: 42 })).toBe(
      "Hi Sam, ticket 42 ",
    );
  });
});

import { describe, expect, it } from "vitest";
import { addBusinessMinutes, formatTicketNumber, matchesRoutingConditions, renderTemplate } from "./index.js";
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

describe("addBusinessMinutes", () => {
  const config = {
    startHour: 9,
    startMinute: 0,
    endHour: 17,
    endMinute: 0,
    businessDays: [1, 2, 3, 4, 5], // Mon-Fri
  };

  it("adds minutes within the same business day", () => {
    // Mon Oct 26 2026, 10:00 UTC
    const start = new Date("2026-10-26T10:00:00Z");
    const result = addBusinessMinutes(start, 120, config);
    expect(result.toISOString()).toBe("2026-10-26T12:00:00.000Z");
  });

  it("rolls over to next business day when exceeding closing time", () => {
    // Mon Oct 26 2026, 16:00 UTC (1 hour before close at 17:00)
    // Add 120 mins -> 60 mins Monday, remaining 60 mins Tuesday 09:00 -> 10:00
    const start = new Date("2026-10-26T16:00:00Z");
    const result = addBusinessMinutes(start, 120, config);
    expect(result.toISOString()).toBe("2026-10-27T10:00:00.000Z");
  });

  it("skips weekends when rolling over Friday evening", () => {
    // Fri Oct 30 2026, 16:30 UTC (30 mins before close)
    // Add 60 mins -> 30 mins Friday, rolls over weekend to Monday Nov 2 09:30 UTC
    const start = new Date("2026-10-30T16:30:00Z");
    const result = addBusinessMinutes(start, 60, config);
    expect(result.toISOString()).toBe("2026-11-02T09:30:00.000Z");
  });

  it("falls back to calendar addition when config is omitted", () => {
    const start = new Date("2026-10-30T16:30:00Z");
    const result = addBusinessMinutes(start, 60);
    expect(result.toISOString()).toBe("2026-10-30T17:30:00.000Z");
  });
});

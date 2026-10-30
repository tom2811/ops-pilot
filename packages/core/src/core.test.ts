import { describe, expect, it } from "vitest";
import {
  addBusinessMinutes,
  cleanEmailBody,
  createTicketLinkSchema,
  formatTicketNumber,
  INVERSE_LINK_TYPES,
  matchesRoutingConditions,
  mergeTicketSchema,
  parseEmailAddress,
  parseTicketNumberFromSubject,
  renderTemplate,
} from "./index.js";
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

  it("resolves nested properties", () => {
    expect(
      renderTemplate("Hello {{requester.name}}, ticket {{ticket.number}}", {
        requester: { name: "Alice" },
        ticket: { number: "ACM-000001" },
      }),
    ).toBe("Hello Alice, ticket ACM-000001");
  });
});

describe("inbound email helpers", () => {
  it("parses email address and display name correctly", () => {
    expect(parseEmailAddress("Erin Employee <employee@acme.test>")).toEqual({
      address: "employee@acme.test",
      name: "Erin Employee",
    });
    expect(parseEmailAddress("test@example.com")).toEqual({
      address: "test@example.com",
      name: "test",
    });
  });

  it("extracts ticket number from subject", () => {
    expect(parseTicketNumberFromSubject("Re: [ACM-000042] VPN issue", "ACM")).toBe(42);
    expect(parseTicketNumberFromSubject("Re: New reply on ticket #7", "ACM")).toBe(7);
    expect(parseTicketNumberFromSubject("Re: Ticket #123 created")).toBe(123);
    expect(parseTicketNumberFromSubject("Hardware request without ticket")).toBeNull();
  });

  it("cleans quoted reply history from email body", () => {
    const raw = "I restarted the router and it works now.\n\nOn Fri, Oct 30, 2026 at 4:10 PM OpsPilot wrote:\n> We received your ticket.";
    expect(cleanEmailBody(raw)).toBe("I restarted the router and it works now.");
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

  it("uses the tenant timezone with a half-hour offset", () => {
    // Fri Oct 30 2026, 16:30 in Yangon (UTC+6:30). 30 minutes remain before 17:00.
    // The rest rolls over the weekend to Mon Nov 2 09:30 in Yangon.
    const start = new Date("2026-10-30T10:00:00Z");
    const result = addBusinessMinutes(start, 60, { ...config, timeZone: "Asia/Yangon" });
    expect(result.toISOString()).toBe("2026-11-02T03:00:00.000Z");
  });

  it("uses the tenant timezone in Bangkok", () => {
    // Mon Nov 2 2026, 10:00 in Bangkok (UTC+7), add two business hours.
    const start = new Date("2026-11-02T03:00:00Z");
    const result = addBusinessMinutes(start, 120, { ...config, timeZone: "Asia/Bangkok" });
    expect(result.toISOString()).toBe("2026-11-02T05:00:00.000Z");
  });

  it("respects custom business days", () => {
    // Fri Oct 30 2026, 16:30 UTC. Only Sunday is a business day.
    const start = new Date("2026-10-30T16:30:00Z");
    const result = addBusinessMinutes(start, 60, { ...config, businessDays: [7] });
    expect(result.toISOString()).toBe("2026-11-01T10:00:00.000Z");
  });

  it("falls back to calendar addition when the window is invalid", () => {
    const start = new Date("2026-10-30T16:30:00Z");
    const result = addBusinessMinutes(start, 60, { ...config, startHour: 17, endHour: 9 });
    expect(result.toISOString()).toBe("2026-10-30T17:30:00.000Z");
  });
});

describe("ticket links and merging", () => {
  it("computes correct inverse link types", () => {
    expect(INVERSE_LINK_TYPES.relates_to).toBe("relates_to");
    expect(INVERSE_LINK_TYPES.blocks).toBe("blocked_by");
    expect(INVERSE_LINK_TYPES.blocked_by).toBe("blocks");
    expect(INVERSE_LINK_TYPES.duplicates).toBe("duplicated_by");
    expect(INVERSE_LINK_TYPES.duplicated_by).toBe("duplicates");
    expect(INVERSE_LINK_TYPES.causes).toBe("caused_by");
    expect(INVERSE_LINK_TYPES.caused_by).toBe("causes");
    expect(INVERSE_LINK_TYPES.merged_into).toBe("merged_from");
    expect(INVERSE_LINK_TYPES.merged_from).toBe("merged_into");
  });

  it("validates createTicketLinkSchema", () => {
    const valid = createTicketLinkSchema.safeParse({
      targetTicketNumber: "101",
      linkType: "relates_to",
    });
    expect(valid.success).toBe(true);
    if (valid.success) {
      expect(valid.data.targetTicketNumber).toBe(101);
      expect(valid.data.linkType).toBe("relates_to");
    }

    const invalidType = createTicketLinkSchema.safeParse({
      targetTicketNumber: 101,
      linkType: "invalid_type",
    });
    expect(invalidType.success).toBe(false);

    const invalidNumber = createTicketLinkSchema.safeParse({
      targetTicketNumber: -5,
      linkType: "blocks",
    });
    expect(invalidNumber.success).toBe(false);
  });

  it("validates mergeTicketSchema", () => {
    const defaultDirection = mergeTicketSchema.safeParse({
      targetTicketNumber: "102",
    });
    expect(defaultDirection.success).toBe(true);
    if (defaultDirection.success) {
      expect(defaultDirection.data.targetTicketNumber).toBe(102);
      expect(defaultDirection.data.direction).toBe("merge_into_this");
    }

    const customDirection = mergeTicketSchema.safeParse({
      targetTicketNumber: 105,
      direction: "merge_this_into",
      reason: "Duplicate submission via email",
    });
    expect(customDirection.success).toBe(true);
    if (customDirection.success) {
      expect(customDirection.data.reason).toBe("Duplicate submission via email");
    }
  });
});


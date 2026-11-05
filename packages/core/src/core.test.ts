import { describe, expect, it } from "vitest";
import {
  addBusinessMinutes,
  businessMinutesBetween,
  shiftedSlaDue,
  cleanEmailBody,
  createTicketLinkSchema,
  formatTicketNumber,
  INVERSE_LINK_TYPES,
  isSlaAtRisk,
  matchesRoutingConditions,
  mergeTicketSchema,
  parseEmailAddress,
  parseTicketNumberFromSubject,
  renderTemplate,
  slaThresholdDue,
  stagePausesResolution,
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

describe("stagePausesResolution", () => {
  it("pauses only when the status flag is set", () => {
    expect(stagePausesResolution(true)).toBe(true);
    expect(stagePausesResolution(false)).toBe(false);
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

  it("skips a holiday the same way it skips a weekend", () => {
    const start = new Date("2026-10-26T10:00:00Z");
    const result = addBusinessMinutes(start, 60, { ...config, holidays: ["2026-10-26"] });
    expect(result.toISOString()).toBe("2026-10-27T10:00:00.000Z");
  });

  it("counts the same minutes it adds", () => {
    const start = new Date("2026-10-26T16:00:00Z");
    const end = addBusinessMinutes(start, 120, config);
    expect(businessMinutesBetween(start, end, config)).toBe(120);
  });
});

describe("shiftedSlaDue", () => {
  const hours = {
    startHour: 9,
    startMinute: 0,
    endHour: 17,
    endMinute: 0,
    businessDays: [1, 2, 3, 4, 5],
  };

  it("keeps time already spent when the target gets longer", () => {
    const clock = new Date("2026-10-26T11:00:00Z");
    const due = shiftedSlaDue({
      oldDue: new Date("2026-10-26T12:00:00Z"),
      oldMinutes: 120,
      newMinutes: 180,
      clock,
      config: hours,
    });
    expect(due?.toISOString()).toBe("2026-10-26T13:00:00.000Z");
  });

  it("does not restart an overdue clock from now", () => {
    const oldDue = new Date("2026-10-26T10:00:00Z");
    const same = shiftedSlaDue({
      oldDue,
      oldMinutes: 60,
      newMinutes: 60,
      clock: new Date("2026-10-26T11:00:00Z"),
      config: hours,
    });
    expect(same?.toISOString()).toBe(oldDue.toISOString());

    const longer = shiftedSlaDue({
      oldDue,
      oldMinutes: 60,
      newMinutes: 120,
      clock: new Date("2026-10-26T11:00:00Z"),
      config: hours,
    });
    expect(longer?.toISOString()).toBe("2026-10-26T11:00:00.000Z");
  });
});

describe("slaThresholdDue", () => {
  const hours = {
    startHour: 9,
    startMinute: 0,
    endHour: 17,
    endMinute: 0,
    businessDays: [1, 2, 3, 4, 5],
  };

  it("uses calendar minutes for 24x7 policies", () => {
    const result = slaThresholdDue({
      createdAt: new Date("2026-10-26T09:00:00Z"),
      dueAt: new Date("2026-10-26T10:00:00Z"),
      thresholdPercent: 80,
    });
    expect(result.toISOString()).toBe("2026-10-26T09:48:00.000Z");
  });

  it("counts only business minutes for business-hours policies", () => {
    // Fri 16:00 to Mon 10:00 is 120 business minutes. 50% lands at Fri 17:00,
    // not at the calendar midpoint on Sunday.
    const result = slaThresholdDue({
      createdAt: new Date("2026-10-30T16:00:00Z"),
      dueAt: new Date("2026-11-02T10:00:00Z"),
      thresholdPercent: 50,
      config: hours,
    });
    expect(result.toISOString()).toBe("2026-10-30T17:00:00.000Z");
  });

  it("returns the due date at 100 percent", () => {
    const due = new Date("2026-10-26T10:00:00Z");
    const result = slaThresholdDue({
      createdAt: new Date("2026-10-26T09:00:00Z"),
      dueAt: due,
      thresholdPercent: 100,
    });
    expect(result.toISOString()).toBe(due.toISOString());
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

describe("isSlaAtRisk", () => {
  it("detects when SLA is below, at, and above 80% threshold", () => {
    const created = new Date("2026-10-30T10:00:00.000Z");
    const due = new Date("2026-10-30T11:40:00.000Z"); // 100 minutes total

    // 50 minutes elapsed = 50% -> false
    expect(isSlaAtRisk(created, due, 0.8, new Date("2026-10-30T10:50:00.000Z"))).toBe(false);

    // 79 minutes elapsed = 79% -> false
    expect(isSlaAtRisk(created, due, 0.8, new Date("2026-10-30T11:19:00.000Z"))).toBe(false);

    // 80 minutes elapsed = 80% -> true
    expect(isSlaAtRisk(created, due, 0.8, new Date("2026-10-30T11:20:00.000Z"))).toBe(true);

    // 95 minutes elapsed = 95% -> true
    expect(isSlaAtRisk(created, due, 0.8, new Date("2026-10-30T11:35:00.000Z"))).toBe(true);

    // 100 minutes elapsed = 100% (due reached) -> false (breached/overdue, not at-risk warning)
    expect(isSlaAtRisk(created, due, 0.8, new Date("2026-10-30T11:40:00.000Z"))).toBe(false);

    // 110 minutes elapsed = 110% -> false
    expect(isSlaAtRisk(created, due, 0.8, new Date("2026-10-30T11:50:00.000Z"))).toBe(false);
  });

  it("handles null or invalid inputs safely", () => {
    const created = new Date("2026-10-30T10:00:00.000Z");
    expect(isSlaAtRisk(created, null)).toBe(false);
    expect(isSlaAtRisk(created, "invalid-date")).toBe(false);
  });
});



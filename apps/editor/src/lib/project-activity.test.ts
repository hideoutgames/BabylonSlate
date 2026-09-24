import { describe, expect, it } from "vitest";
import { describeProjectActivity } from "./project-activity";

const now = Date.parse("2026-09-24T12:00:00Z");

describe("describeProjectActivity", () => {
  it("describes the most recent open relative to now", () => {
    expect(
      describeProjectActivity(
        { lastOpenedAt: "2026-09-19T12:00:00Z", createdAt: "2025-01-01T00:00:00Z" },
        now,
      ),
    ).toBe("Opened 5 days ago");
    expect(
      describeProjectActivity({ lastOpenedAt: "2026-09-24T09:00:00Z" }, now),
    ).toBe("Opened 3 hours ago");
    expect(
      describeProjectActivity({ lastOpenedAt: "2026-09-24T11:59:40Z" }, now),
    ).toBe("Opened just now");
  });

  it("falls back to the creation time for never-opened projects", () => {
    expect(
      describeProjectActivity({ createdAt: "2026-09-23T12:00:00Z" }, now),
    ).toBe("Created yesterday");
  });

  it("omits the caption when no valid time is recorded", () => {
    expect(describeProjectActivity({}, now)).toBeNull();
    expect(describeProjectActivity({ lastOpenedAt: "not a date" }, now)).toBeNull();
  });
});

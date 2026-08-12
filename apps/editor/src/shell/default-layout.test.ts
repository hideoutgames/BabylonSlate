import { describe, expect, it } from "vitest";
import {
  CLASS_PANEL_INITIAL_HEIGHT,
  CLASS_PANEL_TITLE,
} from "./default-layout";

describe("graph default layout", () => {
  it("titles the class panel Class at about half the left stack", () => {
    expect(CLASS_PANEL_TITLE).toBe("Class");
    expect(CLASS_PANEL_INITIAL_HEIGHT).toBeGreaterThanOrEqual(360);
  });
});

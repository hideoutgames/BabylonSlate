import { describe, expect, it } from "vitest";
import {
  ENUM_SWITCH_CASE_PREFIX,
  enumSwitchCasePinId,
  enumSwitchMemberNameFromPinId,
} from "./enum-switch-pins";

describe("enum switch pin ids", () => {
  it("stores the member name after a stable prefix", () => {
    expect(ENUM_SWITCH_CASE_PREFIX).toBe("case:");
    expect(enumSwitchCasePinId("idle")).toBe("case:idle");
  });

  it("reads the member name back from a case pin id", () => {
    expect(enumSwitchMemberNameFromPinId("case:idle")).toBe("idle");
    expect(enumSwitchMemberNameFromPinId("case:Red")).toBe("Red");
    expect(enumSwitchMemberNameFromPinId("default")).toBeUndefined();
    expect(enumSwitchMemberNameFromPinId("value")).toBeUndefined();
  });
});

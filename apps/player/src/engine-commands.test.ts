import { describe, expect, it } from "vitest";
import { applyPlayerEngineCommand } from "./engine-commands";

describe("applyPlayerEngineCommand", () => {
  it("forwards assignMaterial onto the Engine handle", () => {
    const applied: string[] = [];
    const handle = {
      applyCommand: (command: { type: string }) => {
        applied.push(command.type);
      },
    };
    expect(
      applyPlayerEngineCommand(handle, {
        type: "assignMaterial",
        slotId: 1,
        materialAssetGuid: "mat-rock",
      }),
    ).toBe(true);
    expect(applied).toEqual(["assignMaterial"]);
  });

  it("ignores commands the Engine does not apply", () => {
    const applied: string[] = [];
    const handle = {
      applyCommand: (command: { type: string }) => {
        applied.push(command.type);
      },
    };
    expect(applyPlayerEngineCommand(handle, { type: "stats" })).toBe(false);
    expect(applied).toEqual([]);
  });
});

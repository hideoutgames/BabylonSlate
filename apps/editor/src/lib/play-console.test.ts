import { describe, expect, it } from "vitest";
import { playConsoleCommands } from "./play-console";

describe("playConsoleCommands", () => {
  it("includes core commands and compiled user BDebugCommand names", () => {
    const names = playConsoleCommands([
      {
        assetGuid: "heal",
        classId: "HealCommand",
        source: "",
        anchors: [],
        entryPoints: [{ name: "onCommandRun", event: "onCommandRun", isAsync: false }],
        command: {
          name: "heal",
          description: "Heal",
          category: "game",
          parameters: [{ name: "amount", type: "float" }],
        },
      },
    ]).map((command) => command.name);
    expect(names).toContain("changescene");
    expect(names).toContain("heal");
    expect(names).toContain("showfps");
  });
});

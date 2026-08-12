import { describe, expect, it } from "vitest";
import { warnDebugTierConsoleCommands } from "./validation";

describe("warnDebugTierConsoleCommands", () => {
  it("warns when ExecuteConsoleCommand literals name a debug-tier command", () => {
    const diags = warnDebugTierConsoleCommands(
      [
        {
          id: "event-graph",
          nodes: [
            {
              id: "cmd",
              typeId: "debug.executeConsoleCommand",
              properties: { command: "showfps" },
            },
            {
              id: "ok",
              typeId: "debug.executeConsoleCommand",
              properties: { command: "changescene level-2" },
            },
            {
              id: "log",
              typeId: "debug.log",
              properties: { message: "showfps" },
            },
          ],
        },
      ],
      { assetGuid: "graph-1" },
    );
    expect(diags).toEqual([
      {
        severity: "warning",
        code: "console.debug_tier",
        message:
          "ExecuteConsoleCommand references debug-tier command 'showfps', which is stripped from non-debug exports",
        assetGuid: "graph-1",
        graphId: "event-graph",
        nodeId: "cmd",
      },
    ]);
  });
});

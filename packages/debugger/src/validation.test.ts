import { describe, expect, it } from "vitest";
import { warnDebugTierConsoleCommands, warnReservedConsoleCommandNames } from "./validation";

describe("warnDebugTierConsoleCommands", () => {
  it("warns when unwired ExecuteConsoleCommand literals name a debug-tier command", () => {
    const diags = warnDebugTierConsoleCommands(
      [
        {
          id: "event-graph",
          nodes: [
            {
              id: "cmd",
              typeId: "debug.executeConsoleCommand",
              properties: { "default:command": "showfps" },
            },
            {
              id: "ok",
              typeId: "debug.executeConsoleCommand",
              properties: { "default:command": "changescene level-2" },
            },
            {
              id: "wired",
              typeId: "debug.executeConsoleCommand",
              properties: { "default:command": "showfps" },
            },
            {
              id: "log",
              typeId: "debug.log",
              properties: { message: "showfps" },
            },
          ],
          edges: [{ targetNodeId: "wired", targetPinId: "command" }],
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

  it("errors when On Command Run uses a reserved engine name", () => {
    const diags = warnReservedConsoleCommandNames(
      [
        {
          id: "event-graph",
          nodes: [
            {
              id: "run",
              typeId: "flow.event.commandRun",
              properties: { commandName: "pause" },
            },
            {
              id: "ok",
              typeId: "flow.event.commandRun",
              properties: { commandName: "heal" },
            },
          ],
          edges: [],
        },
      ],
      { assetGuid: "graph-1" },
    );
    expect(diags).toEqual([
      {
        severity: "error",
        code: "console.reserved_name",
        message: "Command Name 'pause' is reserved by the engine",
        assetGuid: "graph-1",
        graphId: "event-graph",
        nodeId: "run",
      },
    ]);
  });
});

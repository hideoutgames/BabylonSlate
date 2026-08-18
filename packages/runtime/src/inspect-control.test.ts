import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@babylonslate/bridge";
import { applyInspectControl } from "./inspect-control";

describe("applyInspectControl", () => {
  it("emits inspectSnapshot from inspectWorld when the control is inspect", () => {
    const commands: CommandMessage[] = [];
    const handled = applyInspectControl(
      {
        inspectWorld: () => ({
          tickIndex: 4,
          nodes: [
            {
              id: "cube",
              kind: "actor",
              label: "Cube",
              classId: "Actor",
              parentId: null,
              variables: { ticks: 1 },
            },
          ],
        }),
      },
      { type: "inspect" },
      (command) => {
        commands.push(command);
      },
    );
    expect(handled).toBe(true);
    expect(commands).toEqual([
      {
        type: "inspectSnapshot",
        snapshot: {
          tickIndex: 4,
          nodes: [
            {
              id: "cube",
              kind: "actor",
              label: "Cube",
              classId: "Actor",
              parentId: null,
              variables: { ticks: 1 },
            },
          ],
        },
      },
    ]);
  });

  it("ignores unrelated control messages", () => {
    const commands: CommandMessage[] = [];
    expect(
      applyInspectControl(
        { inspectWorld: () => ({ tickIndex: 0, nodes: [] }) },
        { type: "pause" },
        (command) => {
          commands.push(command);
        },
      ),
    ).toBe(false);
    expect(commands).toEqual([]);
  });
});

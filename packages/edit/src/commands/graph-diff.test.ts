import { describe, expect, it } from "vitest";
import { createDefaultGraph } from "@babylonslate/core";
import { MoveNodeCommand } from "./graph";
import { diffGraphCommands } from "./graph-diff";

describe("diffGraphCommands", () => {
  it("emits a move command when a node position changes", () => {
    const before = createDefaultGraph();
    const after = {
      ...before,
      nodes: before.nodes.map((node) => ({
        ...node,
        position: { x: node.position.x + 10, y: node.position.y + 5 },
      })),
    };

    const commands = diffGraphCommands(before, after);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toBeInstanceOf(MoveNodeCommand);
  });

  it("returns no commands when graphs are identical", () => {
    const graph = createDefaultGraph();
    expect(diffGraphCommands(graph, graph)).toEqual([]);
  });
});

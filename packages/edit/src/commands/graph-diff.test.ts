import { describe, expect, it } from "vitest";
import { createDefaultGraph } from "@babylonslate/core";
import {
  AddNodeCommand,
  MoveNodeCommand,
  RemoveNodeCommand,
  SetGraphMembersCommand,
  SetGraphComponentsCommand,
} from "./graph";
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

  it("emits AddNodeCommand when a node appears in after", () => {
    const before = createDefaultGraph();
    const added = {
      id: "branch-1",
      type: "flow.branch",
      position: { x: 40, y: 80 },
      data: { title: "Branch" },
    };
    const after = { ...before, nodes: [...before.nodes, added] };

    const commands = diffGraphCommands(before, after);
    expect(commands.some((c) => c instanceof AddNodeCommand)).toBe(true);
    const add = commands.find((c) => c instanceof AddNodeCommand) as AddNodeCommand;
    expect(add.node).toEqual(added);
  });

  it("emits RemoveNodeCommand when a node disappears from after", () => {
    const before = createDefaultGraph();
    const after = { ...before, nodes: [] };

    const commands = diffGraphCommands(before, after);
    expect(commands.some((c) => c instanceof RemoveNodeCommand)).toBe(true);
  });

  it("emits SetGraphMembersCommand when class members change", () => {
    const before = createDefaultGraph();
    const after = {
      ...before,
      members: [{ id: "fn-1", kind: "function" as const, name: "Jump" }],
    };
    const commands = diffGraphCommands(before, after);
    expect(commands.some((c) => c instanceof SetGraphMembersCommand)).toBe(
      true,
    );
  });

  it("emits SetGraphComponentsCommand when prefab components change", () => {
    const before = createDefaultGraph();
    const after = {
      ...before,
      components: [
        { id: "mesh-1", classId: "MeshComponent", properties: { meshKind: "box" } },
      ],
    };
    const commands = diffGraphCommands(before, after);
    expect(commands.some((c) => c instanceof SetGraphComponentsCommand)).toBe(
      true,
    );
  });
});


import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { createDefaultGraph, type SerializedGraph } from "@babylonslate/core";
import {
  AddEdgeCommand,
  AddNodeCommand,
  MoveNodeCommand,
  RemoveEdgeCommand,
  RemoveNodeCommand,
  SetGraphMembersCommand,
  SetGraphActorDefaultsCommand,
  SetGraphComponentsCommand,
  SetGraphFunctionGraphsCommand,
  SetNodeDataCommand,
} from "./graph";
import { diffGraphCommands } from "./graph-diff";
import { EditSession } from "../session";
import { commandToJournalPayload, reviveCommand } from "../journal";

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

  it("emits an undoable SetGraphActorDefaultsCommand when Actor Defaults change", () => {
    const before = createDefaultGraph();
    const after = { ...before, actorDefaults: { generateHitEvents: false, eventTick: "disabled" as const } };
    const commands = diffGraphCommands(before, after);
    expect(commands).toHaveLength(1);
    const command = commands[0] as SetGraphActorDefaultsCommand;
    expect(command).toBeInstanceOf(SetGraphActorDefaultsCommand);
    expect(command.apply(before).actorDefaults).toEqual(after.actorDefaults);
    expect(command.invert().apply(after)).not.toHaveProperty("actorDefaults");
  });

  it("emits SetGraphComponentsCommand when prefab components change", () => {
    const before = createDefaultGraph();
    const after = {
      ...before,
      components: [
        { id: "mesh-1", classId: "MeshComponent", properties: { meshKind: "box" }, parentId: null },
      ],
    };
    const commands = diffGraphCommands(before, after);
    expect(commands.some((c) => c instanceof SetGraphComponentsCommand)).toBe(
      true,
    );
  });

  it("emits an undoable SetGraphComponentsCommand when the default prefab mesh is deleted", () => {
    const before: SerializedGraph = { ...createDefaultGraph() };
    delete before.components;
    const after = { ...before, components: [] };
    const commands = diffGraphCommands(before, after);
    expect(commands).toHaveLength(1);
    const [command] = commands as [SetGraphComponentsCommand];
    expect(command.apply(before).components).toEqual([]);
    expect(command.invert().apply(after)).not.toHaveProperty("components");
  });

  it("emits AddEdgeCommand and RemoveEdgeCommand for edge deltas", () => {
    const before = createDefaultGraph();
    const edge = {
      id: "e1",
      source: "log-1",
      target: "log-1",
      sourceHandle: "out",
      targetHandle: "in",
    };
    const withEdge = { ...before, edges: [edge] };
    const addCommands = diffGraphCommands(before, withEdge);
    expect(addCommands.some((c) => c instanceof AddEdgeCommand)).toBe(true);
    expect(
      (addCommands.find((c) => c instanceof AddEdgeCommand) as AddEdgeCommand)
        .edge,
    ).toEqual(edge);

    const removeCommands = diffGraphCommands(withEdge, before);
    expect(removeCommands.some((c) => c instanceof RemoveEdgeCommand)).toBe(
      true,
    );
  });

  it("emits SetGraphFunctionGraphsCommand when function graphs change", () => {
    const before = createDefaultGraph();
    const after = {
      ...before,
      functionGraphs: {
        "fn-1": {
          nodes: [
            {
              id: "fn-1-input",
              type: "flow.function.input",
              position: { x: 80, y: 120 },
              data: { title: "Input", __protected: true },
            },
          ],
          edges: [],
        },
      },
    };
    const commands = diffGraphCommands(before, after);
    expect(
      commands.some((c) => c instanceof SetGraphFunctionGraphsCommand),
    ).toBe(true);
    const set = commands.find(
      (c) => c instanceof SetGraphFunctionGraphsCommand,
    ) as SetGraphFunctionGraphsCommand;
    expect(set.to).toEqual(after.functionGraphs);
  });

  it("keeps a seeded function graph after applying the add-function diff", () => {
    const before = createDefaultGraph();
    const after: typeof before = {
      ...before,
      members: [{ id: "fn-1", kind: "function", name: "Jump" }],
      functionGraphs: {
        "fn-1": {
          nodes: [
            {
              id: "fn-1-input",
              type: "flow.function.input",
              position: { x: 80, y: 120 },
              data: { title: "Input", __protected: true },
            },
            {
              id: "fn-1-output",
              type: "flow.function.output",
              position: { x: 420, y: 120 },
              data: { title: "Output", __protected: true },
            },
          ],
          edges: [],
        },
      },
    };
    let current = before;
    for (const command of diffGraphCommands(before, after)) {
      current = command.apply(current);
    }
    expect(current.members).toEqual(after.members);
    expect(current.functionGraphs).toEqual(after.functionGraphs);
  });

  it("emits SetNodeDataCommand when node data changes", () => {
    const before = createDefaultGraph();
    const after = {
      ...before,
      nodes: before.nodes.map((node) =>
        node.id === "log-1"
          ? { ...node, data: { ...node.data, message: "Updated" } }
          : node,
      ),
    };
    const commands = diffGraphCommands(before, after);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toBeInstanceOf(SetNodeDataCommand);
    const setData = commands[0] as SetNodeDataCommand;
    expect(setData.nodeId).toBe("log-1");
    expect(setData.to).toMatchObject({ message: "Updated" });
  });
});

const NODE_IDS = ["n1", "n2", "n3", "n4"] as const;
const EDGE_IDS = ["e1", "e2", "e3", "e4"] as const;

const nodeArb = fc.record({
  id: fc.constantFrom(...NODE_IDS),
  type: fc.constantFrom("flow.branch", "debug.print"),
  position: fc.record({ x: fc.integer({ min: 0, max: 2 }), y: fc.constant(0) }),
  data: fc.dictionary(fc.constantFrom("title", "message"), fc.constantFrom("A", "B")),
});

const edgeArb = fc.record({
  id: fc.constantFrom(...EDGE_IDS),
  source: fc.constantFrom(...NODE_IDS),
  target: fc.constantFrom(...NODE_IDS),
  sourceHandle: fc.constantFrom("then", "else"),
  type: fc.constantFrom("exec", "data"),
}, { requiredKeys: ["id", "source", "target"] });

/** Unique rows in any order; edges only between nodes the graph holds. */
const graphArb: fc.Arbitrary<SerializedGraph> = fc.record({
  nodes: fc.uniqueArray(nodeArb, { selector: (node) => node.id, maxLength: 4 }),
  edges: fc.uniqueArray(edgeArb, { selector: (edge) => edge.id, maxLength: 4 }),
}).map(({ nodes, edges }) => {
  const ids = new Set(nodes.map((node) => node.id));
  return { nodes, edges: edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)) };
});

describe("diffGraphCommands round trip", () => {
  it("reproduces rewired edges, retyped nodes and row order, undoes exactly, and replays from the journal", () => {
    fc.assert(
      fc.property(graphArb, graphArb, (before, after) => {
        const commands = diffGraphCommands(before, after);
        const session = new EditSession();
        const applied = session.applyBatch("graph", before, commands)?.doc ?? before;
        expect(applied).toEqual(after);
        expect(session.undo("graph", applied)?.doc ?? applied).toEqual(before);

        let replayed = before;
        for (const command of commands) {
          const line = JSON.parse(JSON.stringify(commandToJournalPayload(command))) as { type: string };
          replayed = reviveCommand(line)!.apply(replayed) as SerializedGraph;
        }
        expect(replayed).toEqual(after);
      }),
      { numRuns: 300 },
    );
  });
});

import { describe, expect, it } from "vitest";
import {
  createDefaultBehaviourTree,
  type BehaviourTreeDocument,
  type BtNode,
} from "./index";
import {
  BT_CHILDREN_HANDLE,
  BT_NODE_TYPE,
  BT_PARENT_HANDLE,
  applyNodePositions,
  arrangeBehaviourTree,
  behaviourTreeToSerialized,
  hydrateBehaviourTreeForEditor,
  layoutBehaviourTree,
  reorderSiblingsByPosition,
  serializedToBehaviourTree,
} from "./serialize";

function node(
  id: string,
  kind: BtNode["kind"],
  classId: string,
  children: string[] = [],
): BtNode {
  return {
    id,
    kind,
    classId,
    children,
    decorators: [],
    services: [],
    properties: {},
  };
}

describe("behaviour tree serialize", () => {
  it("maps parent-child edges with children/parent handles and sortIndex", () => {
    const tree = createDefaultBehaviourTree();
    const graph = behaviourTreeToSerialized(tree);
    expect(graph.nodes.every((entry) => entry.type === BT_NODE_TYPE)).toBe(true);
    expect(graph.edges).toEqual([
      {
        id: "bt-root-sequence",
        source: "root",
        target: "sequence",
        sourceHandle: BT_CHILDREN_HANDLE,
        targetHandle: BT_PARENT_HANDLE,
      },
      {
        id: "bt-sequence-task",
        source: "sequence",
        target: "task",
        sourceHandle: BT_CHILDREN_HANDLE,
        targetHandle: BT_PARENT_HANDLE,
      },
    ]);
    const sequence = graph.nodes.find((entry) => entry.id === "sequence");
    expect(sequence?.data.sortIndex).toBe(0);
    expect(sequence?.data.title).toBe("Sequence");
    expect(graph.nodes.find((entry) => entry.id === "root")?.data.__protected).toBe(true);
    expect(Array.isArray(sequence?.data.decorators)).toBe(true);
  });

  it("round-trips a tree with attached decorator rows (not independent nodes)", () => {
    const tree = createDefaultBehaviourTree();
    const sequence = tree.nodes.find((entry) => entry.id === "sequence")!;
    sequence.decorators.push({
      id: "dec-1",
      classId: "bt.decorator.blackboardIsSet",
      abortMode: "self",
      observedKeys: ["alert"],
      properties: { key: "alert" },
    });
    const graph = behaviourTreeToSerialized(tree);
    expect(graph.nodes.map((entry) => entry.id).sort()).toEqual([
      "root",
      "sequence",
      "task",
    ]);
    expect(graph.nodes.find((entry) => entry.id === "sequence")?.data.decorators).toEqual(
      sequence.decorators.map((row) => ({
        ...row,
        title: "Blackboard Is Set",
      })),
    );
    const restored = serializedToBehaviourTree(graph, tree);
    expect(restored.nodes.find((entry) => entry.id === "sequence")?.decorators).toEqual(
      sequence.decorators,
    );
  });

  it("marks every node on the running stack, not only the leaf", () => {
    const graph = behaviourTreeToSerialized(createDefaultBehaviourTree(), {
      lastResults: {},
      btNodeId: "task",
      stack: [
        { nodeId: "root", childIndex: 0, opened: true },
        { nodeId: "sequence", childIndex: 0, opened: true },
        { nodeId: "task", childIndex: 0, opened: true },
      ],
    });
    expect(
      graph.nodes.filter((entry) => entry.data.running === true).map((entry) => entry.id),
    ).toEqual(["root", "sequence", "task"]);
  });

  it("lays out the root above its children", () => {
    const tree = createDefaultBehaviourTree();
    const positions = layoutBehaviourTree(tree);
    const root = positions.get("root")!;
    const sequence = positions.get("sequence")!;
    const task = positions.get("task")!;
    expect(root.y).toBeLessThan(sequence.y);
    expect(sequence.y).toBeLessThan(task.y);
  });

  it("reorders siblings by canvas x then re-layout keeps that order", () => {
    const tree: BehaviourTreeDocument = {
      name: "Siblings",
      rootId: "root",
      blackboardGuid: null,
      nodes: [
        node("root", "selector", "bt.composite.selector", ["a", "b"]),
        node("a", "task", "bt.task.succeed"),
        node("b", "task", "bt.task.fail"),
      ],
    };
    const reordered = reorderSiblingsByPosition(tree, {
      a: { x: 400, y: 200 },
      b: { x: 10, y: 200 },
    });
    expect(reordered.nodes.find((entry) => entry.id === "root")?.children).toEqual([
      "b",
      "a",
    ]);
  });

  it("keeps equal-x siblings in their original order", () => {
    const tree: BehaviourTreeDocument = {
      name: "Ties",
      rootId: "root",
      blackboardGuid: null,
      nodes: [
        node("root", "selector", "bt.composite.selector", ["a", "b", "c"]),
        node("a", "task", "bt.task.succeed"),
        node("b", "task", "bt.task.fail"),
        node("c", "task", "bt.task.wait"),
      ],
    };
    const reordered = reorderSiblingsByPosition(tree, {
      a: { x: 10 },
      b: { x: 10 },
      c: { x: 10 },
    });
    expect(reordered.nodes.find((entry) => entry.id === "root")?.children).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("uses persisted editor positions instead of recomputing layout", () => {
    const tree = createDefaultBehaviourTree();
    tree.editorPositions = {
      root: { x: 12, y: 8 },
      sequence: { x: 400, y: 8 },
      task: { x: 400, y: 300 },
    };
    const graph = behaviourTreeToSerialized(tree);
    expect(graph.nodes.find((entry) => entry.id === "sequence")?.position).toEqual({
      x: 400,
      y: 8,
    });
    expect(graph.nodes.find((entry) => entry.id === "root")?.position).toEqual({
      x: 12,
      y: 8,
    });
  });

  it("fills missing persisted positions from computed layout without writing them", () => {
    const tree = createDefaultBehaviourTree();
    tree.editorPositions = { root: { x: 80, y: 16 } };
    const graph = behaviourTreeToSerialized(tree);
    expect(graph.nodes.find((entry) => entry.id === "root")?.position).toEqual({
      x: 80,
      y: 16,
    });
    const sequence = graph.nodes.find((entry) => entry.id === "sequence")?.position;
    const task = graph.nodes.find((entry) => entry.id === "task")?.position;
    expect(sequence).toEqual(layoutBehaviourTree(tree).get("sequence"));
    expect(task).toEqual(layoutBehaviourTree(tree).get("task"));
    expect(tree.editorPositions).toEqual({ root: { x: 80, y: 16 } });
  });

  it("captures canvas positions when converting a graph back to a tree", () => {
    const tree = createDefaultBehaviourTree();
    const graph = behaviourTreeToSerialized(tree);
    graph.nodes = graph.nodes.map((entry) =>
      entry.id === "task"
        ? { ...entry, position: { x: 333, y: 444 } }
        : entry,
    );
    const restored = serializedToBehaviourTree(graph, tree);
    expect(restored.editorPositions?.task).toEqual({ x: 333, y: 444 });
    expect(restored.nodes.find((entry) => entry.id === "sequence")?.children).toEqual([
      "task",
    ]);
  });

  it("keeps previous sibling order when canvas X is tied", () => {
    const tree: BehaviourTreeDocument = {
      name: "Tie",
      rootId: "root",
      blackboardGuid: null,
      nodes: [
        node("root", "selector", "bt.composite.selector", ["a", "b"]),
        node("a", "task", "bt.task.succeed"),
        node("b", "task", "bt.task.fail"),
      ],
    };
    const graph = behaviourTreeToSerialized(tree);
    const restored = serializedToBehaviourTree(
      {
        ...graph,
        nodes: graph.nodes.map((entry) =>
          entry.id === "a" || entry.id === "b"
            ? { ...entry, position: { x: 40, y: 200 } }
            : entry,
        ),
        edges: [
          {
            id: "bt-root-b",
            source: "root",
            target: "b",
            sourceHandle: BT_CHILDREN_HANDLE,
            targetHandle: BT_PARENT_HANDLE,
          },
          {
            id: "bt-root-a",
            source: "root",
            target: "a",
            sourceHandle: BT_CHILDREN_HANDLE,
            targetHandle: BT_PARENT_HANDLE,
          },
        ],
      },
      tree,
    );
    expect(restored.nodes.find((entry) => entry.id === "root")?.children).toEqual([
      "a",
      "b",
    ]);
  });

  it("arranges nodes without changing sibling order", () => {
    const tree: BehaviourTreeDocument = {
      name: "Arrange",
      rootId: "root",
      blackboardGuid: null,
      editorPositions: {
        root: { x: 900, y: 10 },
        a: { x: 10, y: 400 },
        b: { x: 800, y: 20 },
      },
      nodes: [
        node("root", "selector", "bt.composite.selector", ["a", "b"]),
        node("a", "task", "bt.task.succeed"),
        node("b", "task", "bt.task.fail"),
      ],
    };
    const arranged = arrangeBehaviourTree(tree);
    expect(arranged.nodes.find((entry) => entry.id === "root")?.children).toEqual([
      "a",
      "b",
    ]);
    expect(arranged.editorPositions?.a?.x).toBeLessThan(arranged.editorPositions?.b?.x ?? 0);
    expect(arranged.editorPositions?.root?.y).toBeLessThan(
      arranged.editorPositions?.a?.y ?? 0,
    );
  });

  it("persists moved positions and reorders siblings in one document", () => {
    const tree: BehaviourTreeDocument = {
      name: "Move",
      rootId: "root",
      blackboardGuid: null,
      nodes: [
        node("root", "selector", "bt.composite.selector", ["a", "b"]),
        node("a", "task", "bt.task.succeed"),
        node("b", "task", "bt.task.fail"),
      ],
    };
    const next = applyNodePositions(tree, {
      root: { x: 40, y: 10 },
      a: { x: 400, y: 200 },
      b: { x: 10, y: 200 },
    });
    expect(next.nodes.find((entry) => entry.id === "root")?.children).toEqual(["b", "a"]);
    expect(next.editorPositions).toEqual({
      root: { x: 40, y: 10 },
      a: { x: 400, y: 200 },
      b: { x: 10, y: 200 },
    });
  });

  it("hydrates parent/children pins for the editor", () => {
    const graph = hydrateBehaviourTreeForEditor(
      behaviourTreeToSerialized(createDefaultBehaviourTree()),
    );
    const root = graph.nodes.find((entry) => entry.id === "root");
    const pins = root?.data.__pins as Array<{ id: string }>;
    expect(pins?.map((pin) => pin.id)).toEqual([BT_PARENT_HANDLE, BT_CHILDREN_HANDLE]);
  });
});

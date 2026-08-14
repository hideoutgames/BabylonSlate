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

  it("hydrates parent/children pins for the editor", () => {
    const graph = hydrateBehaviourTreeForEditor(
      behaviourTreeToSerialized(createDefaultBehaviourTree()),
    );
    const root = graph.nodes.find((entry) => entry.id === "root");
    const pins = root?.data.__pins as Array<{ id: string }>;
    expect(pins?.map((pin) => pin.id)).toEqual([BT_PARENT_HANDLE, BT_CHILDREN_HANDLE]);
  });
});

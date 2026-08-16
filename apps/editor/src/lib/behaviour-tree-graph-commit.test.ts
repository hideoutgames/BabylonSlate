import { describe, expect, it } from "vitest";
import {
  behaviourTreeToSerialized,
  createDefaultBehaviourTree,
  type BehaviourTreeDocument,
} from "@babylonslate/behaviour-tree";
import { commitBehaviourTreeGraphChange } from "./behaviour-tree-graph-commit";

function treeWithSiblings(): BehaviourTreeDocument {
  const doc = createDefaultBehaviourTree();
  doc.nodes.push({
    id: "wait",
    kind: "task",
    classId: "bt.task.wait",
    children: [],
    decorators: [],
    services: [],
    properties: { durationMs: 100 },
  });
  const sequence = doc.nodes.find((node) => node.id === "sequence")!;
  sequence.children = ["task", "wait"];
  return doc;
}

describe("commitBehaviourTreeGraphChange", () => {
  it("applies positions without a merge key so each finished move is one undo", () => {
    const doc = treeWithSiblings();
    const graph = behaviourTreeToSerialized(doc);
    graph.nodes = graph.nodes.map((entry) =>
      entry.id === "wait" ? { ...entry, position: { x: -40, y: 360 } } : entry,
    );
    const first = commitBehaviourTreeGraphChange(doc, graph, { kind: "position" }, "sequence");
    expect(first.mergeKey).toBeUndefined();
    expect(first.next.nodes.find((node) => node.id === "sequence")?.children).toEqual([
      "wait",
      "task",
    ]);

    const movedAgain = behaviourTreeToSerialized(first.next);
    movedAgain.nodes = movedAgain.nodes.map((entry) =>
      entry.id === "wait" ? { ...entry, position: { x: 800, y: 360 } } : entry,
    );
    const second = commitBehaviourTreeGraphChange(
      first.next,
      movedAgain,
      { kind: "position" },
      "sequence",
    );
    expect(second.mergeKey).toBeUndefined();
    expect(second.next.nodes.find((node) => node.id === "sequence")?.children).toEqual([
      "task",
      "wait",
    ]);
  });
});

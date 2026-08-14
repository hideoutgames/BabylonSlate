import { describe, expect, it } from "vitest";
import {
  createDefaultBehaviourTree,
  validateBehaviourTree,
  type BehaviourTreeDocument,
} from "./index";

function codes(doc: BehaviourTreeDocument): string[] {
  return validateBehaviourTree(doc, { assetGuid: "tree-1" }).map((row) => row.code);
}

describe("validateBehaviourTree", () => {
  it("accepts the default tree", () => {
    expect(validateBehaviourTree(createDefaultBehaviourTree(), { assetGuid: "t" })).toEqual(
      [],
    );
  });

  it("flags a missing root", () => {
    const doc = createDefaultBehaviourTree();
    doc.rootId = "gone";
    expect(codes(doc)).toContain("bt.missing_root");
  });

  it("flags an unknown child id", () => {
    const doc = createDefaultBehaviourTree();
    doc.nodes[0]!.children.push("missing-child");
    expect(codes(doc)).toContain("bt.unknown_child");
  });

  it("flags a parent-child cycle", () => {
    const doc = createDefaultBehaviourTree();
    const root = doc.nodes.find((node) => node.id === doc.rootId)!;
    const sequence = doc.nodes.find((node) => node.id === root.children[0])!;
    sequence.children.push(root.id);
    expect(codes(doc)).toContain("bt.cycle");
  });

  it("flags an empty composite", () => {
    const doc = createDefaultBehaviourTree();
    const root = doc.nodes.find((node) => node.id === doc.rootId)!;
    root.children = [];
    expect(codes(doc)).toContain("bt.composite_empty");
  });

  it("flags a task that owns children", () => {
    const doc = createDefaultBehaviourTree();
    const task = doc.nodes.find((node) => node.kind === "task")!;
    const extra = doc.nodes.find((node) => node.kind === "sequence")!;
    task.children = [extra.id];
    expect(codes(doc)).toContain("bt.task_has_children");
  });
});

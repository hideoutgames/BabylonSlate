import { describe, expect, it } from "vitest";
import { createDefaultBehaviourTree, type BehaviourTreeDocument, type BtNode } from "./index";
import {
  addChildNode,
  addDecorator,
  addService,
  canReparentNode,
  deleteSubtree,
  duplicateSubtree,
  moveAttachment,
  pruneUnreachable,
  removeAttachment,
  reparentNode,
  wrapInSequence,
} from "./edit";

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

function tree(nodes: BtNode[], rootId: string): BehaviourTreeDocument {
  return { name: "Test", rootId, nodes, blackboardGuid: null };
}

describe("wrapInSequence", () => {
  it("inserts a sequence between a child and its parent", () => {
    const next = wrapInSequence(createDefaultBehaviourTree(), "task");
    const sequence = next.nodes.find((entry) => entry.id === "sequence")!;
    const wrapper = next.nodes.find((entry) => entry.id === sequence.children[0])!;
    expect(wrapper.kind).toBe("sequence");
    expect(wrapper.children).toEqual(["task"]);
    expect(next.nodes.some((entry) => entry.id === "task")).toBe(true);
  });

  it("makes a new sequence the root when wrapping the root", () => {
    const next = wrapInSequence(createDefaultBehaviourTree(), "root");
    expect(next.rootId).not.toBe("root");
    const wrapper = next.nodes.find((entry) => entry.id === next.rootId)!;
    expect(wrapper.kind).toBe("sequence");
    expect(wrapper.children).toEqual(["root"]);
  });
});

describe("duplicateSubtree", () => {
  it("clones a node and its descendants as the next sibling", () => {
    const next = duplicateSubtree(createDefaultBehaviourTree(), "sequence");
    const root = next.nodes.find((entry) => entry.id === "root")!;
    expect(root.children).toHaveLength(2);
    expect(root.children[0]).toBe("sequence");
    const cloneId = root.children[1]!;
    const clone = next.nodes.find((entry) => entry.id === cloneId)!;
    expect(clone.kind).toBe("sequence");
    expect(clone.children).not.toEqual(["task"]);
    expect(clone.children.length).toBe(1);
    expect(next.nodes.some((entry) => entry.id === clone.children[0])).toBe(true);
  });
});

describe("deleteSubtree", () => {
  it("refuses to delete the root", () => {
    const doc = createDefaultBehaviourTree();
    expect(deleteSubtree(doc, "root")).toEqual(doc);
  });

  it("removes a node, its descendants, and the parent link", () => {
    const next = deleteSubtree(createDefaultBehaviourTree(), "sequence");
    expect(next.nodes.map((entry) => entry.id)).toEqual(["root"]);
    expect(next.nodes[0]!.children).toEqual([]);
  });
});

describe("pruneUnreachable", () => {
  it("drops nodes that are not under the root", () => {
    const doc = createDefaultBehaviourTree();
    doc.nodes.push(node("lost", "task", "bt.task.succeed"));
    const next = pruneUnreachable(doc);
    expect(next.nodes.map((entry) => entry.id)).not.toContain("lost");
  });
});

describe("addChildNode", () => {
  it("adds a Wait child with default duration under a composite", () => {
    const next = addChildNode(createDefaultBehaviourTree(), "sequence", "bt.task.wait");
    const wait = next.nodes.find((entry) => entry.classId === "bt.task.wait");
    expect(wait?.properties).toEqual({ durationMs: 1000 });
    expect(next.nodes.find((entry) => entry.id === "sequence")?.children).toContain(
      wait?.id,
    );
  });

  it("refuses to add a child under a task", () => {
    const doc = createDefaultBehaviourTree();
    expect(addChildNode(doc, "task", "bt.task.wait")).toBe(doc);
  });

  it("adds a custom BTComposite as a sequence from ancestry", () => {
    const next = addChildNode(
      createDefaultBehaviourTree(),
      "sequence",
      "MyBrain",
      (id) => (id === "MyBrain" ? "BTComposite" : null),
    );
    const child = next.nodes.find((entry) => entry.classId === "MyBrain");
    expect(child?.kind).toBe("sequence");
  });
});

describe("attachments", () => {
  it("adds, reorders, and removes decorator rows", () => {
    let doc = addDecorator(createDefaultBehaviourTree(), "root", "bt.decorator.loop");
    doc = addDecorator(doc, "root", "bt.decorator.cooldown");
    const root = () => doc.nodes.find((entry) => entry.id === "root")!;
    expect(root().decorators.map((row) => row.classId)).toEqual([
      "bt.decorator.loop",
      "bt.decorator.cooldown",
    ]);
    expect(root().decorators[0]!.properties).toEqual({ numLoops: 0 });
    doc = moveAttachment(doc, "root", root().decorators[1]!.id, -1);
    expect(root().decorators.map((row) => row.classId)).toEqual([
      "bt.decorator.cooldown",
      "bt.decorator.loop",
    ]);
    doc = removeAttachment(doc, "root", root().decorators[0]!.id);
    expect(root().decorators.map((row) => row.classId)).toEqual(["bt.decorator.loop"]);
  });

  it("adds a service with interval defaults", () => {
    const doc = addService(createDefaultBehaviourTree(), "root", "bt.service.setBlackboard");
    const service = doc.nodes.find((entry) => entry.id === "root")!.services[0]!;
    expect(service.classId).toBe("bt.service.setBlackboard");
    expect(service.intervalMs).toBe(250);
    expect(service.properties).toEqual({ key: "", value: true });
  });
});

describe("editor placement", () => {
  it("stores an explicit child position without changing other siblings", () => {
    const doc = createDefaultBehaviourTree();
    doc.editorPositions = {
      root: { x: 40, y: 10 },
      sequence: { x: 40, y: 180 },
      task: { x: 40, y: 360 },
    };
    const next = addChildNode(doc, "sequence", "bt.task.wait", {
      position: { x: 220, y: 360 },
    });
    const wait = next.nodes.find((entry) => entry.classId === "bt.task.wait");
    expect(wait).toBeDefined();
    expect(next.editorPositions?.[wait!.id]).toEqual({ x: 220, y: 360 });
    expect(next.editorPositions?.task).toEqual({ x: 40, y: 360 });
  });

  it("offsets duplicated subtree positions", () => {
    const doc = createDefaultBehaviourTree();
    doc.editorPositions = {
      root: { x: 40, y: 10 },
      sequence: { x: 40, y: 180 },
      task: { x: 40, y: 360 },
    };
    const next = duplicateSubtree(doc, "sequence");
    const cloneId = next.nodes.find((entry) => entry.id === "root")!.children[1]!;
    expect(next.editorPositions?.[cloneId]).toEqual({ x: 80, y: 220 });
    expect(next.editorPositions?.sequence).toEqual({ x: 40, y: 180 });
  });

  it("places a wrap sequence on the wrapped node without dropping its position", () => {
    const doc = createDefaultBehaviourTree();
    doc.editorPositions = {
      root: { x: 40, y: 10 },
      sequence: { x: 40, y: 180 },
      task: { x: 90, y: 360 },
    };
    const next = wrapInSequence(doc, "task");
    const wrapperId = next.nodes.find((entry) => entry.id === "sequence")!.children[0]!;
    expect(next.editorPositions?.[wrapperId]).toEqual({ x: 90, y: 360 });
    expect(next.editorPositions?.task?.y).toBeGreaterThan(360);
  });

  it("drops deleted subtree positions", () => {
    const doc = createDefaultBehaviourTree();
    doc.editorPositions = {
      root: { x: 40, y: 10 },
      sequence: { x: 40, y: 180 },
      task: { x: 40, y: 360 },
    };
    const next = deleteSubtree(doc, "sequence");
    expect(next.editorPositions).toEqual({ root: { x: 40, y: 10 } });
  });

  it("drops unreachable node positions", () => {
    const doc = createDefaultBehaviourTree();
    doc.nodes.push(node("lost", "task", "bt.task.succeed"));
    doc.editorPositions = {
      root: { x: 1, y: 1 },
      sequence: { x: 2, y: 2 },
      task: { x: 3, y: 3 },
      lost: { x: 9, y: 9 },
    };
    const next = pruneUnreachable(doc);
    expect(next.editorPositions?.lost).toBeUndefined();
    expect(next.editorPositions?.root).toEqual({ x: 1, y: 1 });
  });
});

describe("reparentNode", () => {
  function branched(): BehaviourTreeDocument {
    return tree(
      [
        node("root", "selector", "bt.composite.selector", ["left", "right"]),
        node("left", "sequence", "bt.composite.sequence", ["leaf"]),
        node("right", "sequence", "bt.composite.sequence"),
        node("leaf", "task", "bt.task.succeed"),
      ],
      "root",
    );
  }

  it("moves a node under another composite and rejects cycles", () => {
    const doc = branched();
    expect(canReparentNode(doc, "leaf", "right")).toBe(true);
    const next = reparentNode(doc, "leaf", "right");
    expect(next.nodes.find((entry) => entry.id === "left")?.children).toEqual([]);
    expect(next.nodes.find((entry) => entry.id === "right")?.children).toEqual(["leaf"]);
    expect(canReparentNode(doc, "left", "leaf")).toBe(false);
    expect(reparentNode(doc, "left", "leaf")).toBe(doc);
  });

  it("refuses the root, a task parent, and self-links", () => {
    const doc = branched();
    expect(canReparentNode(doc, "root", "right")).toBe(false);
    expect(canReparentNode(doc, "leaf", "leaf")).toBe(false);
    expect(canReparentNode(doc, "right", "leaf")).toBe(false);
    expect(reparentNode(doc, "root", "right")).toBe(doc);
    expect(reparentNode(doc, "leaf", "leaf")).toBe(doc);
  });
});

describe("edit helpers ignore unknown ids", () => {
  it("returns the same document when the node is missing", () => {
    const doc = tree([node("root", "selector", "bt.composite.selector")], "root");
    expect(wrapInSequence(doc, "gone")).toBe(doc);
    expect(duplicateSubtree(doc, "gone")).toBe(doc);
    expect(addDecorator(doc, "gone", "bt.decorator.loop")).toBe(doc);
  });
});

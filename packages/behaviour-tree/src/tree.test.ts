import { describe, expect, it } from "vitest";
import {
  createDefaultBehaviourTree,
  createDefaultBlackboard,
  parseBehaviourTreeDocument,
  parseBlackboardDocument,
} from "./index";

describe("behaviour tree documents", () => {
  it("creates a valid default selector with a sequence and succeed task", () => {
    const tree = createDefaultBehaviourTree("Patrol");
    expect(tree.name).toBe("Patrol");
    expect(tree.blackboardGuid).toBeNull();
    const root = tree.nodes.find((node) => node.id === tree.rootId);
    expect(root?.kind).toBe("selector");
    expect(root?.children).toHaveLength(1);
    const sequence = tree.nodes.find((node) => node.id === root?.children[0]);
    expect(sequence?.kind).toBe("sequence");
    const task = tree.nodes.find((node) => node.id === sequence?.children[0]);
    expect(task?.kind).toBe("task");
    expect(task?.classId).toBe("bt.task.succeed");
    expect(task?.children).toEqual([]);
  });

  it("round-trips a tree through JSON parse", () => {
    const tree = createDefaultBehaviourTree();
    const parsed = parseBehaviourTreeDocument(JSON.parse(JSON.stringify(tree)));
    expect(parsed).toEqual(tree);
  });

  it("rejects a payload that is not a tree", () => {
    expect(parseBehaviourTreeDocument(null)).toBeNull();
    expect(parseBehaviourTreeDocument({ nodes: "nope" })).toBeNull();
  });

  it("creates a blackboard with pin-typed keys and round-trips", () => {
    const board = createDefaultBlackboard("AI");
    expect(board.name).toBe("AI");
    expect(board.keys.some((key) => key.name === "alert" && key.type.kind === "bool")).toBe(
      true,
    );
    const parsed = parseBlackboardDocument(JSON.parse(JSON.stringify(board)));
    expect(parsed).toEqual(board);
  });

  it("fills parser defaults and drops invalid attached rows", () => {
    const parsed = parseBehaviourTreeDocument({
      nodes: [
        {
          id: "root",
          kind: "selector",
          children: ["leaf"],
          decorators: [
            { classId: "bt.decorator.blackboardIsSet", abortMode: "nope" },
            { id: "drop-me" },
            null,
          ],
          services: [{ classId: "bt.service.tick" }, { id: "drop-me" }],
        },
        { id: "leaf", kind: "task" },
        { kind: "task" },
        { id: "bad-kind", kind: "mystery" },
      ],
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.rootId).toBe("root");
    expect(parsed?.nodes.map((node) => node.id)).toEqual(["root", "leaf"]);
    expect(parsed?.nodes[0]?.classId).toBe("bt.selector");
    expect(parsed?.nodes[0]?.decorators).toEqual([
      {
        id: "decorator-0",
        classId: "bt.decorator.blackboardIsSet",
        abortMode: "none",
        observedKeys: [],
        properties: {},
      },
    ]);
    expect(parsed?.nodes[0]?.services).toEqual([
      {
        id: "service-0",
        classId: "bt.service.tick",
        intervalMs: 250,
        randomDeviationMs: 0,
        properties: {},
      },
    ]);
  });

  it("round-trips a blackboard key defaultValue", () => {
    const parsed = parseBlackboardDocument({
      name: "",
      keys: [
        { name: "count", type: { kind: "int" }, defaultValue: 3 },
        { type: { kind: "bool" } },
      ],
    });
    expect(parsed).toEqual({
      name: "Blackboard",
      keys: [{ name: "count", type: { kind: "int" }, defaultValue: 3 }],
    });
    expect(parseBlackboardDocument(null)).toBeNull();
  });

  it("keeps attached decorator and service rows on parse", () => {
    const tree = createDefaultBehaviourTree();
    const sequence = tree.nodes.find((node) => node.kind === "sequence")!;
    sequence.decorators.push({
      id: "dec-1",
      classId: "bt.decorator.blackboardIsSet",
      abortMode: "lowerPriority",
      observedKeys: ["alert"],
      properties: { key: "alert" },
    });
    sequence.services.push({
      id: "svc-1",
      classId: "bt.service.tick",
      intervalMs: 250,
      randomDeviationMs: 0,
      properties: {},
    });
    const parsed = parseBehaviourTreeDocument(JSON.parse(JSON.stringify(tree)));
    expect(parsed?.nodes.find((node) => node.id === sequence.id)?.decorators).toEqual(
      sequence.decorators,
    );
    expect(parsed?.nodes.find((node) => node.id === sequence.id)?.services).toEqual(
      sequence.services,
    );
  });
});

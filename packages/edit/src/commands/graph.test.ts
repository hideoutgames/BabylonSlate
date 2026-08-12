import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { SerializedGraph } from "@babylonslate/core";
import {
  AddEdgeCommand,
  AddNodeCommand,
  MoveNodeCommand,
  RemoveEdgeCommand,
  RemoveNodeCommand,
  SetGraphMembersCommand,
  SetNodeDataCommand,
} from "../commands/graph";


const positionArb = fc.record({
  x: fc.integer({ min: -1000, max: 1000 }),
  y: fc.integer({ min: -1000, max: 1000 }),
});

const nodeArb = fc.record({
  id: fc.string({ minLength: 1, maxLength: 12 }),
  type: fc.constant("logMessage"),
  position: positionArb,
  data: fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }), fc.string()),
});

const edgeArb = fc.record({
  id: fc.string({ minLength: 1, maxLength: 12 }),
  source: fc.string({ minLength: 1, maxLength: 12 }),
  target: fc.string({ minLength: 1, maxLength: 12 }),
});

function graphWithNode(node: SerializedGraph["nodes"][number]): SerializedGraph {
  return { nodes: [node], edges: [] };
}

describe("graph commands", () => {
  it("MoveNodeCommand apply-then-invert restores the document", () => {
    fc.assert(
      fc.property(nodeArb, positionArb, positionArb, (node, from, to) => {
        const doc = graphWithNode({ ...node, position: from });
        const command = new MoveNodeCommand(node.id, from, to);
        const afterApply = command.apply(doc);
        const restored = command.invert().apply(afterApply);
        expect(restored).toEqual(doc);
      }),
    );
  });

  it("AddEdgeCommand apply-then-invert restores the document", () => {
    fc.assert(
      fc.property(nodeArb, edgeArb, (node, edge) => {
        const doc = graphWithNode(node);
        const command = new AddEdgeCommand(edge);
        const afterApply = command.apply(doc);
        const restored = command.invert().apply(afterApply);
        expect(restored).toEqual(doc);
      }),
    );
  });

  it("RemoveEdgeCommand apply-then-invert restores the document", () => {
    fc.assert(
      fc.property(nodeArb, edgeArb, (node, edge) => {
        const doc: SerializedGraph = {
          nodes: [node],
          edges: [edge],
        };
        const command = new RemoveEdgeCommand(edge);
        const afterApply = command.apply(doc);
        const restored = command.invert().apply(afterApply);
        expect(restored).toEqual(doc);
      }),
    );
  });

  it("SetNodeDataCommand apply-then-invert restores the document", () => {
    fc.assert(
      fc.property(
        nodeArb,
        fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }), fc.string()),
        fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }), fc.string()),
        (node, from, to) => {
          const doc = graphWithNode({ ...node, data: from });
          const command = new SetNodeDataCommand(node.id, from, to);
          const afterApply = command.apply(doc);
          const restored = command.invert().apply(afterApply);
          expect(restored).toEqual(doc);
        },
      ),
    );
  });

  it("AddNodeCommand apply-then-invert restores the document", () => {
    fc.assert(
      fc.property(nodeArb, (node) => {
        const doc: SerializedGraph = { nodes: [], edges: [] };
        const command = new AddNodeCommand(node);
        const afterApply = command.apply(doc);
        expect(afterApply.nodes).toEqual([node]);
        const restored = command.invert().apply(afterApply);
        expect(restored).toEqual(doc);
      }),
    );
  });

  it("RemoveNodeCommand apply-then-invert restores the document", () => {
    fc.assert(
      fc.property(nodeArb, (node) => {
        const doc = graphWithNode(node);
        const command = new RemoveNodeCommand(node);
        const afterApply = command.apply(doc);
        expect(afterApply.nodes).toEqual([]);
        const restored = command.invert().apply(afterApply);
        expect(restored).toEqual(doc);
      }),
    );
  });

  it("SetGraphMembersCommand apply-then-invert restores the document", () => {
    const doc: SerializedGraph = { nodes: [], edges: [] };
    const members = [{ id: "fn-1", kind: "function" as const, name: "Jump" }];
    const command = new SetGraphMembersCommand(undefined, members);
    const afterApply = command.apply(doc);
    expect(afterApply.members).toEqual(members);
    expect(command.invert().apply(afterApply)).toEqual(doc);
  });
});

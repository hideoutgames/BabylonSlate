import type { Edge } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { styleFlowEdges } from "./edge-style";
import { pinTypeKey, type PinDisplayNode } from "./wildcard-display";

describe("styleFlowEdges", () => {
  it("bounds source-node reads when styling many edges", () => {
    let nodeReads = 0;
    const nodes: PinDisplayNode[] = Array.from({ length: 500 }, (_, i) => ({
      get id() {
        nodeReads++;
        return `node-${i}`;
      },
      data: { __pins: [{ id: "out", type: { kind: "exec" } }] },
    }));
    const edges: Edge[] = Array.from({ length: 800 }, (_, i) => ({
      id: `edge-${i}`,
      source: "node-499",
      sourceHandle: "out",
      target: `node-${i % 499}`,
    }));

    const styled = styleFlowEdges(edges, nodes, new Map());

    expect(styled).toHaveLength(edges.length);
    expect(
      styled.every(
        (edge) =>
          edge.style?.stroke === "var(--pin-exec)" &&
          edge.style.strokeWidth === 5,
      ),
    ).toBe(true);
    expect(nodeReads).toBeLessThanOrEqual(3 * nodes.length);
  });

  it("preserves resolved types, authored fallbacks, and edge metadata", () => {
    const nodes: PinDisplayNode[] = [
      {
        id: "source",
        data: {
          __pins: [
            { id: "resolved", type: { kind: "boxedWildcard" } },
            { id: "authored", type: { kind: "bool" } },
          ],
        },
      },
    ];
    const edges: Edge[] = [
      {
        id: "resolved",
        source: "source",
        sourceHandle: "resolved",
        target: "sink",
        selected: true,
        data: { label: "keep" },
      },
      {
        id: "authored",
        source: "source",
        sourceHandle: "authored",
        target: "sink",
      },
      {
        id: "missing-pin",
        source: "source",
        sourceHandle: "missing",
        target: "sink",
      },
      {
        id: "missing-node",
        source: "missing",
        sourceHandle: "authored",
        target: "sink",
      },
      { id: "no-handle", source: "source", target: "sink" },
    ];
    const styled = styleFlowEdges(
      edges,
      nodes,
      new Map([[pinTypeKey("source", "resolved"), { kind: "float" }]]),
    );

    expect(styled.map((edge) => edge.style)).toEqual([
      { stroke: "var(--pin-float)", strokeWidth: 4 },
      { stroke: "var(--pin-bool)", strokeWidth: 4 },
      { stroke: "var(--pin-wildcard)", strokeWidth: 4 },
      { stroke: "var(--pin-wildcard)", strokeWidth: 4 },
      { stroke: "var(--pin-wildcard)", strokeWidth: 4 },
    ]);
    styled.forEach((edge, index) => expect(edge).toMatchObject(edges[index]));
    expect(edges.every((edge) => edge.style === undefined)).toBe(true);
  });
});

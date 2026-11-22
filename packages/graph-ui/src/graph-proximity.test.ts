import { describe, expect, it } from "vitest";
import type { OrientedConnection } from "./graph-connect";
import { findProximityConnections, pinBox, pinBoxWithinReach, type ProximityPin } from "./graph-proximity";

const source: ProximityPin = {
  nodeId: "source",
  pinId: "value",
  direction: "out",
  x: 0,
  y: 0,
};
const target: ProximityPin = {
  nodeId: "target",
  pinId: "input",
  direction: "in",
  x: 30,
  y: 40,
};
const expectedConnection: OrientedConnection = {
  source: "source",
  sourceHandle: "value",
  target: "target",
  targetHandle: "input",
};
const defaults = {
  pins: [source, target],
  edges: [],
  movingNodeIds: new Set(["source"]),
  maxDistance: 50,
  isValidConnection: () => true,
};

describe("findProximityConnections", () => {
  it.each(["source", "target"])(
    "orients the connection when %s moves and includes the exact distance boundary",
    (movingNodeId) => {
      expect(
        findProximityConnections({
          ...defaults,
          movingNodeIds: new Set([movingNodeId]),
        }),
      ).toEqual([expectedConnection]);
      expect(
        findProximityConnections({
          ...defaults,
          movingNodeIds: new Set([movingNodeId]),
          maxDistance: 49.9,
        }),
      ).toEqual([]);
    },
  );

  it("rejects backwards wires and unmeasured handles", () => {
    for (const position of [
      { x: -1, y: 0 },
      { x: Number.NaN, y: 0 },
      { x: 0, y: Number.POSITIVE_INFINITY },
    ]) {
      expect(
        findProximityConnections({
          ...defaults,
          pins: [source, { ...target, ...position }],
        }),
      ).toEqual([]);
    }
  });

  it("ignores a pin with any existing connection at either endpoint", () => {
    const existingEdges = [
      {
        source: "source",
        sourceHandle: "value",
        target: "other",
        targetHandle: "in",
      },
      {
        source: "other",
        sourceHandle: "out",
        target: "target",
        targetHandle: "input",
      },
      // Endpoint occupancy survives legacy input-first edge orientation.
      {
        source: "other",
        sourceHandle: "out",
        target: "source",
        targetHandle: "value",
      },
      {
        source: "target",
        sourceHandle: "input",
        target: "other",
        targetHandle: "in",
      },
    ];
    for (const edge of existingEdges) {
      expect(
        findProximityConnections({ ...defaults, edges: [edge] }),
      ).toEqual([]);
    }
    expect(
      findProximityConnections({
        ...defaults,
        edges: [
          {
            ...expectedConnection,
            sourceHandle: "other",
            targetHandle: "other",
          },
        ],
      }),
    ).toEqual([expectedConnection]);
  });

  it("only connects across the moving selection boundary", () => {
    for (const movingNodeIds of [
      new Set<string>(),
      new Set(["other"]),
      new Set(["source", "target"]),
    ]) {
      expect(
        findProximityConnections({ ...defaults, movingNodeIds }),
      ).toEqual([]);
    }
    expect(
      findProximityConnections({
        ...defaults,
        pins: [source, { ...target, nodeId: "source" }],
      }),
    ).toEqual([]);
  });

  it("reserves each endpoint for its nearest valid match", () => {
    expect(
      findProximityConnections({
        ...defaults,
        pins: [
          source,
          { ...source, pinId: "second", y: 40 },
          { ...target, pinId: "near", x: 10, y: 0 },
          { ...target, pinId: "far", x: 10, y: 40 },
          { ...target, pinId: "incompatible", x: 1, y: 0 },
        ],
        isValidConnection: (connection) =>
          connection.targetHandle !== "incompatible",
      }),
    ).toEqual([
      { ...expectedConnection, sourceHandle: "second", targetHandle: "far" },
      { ...expectedConnection, targetHandle: "near" },
    ]);
  });

  it("breaks equal-distance ties consistently regardless of pin order", () => {
    const pins = [
      source,
      { ...source, nodeId: "second-source" },
      target,
      { ...target, nodeId: "second-target" },
    ];
    const options = {
      ...defaults,
      movingNodeIds: new Set(["source", "second-source"]),
    };
    const expected = [
      {
        source: "second-source",
        sourceHandle: "value",
        target: "second-target",
        targetHandle: "input",
      },
      expectedConnection,
    ];
    expect(findProximityConnections({ ...options, pins })).toEqual(expected);
    expect(
      findProximityConnections({ ...options, pins: [...pins].reverse() }),
    ).toEqual(expected);
  });

  it("uses the resolved handles for matching and compatibility", () => {
    expect(
      findProximityConnections({
        ...defaults,
        pins: [source, target, { ...target, pinId: "resolved", y: 0 }],
        resolveConnection: (connection) => ({
          ...connection,
          targetHandle: "resolved",
        }),
        isValidConnection: (connection) => connection.targetHandle === "resolved",
      }),
    ).toEqual([{ ...expectedConnection, targetHandle: "resolved" }]);
  });

  it("rechecks resolved pin availability, direction, selection, and distance", () => {
    const pins = [
      source,
      target,
      { ...target, pinId: "occupied" },
      { ...target, pinId: "far", x: 100 },
      { ...target, pinId: "backwards", x: -10 },
      { ...target, pinId: "wrong-direction", direction: "out" as const },
      { ...target, nodeId: "also-moving" },
    ];
    const edges = [
      { ...expectedConnection, targetHandle: "occupied", source: "other" },
    ];
    const resolutions: Array<OrientedConnection | null> = [
      null,
      { ...expectedConnection, targetHandle: "occupied" },
      { ...expectedConnection, targetHandle: "missing" },
      { ...expectedConnection, targetHandle: "far" },
      { ...expectedConnection, targetHandle: "backwards" },
      { ...expectedConnection, targetHandle: "wrong-direction" },
      { ...expectedConnection, target: "also-moving" },
      { ...expectedConnection, target: "source", targetHandle: "value" },
    ];
    for (const resolution of resolutions) {
      expect(
        findProximityConnections({
          ...defaults,
          pins,
          edges,
          movingNodeIds: new Set(["source", "also-moving"]),
          resolveConnection: () => resolution,
        }),
      ).toEqual([]);
    }
    expect(
      findProximityConnections({
        ...defaults,
        resolveConnection: (connection) => connection,
        isValidConnection: () => false,
      }),
    ).toEqual([]);
  });
});

describe("pinBoxWithinReach", () => {
  it("leaves out only nodes whose pins could join no suggestion", () => {
    let seed = 11;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let trial = 0; trial < 40; trial++) {
      // Nodes of a few pins each; the first two move. Pins sit on both sides of each node.
      const nodes = Array.from({ length: 30 }, (_, index) => {
        const x = random() * 2000;
        const y = random() * 1200;
        return Array.from({ length: 4 }, (_, pin): ProximityPin => ({
          nodeId: `n${index}`,
          pinId: `p${pin}`,
          direction: pin % 2 === 0 ? "in" : "out",
          x: x + (pin % 2 === 0 ? 0 : 240),
          y: y + 40 * pin,
        }));
      });
      const movingNodeIds = new Set(["n0", "n1"]);
      const maxDistance = 20 + random() * 300;
      const options = { edges: [], movingNodeIds, maxDistance, isValidConnection: () => true };
      const moving = nodes.slice(0, 2).flat();
      const reach = pinBox(moving)!;
      const kept = nodes.slice(2).filter((pins) => pinBoxWithinReach(pinBox(pins), reach, maxDistance));
      expect(findProximityConnections({ ...options, pins: [...moving, ...kept.flat()] }))
        .toEqual(findProximityConnections({ ...options, pins: nodes.flat() }));
    }
  });

  it("keeps a pin exactly at the reach and leaves out one just past it", () => {
    const reach = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    expect(pinBoxWithinReach({ minX: 60, minY: 0, maxX: 70, maxY: 0 }, reach, 50)).toBe(true);
    expect(pinBoxWithinReach({ minX: 60.5, minY: 0, maxX: 70, maxY: 0 }, reach, 50)).toBe(false);
    expect(pinBoxWithinReach({ minX: 0, minY: -40.5, maxX: 0, maxY: -40.5 }, reach, 40)).toBe(false);
    expect(pinBoxWithinReach(null, reach, 40)).toBe(false);
  });
});

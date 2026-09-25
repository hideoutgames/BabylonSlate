import { describe, expect, it } from "vitest";
import {
  normalizeParticleGraphDocument,
  type ParticleGraphDocument,
  type ParticleGraphSettings,
} from "./document";
import {
  validateParticleGraphDocument,
  type ParticleGraphDiagnostic,
  type ParticleGraphValidationContext,
} from "./validate";

type NodeSpec = [id: string, type: string, properties?: Record<string, unknown>];
type EdgeSpec = [source: string, sourcePin: string, target: string, targetPin: string];

/** Create → Point Shape → Apply Velocity → Emitter Output, with a Material: no diagnostics. */
const SPINE_NODES: NodeSpec[] = [
  ["create", "particle.create"],
  ["shape", "shape.point"],
  ["move", "update.basicPosition"],
  ["output", "particle.output"],
];
const SPINE_EDGES: EdgeSpec[] = [
  ["create", "out", "shape", "particle"],
  ["shape", "out", "move", "particle"],
  ["move", "out", "output", "particle"],
];

function build(
  nodes: NodeSpec[],
  edges: EdgeSpec[],
  options: { settings?: Partial<ParticleGraphSettings>; materialGuid?: string | null } = {},
): ParticleGraphDocument {
  return normalizeParticleGraphDocument({
    materialGuid: options.materialGuid === undefined ? "mat" : options.materialGuid,
    settings: options.settings ?? {},
    nodes: nodes.map(([id, type, properties]) => ({ id, type, position: { x: 0, y: 0 }, properties: properties ?? {} })),
    edges: edges.map(([sourceNodeId, sourcePinId, targetNodeId, targetPinId], index) => ({
      id: `e${index}`,
      sourceNodeId,
      sourcePinId,
      targetNodeId,
      targetPinId,
    })),
  });
}

function withSpine(nodes: NodeSpec[] = [], edges: EdgeSpec[] = []): ParticleGraphDocument {
  return build([...SPINE_NODES, ...nodes], [...SPINE_EDGES, ...edges]);
}

function diagnostics(
  doc: ParticleGraphDocument,
  context?: ParticleGraphValidationContext,
): ParticleGraphDiagnostic[] {
  return validateParticleGraphDocument(doc, context);
}

function codes(doc: ParticleGraphDocument, context?: ParticleGraphValidationContext): string[] {
  return diagnostics(doc, context).map((entry) => entry.code);
}

describe("particle graph validation", () => {
  it("accepts a complete spine with a Material", () => {
    expect(diagnostics(withSpine())).toEqual([]);
  });

  it("anchors a missing Particle or update value at its pin", () => {
    const doc = build(
      [["create", "particle.create"], ["update", "update.position"], ["output", "particle.output", { "default:particle": [1] }]],
      [["create", "out", "update", "particle"]],
    );
    expect(diagnostics(doc)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "particle.missingInput", nodeId: "output", pinId: "particle", severity: "error" }),
        expect.objectContaining({ code: "particle.missingInput", nodeId: "update", pinId: "position", severity: "error" }),
      ]),
    );
    const authored = build(
      [["create", "particle.create"], ["update", "update.position", { "default:position": [0, 1, 0] }], ["output", "particle.output"]],
      [["create", "out", "update", "particle"], ["update", "out", "output", "particle"]],
    );
    expect(codes(authored)).not.toContain("particle.missingInput");
  });

  it("rejects a second wire out of a Particle output", () => {
    const doc = withSpine([["stray", "update.size", { "default:size": [1] }]], [["create", "out", "stray", "particle"]]);
    expect(diagnostics(doc)).toContainEqual(
      expect.objectContaining({ code: "particle.spineFanOut", edgeId: "e3", nodeId: "create", pinId: "out", severity: "error" }),
    );
  });

  it("allows one Emitter Output and no loops", () => {
    expect(diagnostics(withSpine([["second", "particle.output"]]))).toContainEqual(
      expect.objectContaining({ code: "particle.multipleOutputs", nodeId: "second" }),
    );
    const loop = withSpine(
      [["a", "math.add"], ["b", "math.add"]],
      [["a", "out", "b", "a"], ["b", "out", "a", "a"]],
    );
    expect(codes(loop)).toContain("particle.cycle");
  });

  it("enforces value types, splats and Babylon's Color4 exclusions", () => {
    const doc = withSpine(
      [
        ["v2", "const.vec2"],
        ["v3", "const.vec3"],
        ["tint", "const.color"],
        ["one", "const.float"],
        ["mixed", "math.add"],
        ["clamp", "math.clamp"],
        ["divide", "math.divide"],
        ["color", "update.color"],
        ["scale", "update.scale"],
        ["size", "update.size"],
      ],
      [
        ["v2", "out", "mixed", "a"],
        ["v3", "out", "mixed", "b"],
        ["tint", "out", "clamp", "value"],
        ["tint", "out", "divide", "a"],
        ["v3", "out", "color", "color"],
        ["one", "out", "scale", "scale"],
        ["create", "out", "size", "size"],
      ],
    );
    const found = diagnostics(doc);
    expect(found).toContainEqual(expect.objectContaining({ code: "particle.genericConflict", nodeId: "mixed" }));
    for (const [nodeId, pinId] of [
      ["clamp", "value"],
      ["divide", "a"],
      ["color", "color"],
      ["size", "size"],
    ]) {
      expect(found).toContainEqual(expect.objectContaining({ code: "particle.typeMismatch", nodeId, pinId }));
    }
    expect(found.filter((entry) => entry.nodeId === "scale" && entry.code === "particle.typeMismatch")).toEqual([]);
  });

  it("warns above the CPU budget of 512 particles", () => {
    const at = build(SPINE_NODES, SPINE_EDGES, { settings: { capacity: 512 } });
    const above = build(SPINE_NODES, SPINE_EDGES, { settings: { capacity: 513 } });
    expect(codes(at)).not.toContain("particle.cpuBudget");
    expect(diagnostics(above)).toContainEqual(
      expect.objectContaining({ code: "particle.cpuBudget", severity: "warning" }),
    );
  });

  it("rejects Emit Rate sources that need a particle or a running system", () => {
    const emitRate = (nodes: NodeSpec[], edges: EdgeSpec[]) =>
      diagnostics(withSpine(nodes, edges)).filter((entry) => entry.code === "particle.perParticleInEmitRate");
    const anchored = expect.objectContaining({ nodeId: "output", pinId: "emitRate", severity: "error" });
    expect(
      emitRate(
        [["age", "input.contextual.age"], ["times", "math.multiply"]],
        [["age", "out", "times", "a"], ["times", "out", "output", "emitRate"]],
      ),
    ).toEqual([anchored]);
    expect(emitRate([["roll", "random.range", { lock: "perParticle" }]], [["roll", "out", "output", "emitRate"]])).toEqual([anchored]);
    expect(
      emitRate(
        [["emitter", "input.system.emitterPosition"], ["length", "vector.length"]],
        [["emitter", "out", "length", "value"], ["length", "out", "output", "emitRate"]],
      ),
    ).toEqual([anchored]);
    expect(emitRate([["time", "input.system.time"]], [["time", "out", "output", "emitRate"]])).toEqual([]);
    expect(emitRate([["roll", "random.range", { lock: "everyRead" }]], [["roll", "out", "output", "emitRate"]])).toEqual([]);
  });

  it("names reserved v1 features instead of calling them unknown", () => {
    const found = diagnostics(withSpine([["noise", "update.noise"], ["other", "vendor.thing"]]));
    expect(found).toContainEqual(
      expect.objectContaining({ code: "particle.unsupportedNode", nodeId: "noise", message: expect.stringContaining("Noise") }),
    );
    expect(found).toContainEqual(expect.objectContaining({ code: "particle.unknownNode", nodeId: "other" }));
  });

  it("warns when an Attractor runs first and reads particle attributes", () => {
    const attractorFirst = (source: string) =>
      build(
        [
          ["create", "particle.create"],
          ["shape", "shape.point"],
          ["attract", "force.attractor"],
          ["move", "update.basicPosition"],
          ["output", "particle.output"],
          ["source", source],
        ],
        [
          ["create", "out", "shape", "particle"],
          ["shape", "out", "attract", "particle"],
          ["attract", "out", "move", "particle"],
          ["move", "out", "output", "particle"],
          ["source", "out", "attract", "position"],
        ],
      );
    expect(diagnostics(attractorFirst("input.contextual.position"))).toContainEqual(
      expect.objectContaining({ code: "particle.attractorParticleInput", nodeId: "attract", pinId: "position", severity: "warning" }),
    );
    expect(codes(attractorFirst("input.system.emitterPosition"))).not.toContain("particle.attractorParticleInput");
    const afterUpdate = withSpine(
      [["attract", "force.attractor"], ["position", "input.contextual.position"]],
      [["position", "out", "attract", "position"]],
    );
    afterUpdate.edges = afterUpdate.edges
      .filter((edge) => !(edge.sourceNodeId === "move" && edge.targetNodeId === "output"))
      .concat(
        { id: "m-a", sourceNodeId: "move", sourcePinId: "out", targetNodeId: "attract", targetPinId: "particle" },
        { id: "a-o", sourceNodeId: "attract", sourcePinId: "out", targetNodeId: "output", targetPinId: "particle" },
      );
    expect(codes(afterUpdate)).not.toContain("particle.attractorParticleInput");
  });

  it("warns when a radial Shape has only one of its two directions", () => {
    const sphere = (properties: Record<string, unknown>, edges: EdgeSpec[] = []) =>
      build(
        [
          ["create", "particle.create"],
          ["shape", "shape.sphere", properties],
          ["move", "update.basicPosition"],
          ["output", "particle.output"],
          ["up", "const.vec3"],
        ],
        [...SPINE_EDGES, ...edges],
      );
    expect(diagnostics(sphere({}, [["up", "out", "shape", "direction1"]]))).toContainEqual(
      expect.objectContaining({ code: "particle.shapeDirectionPair", nodeId: "shape", pinId: "direction2" }),
    );
    expect(codes(sphere({ "default:direction1": [0, 1, 0], "default:direction2": [0, 2, 0] }))).not.toContain(
      "particle.shapeDirectionPair",
    );
    expect(codes(sphere({}))).not.toContain("particle.shapeDirectionPair");
  });

  it("lints the spine: overridden shapes, no motion and detached spine nodes", () => {
    const twoShapes = build(
      [
        ["create", "particle.create"],
        ["first", "shape.box"],
        ["second", "shape.point"],
        ["move", "update.basicPosition"],
        ["output", "particle.output"],
      ],
      [
        ["create", "out", "first", "particle"],
        ["first", "out", "second", "particle"],
        ["second", "out", "move", "particle"],
        ["move", "out", "output", "particle"],
      ],
    );
    expect(diagnostics(twoShapes).filter((entry) => entry.code === "particle.multipleShapes")).toEqual([
      expect.objectContaining({ nodeId: "first", severity: "warning" }),
    ]);

    const still = build(
      [["create", "particle.create"], ["output", "particle.output"]],
      [["create", "out", "output", "particle"]],
    );
    expect(diagnostics(still)).toContainEqual(
      expect.objectContaining({ code: "particle.noMotion", nodeId: "output", severity: "warning" }),
    );

    const detached = withSpine([["loose", "update.basicColor"], ["unused", "const.float"]]);
    const unreachable = diagnostics(detached).filter((entry) => entry.code === "particle.unreachable");
    expect(unreachable).toEqual([expect.objectContaining({ nodeId: "loose", severity: "warning" })]);
  });

  it("checks the Material slot against the project", () => {
    const doc = withSpine();
    expect(codes(doc, { materialDomain: () => "surface" })).toEqual(["particle.materialDomain"]);
    expect(codes(doc, { materialDomain: () => null })).toEqual(["particle.missingMaterial"]);
    expect(codes(doc, { materialDomain: () => "particle" })).toEqual([]);
    expect(codes(build(SPINE_NODES, SPINE_EDGES, { materialGuid: null }))).toEqual(["particle.missingMaterial"]);
  });
});

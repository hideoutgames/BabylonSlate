import { describe, expect, it } from "vitest";
import {
  createDefaultParticleGraphDocument,
  newParticleNodeProperties,
  normalizeParticleGraphDocument,
  particleGraphDependencies,
  setParticleNodeAngleUnit,
  setParticleNodeValueType,
  type ParticleGraphNode,
} from "./document";
import { lowerParticleGraphDocument } from "./lower";
import { validateParticleGraphDocument } from "./validate";

describe("particle graph document", () => {
  it("injects exactly one Emitter Output into a graph that lacks it", () => {
    const empty = normalizeParticleGraphDocument(null);
    expect(empty.nodes).toEqual([
      { id: "output", type: "particle.output", position: { x: 0, y: 0 }, properties: {} },
    ]);
    const taken = normalizeParticleGraphDocument({
      nodes: [{ id: "output", type: "const.float", position: { x: 100, y: 0 } }],
    });
    expect(taken.nodes.filter((node) => node.type === "particle.output")).toEqual([
      { id: "output-2", type: "particle.output", position: { x: 500, y: 0 }, properties: {} },
    ]);
    const kept = normalizeParticleGraphDocument(createDefaultParticleGraphDocument());
    expect(kept.nodes.filter((node) => node.type === "particle.output")).toHaveLength(1);
  });

  it("clamps settings to their ranges and falls back on unknown modes", () => {
    const doc = normalizeParticleGraphDocument({
      materialGuid: "  ",
      settings: { capacity: 5, loop: "sometimes", duration: 0, prewarm: 99, blendMode: "screen", billboard: 7 },
    });
    expect(doc.materialGuid).toBeNull();
    expect(doc.settings).toEqual({
      capacity: 16,
      loop: "infinite",
      duration: 0.05,
      prewarm: 10,
      blendMode: "additive",
      billboard: "all",
    });
    expect(normalizeParticleGraphDocument({ settings: { capacity: 9000 } }).settings.capacity).toBe(4096);
    expect(normalizeParticleGraphDocument({ settings: { capacity: 300.4, loop: "once" } }).settings).toMatchObject({
      capacity: 300,
      loop: "once",
    });
  });

  it("keeps unknown node types so validation can report them", () => {
    const doc = normalizeParticleGraphDocument({
      nodes: [{ id: "mystery", type: "future.node", position: { x: 0, y: 0 } }, { id: "untyped" }],
    });
    expect(doc.nodes.map((node) => node.id)).toEqual(["mystery", "output"]);
    expect(validateParticleGraphDocument(doc)).toContainEqual(
      expect.objectContaining({ code: "particle.unknownNode", nodeId: "mystery", severity: "error" }),
    );
  });

  it("sorts, clamps, caps and resizes Gradient stops, and restores defaults below two stops", () => {
    const stops = Array.from({ length: 10 }, (_, index) => ({
      position: index === 0 ? 2 : (10 - index) / 10,
      value: [index],
    }));
    const [gradient] = normalizeParticleGraphDocument({
      nodes: [{ id: "g", type: "gradient.sample", properties: { valueType: "vec2", stops } }],
    }).nodes;
    const normalized = gradient!.properties.stops as { position: number; value: number[] }[];
    expect(normalized).toHaveLength(8);
    expect(normalized.map((stop) => stop.position)).toEqual([...normalized.map((stop) => stop.position)].sort((a, b) => a - b));
    expect(normalized.every((stop) => stop.position >= 0 && stop.position <= 1 && stop.value.length === 2)).toBe(true);
    expect(normalized[0]).toEqual({ position: 0.1, value: [9, 9] });

    const [single] = normalizeParticleGraphDocument({
      nodes: [{ id: "g", type: "gradient.sample", properties: { stops: [{ position: 0.5, value: [1, 0, 0, 1] }] } }],
    }).nodes;
    expect(single!.properties).toMatchObject({
      valueType: "color",
      stops: [
        { position: 0, value: [1, 1, 1, 1] },
        { position: 1, value: [0, 0, 0, 0] },
      ],
    });
  });

  it("starts as a valid, moving graph that only asks for a Material", () => {
    const doc = createDefaultParticleGraphDocument();
    expect(validateParticleGraphDocument(doc)).toEqual([
      expect.objectContaining({ code: "particle.missingMaterial", severity: "warning" }),
    ]);
    expect(lowerParticleGraphDocument(doc).ok).toBe(true);
  });

  it("lists the Material as the only dependency", () => {
    const doc = createDefaultParticleGraphDocument();
    expect(particleGraphDependencies(doc)).toEqual({ materials: [], all: [] });
    expect(particleGraphDependencies({ ...doc, materialGuid: "mat-1" })).toEqual({
      materials: ["mat-1"],
      all: ["mat-1"],
    });
  });

  it("resizes Gradient stops and Random bounds when the value type changes", () => {
    const gradient: ParticleGraphNode = {
      id: "g",
      type: "gradient.sample",
      position: { x: 0, y: 0 },
      properties: {
        valueType: "color",
        stops: [
          { position: 0, value: [1, 0.5, 0.25, 1] },
          { position: 1, value: [0, 0, 0, 0] },
        ],
      },
    };
    expect(setParticleNodeValueType(gradient, "float").properties).toMatchObject({
      valueType: "float",
      stops: [
        { position: 0, value: [1] },
        { position: 1, value: [0] },
      ],
    });
    const random: ParticleGraphNode = {
      id: "r",
      type: "random.range",
      position: { x: 0, y: 0 },
      properties: { valueType: "float", lock: "perParticle", "default:max": [2] },
    };
    expect(setParticleNodeValueType(random, "vec3").properties).toMatchObject({
      valueType: "vec3",
      "default:max": [2, 2, 2],
    });
  });

  it("fills Angle Unit with Radians on Create Particle and Cone Shape, so older graphs load unchanged", () => {
    const doc = normalizeParticleGraphDocument({
      nodes: [
        { id: "create", type: "particle.create", properties: { "default:angle": [0.5] } },
        { id: "cone", type: "shape.cone", properties: { angleUnit: "turns" } },
        { id: "degrees", type: "shape.cone", properties: { angleUnit: "degrees", "default:angle": [45] } },
        { id: "sphere", type: "shape.sphere", properties: {} },
      ],
    });
    const properties = (id: string) => doc.nodes.find((entry) => entry.id === id)!.properties;
    expect(properties("create")).toEqual({ "default:angle": [0.5], angleUnit: "radians" });
    expect(properties("cone").angleUnit).toBe("radians");
    expect(properties("degrees")).toEqual({ angleUnit: "degrees", "default:angle": [45], emitFromSpawnPointOnly: false });
    expect(properties("sphere").angleUnit).toBeUndefined();
    // A saved graph reads back the same.
    expect(normalizeParticleGraphDocument(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
  });

  it("converts the authored angle when Angle Unit changes and leaves an unauthored angle on the catalog default", () => {
    const cone: ParticleGraphNode = { id: "cone", type: "shape.cone", position: { x: 0, y: 0 },
      properties: { angleUnit: "radians", "default:angle": [Math.PI / 4] } };
    const degrees = setParticleNodeAngleUnit(cone, "degrees");
    expect(degrees.properties).toEqual({ angleUnit: "degrees", "default:angle": [45] });
    expect((setParticleNodeAngleUnit(degrees, "radians").properties["default:angle"] as number[])[0]).toBeCloseTo(Math.PI / 4, 10);
    expect(setParticleNodeAngleUnit(degrees, "degrees")).toBe(degrees);
    const create: ParticleGraphNode = { id: "create", type: "particle.create", position: { x: 0, y: 0 }, properties: { angleUnit: "radians" } };
    expect(setParticleNodeAngleUnit(create, "degrees").properties).toEqual({ angleUnit: "degrees" });
    const sphere: ParticleGraphNode = { id: "sphere", type: "shape.sphere", position: { x: 0, y: 0 }, properties: {} };
    expect(setParticleNodeAngleUnit(sphere, "degrees")).toBe(sphere);
  });

  it("gives Local Variable the Particle scope unless it is Loop", () => {
    const doc = normalizeParticleGraphDocument({
      nodes: [
        { id: "a", type: "utility.localVariable", properties: { scope: "loop" } },
        { id: "b", type: "utility.localVariable", properties: { scope: "galaxy" } },
      ],
    });
    expect(doc.nodes.filter((entry) => entry.type === "utility.localVariable").map((entry) => entry.properties.scope)).toEqual(["loop", "particle"]);
    expect(newParticleNodeProperties("utility.localVariable")).toEqual({ scope: "particle" });
  });
});

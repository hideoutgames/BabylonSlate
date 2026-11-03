import { describe, expect, it } from "vitest";
import {
  createDefaultParticleGraphDocument,
  newParticleNodeProperties,
  normalizeParticleGraphDocument,
  particleGraphDependencies,
  particleSpriteSheetSettings,
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

  it("lists the Material, Noise Textures, Mesh Shape Models, Spawn Emitter emitters and Global Parameter Collections as dependencies", () => {
    const doc = createDefaultParticleGraphDocument();
    expect(particleGraphDependencies(doc)).toEqual({ materials: [], textures: [], models: [], emitters: [], globalParameterCollections: [], all: [] });
    const noise = (id: string, textureGuid: unknown): ParticleGraphNode =>
      ({ id, type: "update.noise", position: { x: 0, y: 0 }, properties: { textureGuid } });
    const mesh = (id: string, source: string, modelGuid: unknown): ParticleGraphNode =>
      ({ id, type: "shape.mesh", position: { x: 0, y: 0 }, properties: { source, modelGuid } });
    expect(particleGraphDependencies({ ...doc, materialGuid: "mat-1",
      nodes: [
        ...doc.nodes,
        noise("a", "tex-2"), noise("b", "tex-1"), noise("c", "tex-2"), noise("d", null),
        mesh("m1", "model", "model-1"), mesh("m2", "ownerMesh", "model-2"), mesh("m3", "model", "model-1"),
        { id: "s1", type: "trigger.spawn", position: { x: 0, y: 0 }, properties: { emitterGuid: "spark" } },
        { id: "s2", type: "trigger.spawn", position: { x: 0, y: 0 }, properties: { emitterGuid: null } },
        { id: "g1", type: "global.parameter", position: { x: 0, y: 0 }, properties: { collectionGuid: "globals", parameterId: "p", valueType: "float" } },
        { id: "g2", type: "global.parameter", position: { x: 0, y: 0 }, properties: { collectionGuid: "globals" } },
      ] })).toEqual({
      materials: ["mat-1"],
      textures: ["tex-1", "tex-2"],
      models: ["model-1"],
      emitters: ["spark"],
      globalParameterCollections: ["globals"],
      all: ["mat-1", "tex-1", "tex-2", "model-1", "spark", "globals"],
    });
    const normalized = normalizeParticleGraphDocument({ nodes: [
      { id: "n", type: "update.noise", properties: { textureGuid: "  " } },
      { id: "m", type: "shape.mesh", properties: { source: "bogus", modelGuid: 4, useMeshColor: "yes" } },
    ] });
    expect(normalized.nodes.find((entry) => entry.id === "n")!.properties.textureGuid).toBeNull();
    expect(normalized.nodes.find((entry) => entry.id === "m")!.properties).toMatchObject({
      source: "ownerMesh", modelGuid: null, useMeshNormals: true, useMeshColor: false,
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

  it("keeps a Sprite Sheet's grid whole and its cells within it", () => {
    expect(newParticleNodeProperties("sprite.setup")).toEqual({
      columns: 4, rows: 4, startCell: 0, endCell: 15, framesPerSecond: 30, loop: true, randomStartCell: false,
    });
    const settings = (properties: Record<string, unknown>) => particleSpriteSheetSettings(properties);
    expect(settings({ columns: 3.6, rows: 0, startCell: 9, endCell: 2, framesPerSecond: -5, loop: 0, randomStartCell: "yes" })).toEqual({
      columns: 4, rows: 1, startCell: 3, endCell: 3, framesPerSecond: 0, loop: true, randomStartCell: false,
    });
    expect(settings({ columns: 500, rows: 2, endCell: Number.NaN, framesPerSecond: 1000, loop: false, randomStartCell: true })).toEqual({
      columns: 64, rows: 2, startCell: 0, endCell: 127, framesPerSecond: 240, loop: false, randomStartCell: true,
    });
    const doc = normalizeParticleGraphDocument({ nodes: [{ id: "sheet", type: "sprite.setup", properties: { columns: 2, rows: 2, endCell: 40 } }] });
    expect(doc.nodes.find((entry) => entry.id === "sheet")!.properties).toMatchObject({ columns: 2, rows: 2, startCell: 0, endCell: 3 });
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

  it("keeps parameters with an id and a unique trimmed name, sized to their type, and types Parameter nodes by them", () => {
    const doc = normalizeParticleGraphDocument({
      parameters: [
        { id: "p1", name: "  Intensity ", type: "float", defaultValue: [2, 9] },
        { id: "p2", name: "Tint", type: "color", defaultValue: [1, 0, 0] },
        { id: "p1", name: "Again", type: "float" },
        { id: "p3", name: "Intensity", type: "vec3" },
        { id: "", name: "Nameless id", type: "float" },
        { id: "p4", name: "x".repeat(65), type: "float" },
        { id: "p5", name: "Speed", type: "quaternion", defaultValue: ["fast"] },
      ],
      nodes: [
        { id: "tint", type: "input.parameter", properties: { parameterId: "p2", valueType: "float" } },
        { id: "lost", type: "input.parameter", properties: { parameterId: "gone", valueType: "vec2" } },
      ],
    });
    expect(doc.parameters).toEqual([
      { id: "p1", name: "Intensity", type: "float", defaultValue: [2] },
      { id: "p2", name: "Tint", type: "color", defaultValue: [1, 0, 0, 1] },
      { id: "p5", name: "Speed", type: "float", defaultValue: [0] },
    ]);
    const properties = (id: string) => doc.nodes.find((entry) => entry.id === id)!.properties;
    expect(properties("tint").valueType).toBe("color");
    expect(properties("lost").valueType).toBe("vec2");
    expect(normalizeParticleGraphDocument({}).parameters).toEqual([]);
    expect(normalizeParticleGraphDocument(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
  });
});

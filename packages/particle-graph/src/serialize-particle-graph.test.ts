import { describe, expect, it } from "vitest";
import { particleNodeDefinition } from "./catalog";
import { createDefaultParticleGraphDocument, newParticleNodeProperties } from "./document";
import {
  hydrateParticleGraphForEditor,
  particleConnectionIsAllowed,
  particleGraphToSerialized,
  particlePaletteNodes,
  particlePinsAreCompatible,
  serializedToParticleGraph,
  type ParticleGraphPin,
} from "./serialize-particle-graph";

const pin = (kind: string, accepts?: readonly string[]) => ({ type: { kind, ...(accepts ? { accepts } : {}) } });

describe("particle graph canvas adapter", () => {
  it("keeps numeric editing bounds on loaded and newly added particle pins", () => {
    const bounds = [
      { type: "particle.create", pinId: "lifetime", min: 0.01, max: undefined },
      { type: "shape.sphere", pinId: "radius", min: 0, max: undefined },
      { type: "math.lerp", pinId: "alpha", min: 0, max: 1 },
    ];
    const loaded = hydrateParticleGraphForEditor({ nodes: bounds.map(({ type }) => ({
      id: type, type, position: { x: 0, y: 0 }, data: {},
    })), edges: [] });
    const palette = particlePaletteNodes();
    for (const { type, pinId, min, max } of bounds) {
      const loadedPins = loaded.nodes.find((node) => node.id === type)!.data.__pins as ParticleGraphPin[];
      const newPins = palette.find((node) => node.id === type)!.pins;
      for (const pins of [loadedPins, newPins]) {
        const input = pins.find((pin) => pin.id === pinId)!;
        expect(input.min, `${type}.${pinId} minimum`).toBe(min);
        expect(input.max, `${type}.${pinId} maximum`).toBe(max);
      }
    }
  });

  it("round-trips through the canvas without saving editor keys, protecting only the Emitter Output", () => {
    const doc = createDefaultParticleGraphDocument();
    doc.materialGuid = "mat-1";
    const hydrated = hydrateParticleGraphForEditor(particleGraphToSerialized(doc));
    expect(serializedToParticleGraph(hydrated, doc)).toEqual(doc);
    expect(hydrated.nodes.filter((node) => node.data.__protected === true).map((node) => node.type)).toEqual([
      "particle.output",
    ]);
    expect(hydrateParticleGraphForEditor(hydrated)).toEqual(hydrated);
  });

  it("stamps the header role and title, with Particle pins in the first row", () => {
    const hydrated = hydrateParticleGraphForEditor(particleGraphToSerialized(createDefaultParticleGraphDocument()));
    const shape = hydrated.nodes.find((node) => node.id === "shape")!;
    expect(shape.data).toMatchObject({ __particleRole: "shape", __nodeType: "shape.sphere", __category: "Shape", title: "Sphere Shape" });
    const pins = shape.data.__pins as ParticleGraphPin[];
    expect(pins.find((entry) => entry.direction === "in")?.type.kind).toBe("particle");
    expect(pins.find((entry) => entry.direction === "out")?.type.kind).toBe("particle");
    expect(hydrated.nodes.find((node) => node.id === "output")!.data.title).toBe("Emitter Output");
  });

  it("shows a generic node's resolved vector type on its pins", () => {
    const doc = createDefaultParticleGraphDocument();
    doc.nodes.push(
      { id: "up", type: "const.vec3", position: { x: 0, y: 0 }, properties: { value: [0, 1, 0] } },
      { id: "add", type: "math.add", position: { x: 0, y: 0 }, properties: {} },
    );
    doc.edges.push({ id: "u", sourceNodeId: "up", sourcePinId: "out", targetNodeId: "add", targetPinId: "a" });
    const add = hydrateParticleGraphForEditor(particleGraphToSerialized(doc)).nodes.find((node) => node.id === "add")!;
    expect(add.data.__pins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "b", type: { kind: "vec3" }, typeLabel: "V3" }),
        expect.objectContaining({ id: "out", type: { kind: "vec3" }, typeLabel: "V3" }),
      ]),
    );
  });

  it("lets an unwired Split take any vector or color on the canvas", () => {
    const sources = ["const.float", "const.vec2", "const.vec3", "const.color"];
    const doc = createDefaultParticleGraphDocument();
    doc.nodes.push(
      { id: "split", type: "vector.split", position: { x: 0, y: 0 }, properties: {} },
      ...sources.map((type) => ({ id: type, type, position: { x: 0, y: 0 }, properties: newParticleNodeProperties(type) })),
    );
    const nodes = hydrateParticleGraphForEditor(particleGraphToSerialized(doc)).nodes;
    const pinOf = (nodeId: string, pinId: string) =>
      (nodes.find((node) => node.id === nodeId)!.data.__pins as ParticleGraphPin[]).find((entry) => entry.id === pinId)!;
    const value = pinOf("split", "value");
    for (const type of sources) expect(particlePinsAreCompatible(pinOf(type, "out"), value), type).toBe(true);
    expect(particlePinsAreCompatible(pinOf("create", "out"), value)).toBe(false);
  });

  it("connects Particle only to Particle and follows the value type rules", () => {
    expect(particlePinsAreCompatible(pin("particle"), pin("particle"))).toBe(true);
    expect(particlePinsAreCompatible(pin("particle"), pin("float"))).toBe(false);
    expect(particlePinsAreCompatible(pin("float"), pin("particle"))).toBe(false);
    expect(particlePinsAreCompatible(pin("float"), pin("color"))).toBe(true);
    expect(particlePinsAreCompatible(pin("vec2"), pin("vec3"))).toBe(false);
    expect(particlePinsAreCompatible(pin("vec3"), pin("color"))).toBe(false);
    expect(particlePinsAreCompatible(pin("color"), pin("generic", ["float", "vec2", "vec3"]))).toBe(false);
    expect(particlePinsAreCompatible(pin("color"), pin("generic"))).toBe(true);
    expect(particlePinsAreCompatible(pin("generic"), pin("vec3"))).toBe(true);
    expect(particlePinsAreCompatible(pin("generic"), pin("particle"))).toBe(false);
  });

  it("lets linked pins rewire at connect time and refuses only loops", () => {
    const graph = particleGraphToSerialized(createDefaultParticleGraphDocument());
    graph.nodes.push(
      { id: "size", type: "update.size", position: { x: 0, y: 0 }, data: {} },
      { id: "a", type: "math.add", position: { x: 0, y: 0 }, data: {} },
      { id: "b", type: "math.add", position: { x: 0, y: 0 }, data: {} },
    );
    graph.edges.push({ id: "ab", source: "a", target: "b", sourceHandle: "out", targetHandle: "a" });
    const connect = (source: string, sourceHandle: string, target: string, targetHandle: string) =>
      particleConnectionIsAllowed(graph, { source, sourceHandle, target, targetHandle });
    // A linked Particle output moves to a free input.
    expect(connect("velocity", "out", "size", "particle")).toBe(true);
    // Skipping Shape replaces create → shape and shape → velocity.
    expect(connect("create", "out", "velocity", "particle")).toBe(true);
    // A linked output onto a linked input further down the spine.
    expect(connect("shape", "out", "updateColor", "particle")).toBe(true);
    // Shape still reaches Velocity once both replaced wires are gone.
    expect(connect("velocity", "out", "shape", "particle")).toBe(false);
    expect(connect("b", "out", "a", "b")).toBe(false);
    expect(connect("a", "out", "b", "b")).toBe(true);
  });

  it("marks a Particle output single-link on hydrated nodes and in Add Node", () => {
    const shape = hydrateParticleGraphForEditor(particleGraphToSerialized(createDefaultParticleGraphDocument())).nodes.find(
      (node) => node.id === "shape",
    )!;
    expect((shape.data.__pins as ParticleGraphPin[]).find((entry) => entry.direction === "out")).toMatchObject({
      id: "out",
      type: { kind: "particle" },
      singleLink: true,
    });
    const fade = particlePaletteNodes().find((entry) => entry.id === "update.basicColor")!;
    expect(fade.pins.find((entry) => entry.direction === "out")).toMatchObject({
      id: "out",
      type: { kind: "particle" },
      singleLink: true,
    });
  });

  it("offers every node but the Emitter Output, with the header role on each chip", () => {
    const palette = particlePaletteNodes();
    expect(palette.some((entry) => entry.id === "particle.output")).toBe(false);
    for (const entry of palette) {
      expect(entry.defaultData.__particleRole, entry.id).toBe(particleNodeDefinition(entry.id)!.role);
      const added = hydrateParticleGraphForEditor({
        nodes: [{ id: "n", type: entry.id, position: { x: 0, y: 0 }, data: { ...entry.defaultData } }],
        edges: [],
      }).nodes[0]!;
      expect(added.data.__particleRole, entry.id).toBe(entry.defaultData.__particleRole);
    }
  });
});

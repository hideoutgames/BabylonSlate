import { describe, expect, it } from "vitest";
import { PARTICLE_PALETTE_CATEGORIES, particleNodeDefinition } from "./catalog";
import { createDefaultParticleGraphDocument } from "./document";
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

  it("keeps the spine linear and acyclic at connect time", () => {
    const graph = particleGraphToSerialized(createDefaultParticleGraphDocument());
    graph.nodes.push(
      { id: "size", type: "update.size", position: { x: 0, y: 0 }, data: {} },
      { id: "a", type: "math.add", position: { x: 0, y: 0 }, data: {} },
      { id: "b", type: "math.add", position: { x: 0, y: 0 }, data: {} },
    );
    graph.edges.push({ id: "ab", source: "a", target: "b", sourceHandle: "out", targetHandle: "a" });
    const connect = (source: string, sourceHandle: string, target: string, targetHandle: string) =>
      particleConnectionIsAllowed(graph, { source, sourceHandle, target, targetHandle });
    expect(connect("create", "out", "size", "particle")).toBe(false);
    expect(connect("updateColor", "out", "size", "particle")).toBe(false);
    expect(connect("b", "out", "a", "b")).toBe(false);
    expect(connect("a", "out", "b", "b")).toBe(true);
    graph.edges = graph.edges.filter((edge) => edge.id !== "e-color-output");
    expect(connect("updateColor", "out", "size", "particle")).toBe(true);
  });

  it("offers every node but the Emitter Output, grouped by category, with the header role on each chip", () => {
    const palette = particlePaletteNodes();
    expect(palette.some((entry) => entry.id === "particle.output")).toBe(false);
    const order = palette.map((entry) => PARTICLE_PALETTE_CATEGORIES.indexOf(entry.category as never));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
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

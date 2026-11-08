import { describe, expect, it } from "vitest";
import { createDefaultParticleGraphDocument } from "@haptic/particle-graph";
import {
  particleLibraryCompileKey,
  particleLibraryFromAssets,
  particleLibraryMaterialGuids,
  particleLibraryMeshModelGuids,
  particleLibraryNoiseTextureGuids,
} from "./particle-library";
import {
  particleAssetDependencies,
} from "./particle-payload";

describe("particle library", () => {
  it("normalizes emitter and system assets and ignores other asset types", () => {
    const library = particleLibraryFromAssets([
      { guid: "em-1", type: "ParticleEmitter", payload: { render: { materialGuid: "mat-1" } } },
      { guid: "sys-1", type: "ParticleSystem", payload: { emitterGuids: ["em-1"], looping: false } },
      { guid: "tex-1", type: "Texture", payload: {} },
    ]);
    expect(library.emitters.get("em-1")).toMatchObject({
      kind: "basic",
      payload: { render: { materialGuid: "mat-1", blendMode: "additive" } },
    });
    expect(library.systems.get("sys-1")).toEqual({
      emitterGuids: ["em-1"],
      parameterDefaults: {},
      space: "world",
      previewSkybox: true,
    });
    expect(library.emitters.has("tex-1")).toBe(false);
  });

  it("lists each emitter Material once, in emitter order", () => {
    const library = particleLibraryFromAssets([
      { guid: "a", type: "ParticleEmitter", payload: { render: { materialGuid: "mat-2" } } },
      { guid: "b", type: "ParticleEmitter", payload: {} },
      { guid: "c", type: "ParticleEmitter", payload: { render: { materialGuid: "mat-1" } } },
      { guid: "d", type: "ParticleEmitter", payload: { render: { materialGuid: "mat-2" } } },
    ]);
    expect(particleLibraryMaterialGuids(library)).toEqual(["mat-2", "mat-1"]);
  });

  it("keys the library by content, not by asset order", () => {
    const a = { guid: "a", type: "ParticleEmitter", payload: {} };
    const b = { guid: "b", type: "ParticleEmitter", payload: { emitter: { capacity: 64 } } };
    const system = { guid: "s", type: "ParticleSystem", payload: { emitterGuids: ["a", "b"] } };
    const key = particleLibraryCompileKey(particleLibraryFromAssets([a, b, system]));
    expect(particleLibraryCompileKey(particleLibraryFromAssets([system, b, a]))).toBe(key);
    expect(
      particleLibraryCompileKey(
        particleLibraryFromAssets([
          { ...a, payload: { render: { blendMode: "multiply" } } },
          b,
          system,
        ]),
      ),
    ).not.toBe(key);
  });
});

describe("particle library graph entries", () => {
  const graph = (edit: (doc: ReturnType<typeof createDefaultParticleGraphDocument>) => void = () => {}) => {
    const doc = createDefaultParticleGraphDocument("Embers");
    doc.materialGuid = "mat-graph";
    edit(doc);
    return { guid: "graph-1", type: "ParticleGraph", payload: doc };
  };
  const keyOf = (asset: ReturnType<typeof graph>) =>
    particleLibraryCompileKey(particleLibraryFromAssets([asset]));

  it("normalizes a Particle Graph next to Basic emitters and collects both Materials", () => {
    const library = particleLibraryFromAssets([
      { guid: "em-1", type: "ParticleEmitter", payload: { render: { materialGuid: "mat-basic" } } },
      { guid: "raw", type: "ParticleGraph", payload: { materialGuid: "mat-graph", nodes: [] } },
    ]);
    const entry = library.emitters.get("raw");
    expect(entry?.kind).toBe("graph");
    expect(entry?.kind === "graph" && entry.document.nodes.map((node) => node.type)).toEqual([
      "particle.output",
    ]);
    expect(particleLibraryMaterialGuids(library)).toEqual(["mat-basic", "mat-graph"]);
  });

  it("keeps the library key when a graph node is dragged or the graph renamed", () => {
    const key = keyOf(graph());
    expect(
      keyOf(
        graph((doc) => {
          doc.nodes[0]!.position = { x: 900, y: -40 };
          doc.name = "Sparks";
        }),
      ),
    ).toBe(key);
  });

  it("changes the library key on a pin default, a setting or a Material swap", () => {
    const key = keyOf(graph());
    expect(
      keyOf(graph((doc) => (doc.nodes[0]!.properties["default:lifetime"] = [3]))),
    ).not.toBe(key);
    expect(keyOf(graph((doc) => (doc.settings.capacity = 128)))).not.toBe(key);
    expect(keyOf(graph((doc) => (doc.materialGuid = "mat-other")))).not.toBe(key);
  });

  it("indexes a Particle Graph's Material and its Noise Textures", () => {
    const payload = graph().payload as unknown as Record<string, unknown>;
    expect(particleAssetDependencies("ParticleGraph", payload)).toEqual(["mat-graph"]);
    const noisy = graph((doc) => doc.nodes.push({ id: "noise", type: "update.noise", position: { x: 0, y: 0 }, properties: { textureGuid: "tex-noise" } }));
    expect(particleAssetDependencies("ParticleGraph", noisy.payload as unknown as Record<string, unknown>)).toEqual(["mat-graph", "tex-noise"]);
    expect(particleLibraryNoiseTextureGuids(particleLibraryFromAssets([noisy]))).toEqual(["tex-noise"]);
  });

  it("depends on the emitters its Spawn Emitters play", () => {
    const spawning = graph((doc) => doc.nodes.push({ id: "spawn", type: "trigger.spawn", position: { x: 0, y: 0 }, properties: { emitterGuid: "em-spark" } }));
    expect(particleAssetDependencies("ParticleGraph", spawning.payload as unknown as Record<string, unknown>)).toEqual(["em-spark", "mat-graph"]);
  });

  it("indexes the Models its Mesh Shapes read", () => {
    const meshy = graph((doc) => {
      const shape = doc.nodes.find((node) => node.id === "shape")!;
      shape.type = "shape.mesh";
      shape.properties = { source: "model", modelGuid: "model-1" };
    });
    expect(particleAssetDependencies("ParticleGraph", meshy.payload as unknown as Record<string, unknown>)).toEqual(["mat-graph", "model-1"]);
    expect(particleLibraryMeshModelGuids(particleLibraryFromAssets([meshy]))).toEqual(["model-1"]);
    const owner = graph((doc) => {
      const shape = doc.nodes.find((node) => node.id === "shape")!;
      shape.type = "shape.mesh";
      shape.properties = { source: "ownerMesh", modelGuid: "model-1" };
    });
    expect(particleLibraryMeshModelGuids(particleLibraryFromAssets([owner]))).toEqual([]);
  });
});

import { afterEach, expect, it } from "vitest";
import { VertexBuffer, Mesh, StandardMaterial } from "@babylonjs/core";
import { createActor, createDefaultScene, parseLandscapeProperties, sculptLandscape } from "@babylonslate/core";
import { createTestEngine } from "./create-null-engine";
import { EditorSceneSync } from "./editor-scene-sync";
const disposers: Array<() => void> = [];
afterEach(() => { while (disposers.length) disposers.pop()!(); });

it("updates chunked geometry and shared-edge normals in place through scene editing", () => {
  const { engine, scene } = createTestEngine(); const sync = new EditorSceneSync(scene);
  disposers.push(() => { sync.dispose(); scene.dispose(); engine.dispose(); });
  const material = new StandardMaterial("displaced", scene);
  material.metadata = { boundsPadding: 2 };
  sync.setMeshAssets({ resolveMaterial: () => material });
  const landscape = parseLandscapeProperties({ width: 64, depth: 64, subdivisions: 64, materialGuid: "terrain-material" });
  const before = { ...createDefaultScene(), actors: [createActor("terrain", "Terrain", { components: [{ id: "land", classId: "LandscapeComponent", properties: { ...landscape } }] })] };
  sync.apply(before);
  const root = sync.meshForComponent("terrain", "land")!;
  const chunks = root.getChildMeshes().filter((mesh): mesh is Mesh => mesh instanceof Mesh);
  expect(chunks).toHaveLength(4);
  expect(chunks.every((chunk) => chunk.getBoundingInfo().boundingBox.maximum.y === 2)).toBe(true);
  const edited = sculptLandscape(landscape, 0, 0, { tool: "raise", radius: 5, strength: 3, falloff: 0.5, height: 0, layer: 0 });
  sync.apply({ ...before, actors: [{ ...before.actors[0]!, components: [{ id: "land", classId: "LandscapeComponent", properties: { ...edited } }] }] });
  expect(sync.meshForComponent("terrain", "land")).toBe(root);
  expect(root.getChildMeshes()).toEqual(chunks);
  const borderSamples = chunks.flatMap((chunk) => {
    const positions = chunk.getVerticesData(VertexBuffer.PositionKind)!;
    const normals = chunk.getVerticesData(VertexBuffer.NormalKind)!;
    for (let i = 0; i < positions.length; i += 3) if (positions[i] === 0 && positions[i + 2] === 0) return [{ height: positions[i + 1], normal: Array.from(normals.slice(i, i + 3)) }];
    return [];
  });
  expect(borderSamples).toHaveLength(4);
  for (const sample of borderSamples) {
    expect(sample.height).toBe(3);
    expect(sample.normal[0]).toBeCloseTo(0);
    expect(sample.normal[1]).toBeCloseTo(1);
    expect(sample.normal[2]).toBeCloseTo(0);
  }
  expect(chunks.every((chunk) => chunk.getBoundingInfo().boundingBox.maximum.y === 5)).toBe(true);
  sync.apply(before);
  expect(chunks.every((chunk) => chunk.getBoundingInfo().boundingBox.maximum.y === 2)).toBe(true);
  expect(chunks[0]!.getVerticesData(VertexBuffer.PositionKind)!.filter((_, i) => i % 3 === 1).every((v) => v === 0)).toBe(true);
  sync.apply({ ...before, actors: [{ ...before.actors[0]!, components: [{ id: "land", classId: "LandscapeComponent", properties: { ...landscape, width: 128 } }] }] });
  expect(chunks[0]!.getVerticesData(VertexBuffer.UVKind)![0]).toBe(-8);
  sync.apply({ ...before, actors: [{ ...before.actors[0]!, locked: true }] });
  expect(chunks.every((chunk) => !chunk.isPickable && chunk.isVisible)).toBe(true);
  sync.apply({ ...before, actors: [{ ...before.actors[0]!, visible: false }] });
  expect(chunks.every((chunk) => !chunk.isVisible)).toBe(true);
  sync.apply({ ...before, actors: [{ ...before.actors[0]!, components: [{ id: "land", classId: "LandscapeComponent", properties: { ...landscape, materialGuid: null } }] }] });
  expect(chunks.every((chunk) => chunk.getBoundingInfo().boundingBox.maximum.y === 0)).toBe(true);
});

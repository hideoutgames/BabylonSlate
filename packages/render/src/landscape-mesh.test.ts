import { afterEach, expect, it } from "vitest";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Ray } from "@babylonjs/core/Culling/ray";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { createActor, createDefaultScene, parseLandscapeProperties, sculptLandscape } from "@haptic/core";
import { createTestEngine } from "./test-support/test-engine";
import { EditorSceneSync } from "./editor-scene-sync";
import { createLandscapeMesh, intersectLandscapeChunk, updateLandscapeMesh } from "./landscape-mesh";
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

it.each([
  { title: "the default Material", pad: 0 },
  { title: "a Material that pads its bounds by 2", pad: 2 },
])("keeps a sculpted chunk's bounds where its landscape stands, with $title", ({ pad }) => {
  const { engine, scene } = createTestEngine();
  disposers.push(() => { scene.dispose(); engine.dispose(); });
  const material = new StandardMaterial("displaced", scene);
  material.metadata = { boundsPadding: 2 };
  const assets = { resolveMaterial: () => material };
  const landscape = parseLandscapeProperties({ width: 64, depth: 64, subdivisions: 64, materialGuid: pad ? "terrain-material" : null });
  const root = createLandscapeMesh(scene, "terrain", landscape, assets);
  root.position.set(100, 10, 50);
  const chunks = root.getChildMeshes().filter((mesh): mesh is Mesh => mesh instanceof Mesh);
  // A frame computes each chunk's world matrix and culls it by its bounds: the quarter of the landscape it covers.
  const frame = () => chunks.map((chunk) => {
    chunk.computeWorldMatrix();
    const box = chunk.getBoundingInfo().boundingBox;
    return [box.minimumWorld.asArray(), box.maximumWorld.asArray()];
  });
  const quarters = (top: number) => [
    [[68 - pad, 10 - pad, 18 - pad], [100 + pad, top + pad, 50 + pad]],
    [[100 - pad, 10 - pad, 18 - pad], [132 + pad, top + pad, 50 + pad]],
    [[68 - pad, 10 - pad, 50 - pad], [100 + pad, top + pad, 82 + pad]],
    [[100 - pad, 10 - pad, 50 - pad], [132 + pad, top + pad, 82 + pad]],
  ];
  expect(frame()).toEqual(quarters(10));

  // Raise the middle of the landscape, where its four chunks meet, by 3. The landscape itself does not move.
  updateLandscapeMesh(root, sculptLandscape(landscape, 0, 0, { tool: "raise", radius: 5, strength: 3, falloff: 0.5, height: 0, layer: 0 }), assets);

  expect(frame()).toEqual(quarters(13));
});

it("finds a trace's hit on a chunk from the cells under it, exactly as the chunk's own intersection does", () => {
  const { engine, scene } = createTestEngine();
  disposers.push(() => { scene.dispose(); engine.dispose(); });
  const subdivisions = 48;
  const side = subdivisions + 1;
  const heights = (shift: number) => Array.from({ length: side * side }, (_, i) =>
    Math.sin((i % side) * 0.7 + shift) * 0.8 + Math.cos(Math.floor(i / side) * 1.3) * 0.5);
  const properties = { width: 24, depth: 30, subdivisions, heights: heights(0), weights: [], materialGuid: null, collisionsEnabled: false };
  const root = createLandscapeMesh(scene, "terrain", properties);
  root.position.set(3, -1, 2);
  root.rotationQuaternion = Quaternion.RotationAxis(new Vector3(0.2, 1, 0.1).normalize(), 0.6);
  root.scaling.set(1.5, 0.8, 1.2);
  const chunks = root.getChildMeshes().filter((mesh): mesh is Mesh => mesh instanceof Mesh);
  expect(chunks.length).toBeGreaterThan(1);
  // Traces down the landscape's own up axis (one cell tests a few faces) and tilted ones, over cells, along grid
  // lines, through vertices and past the edges.
  const up = Vector3.TransformNormal(Vector3.Up(), root.computeWorldMatrix(true)).normalize();
  const rays: Ray[] = [];
  for (let i = 0; i < 160; i++) {
    const onGrid = i % 4 === 0;
    const lx = onGrid ? -12 + (i % 49) * 0.5 : -13 + ((i * 7.31) % 26);
    const lz = onGrid ? -15 + ((i * 3) % 61) * 0.5 : -16 + ((i * 11.17) % 32);
    const top = Vector3.TransformCoordinates(new Vector3(lx, 3, lz), root.getWorldMatrix());
    const long = i % 10 === 1;
    const tilt = long ? new Vector3(1, 0, -1) : new Vector3(0.3, 0, -0.2);
    const direction = i % 5 === 1 ? up.negate().addInPlace(tilt).normalize() : up.negate();
    rays.push(new Ray(top, direction, long ? 40 : 6));
  }
  const compare = () => {
    let cellTested = 0;
    for (const ray of rays) {
      for (const chunk of chunks) {
        const world = chunk.computeWorldMatrix(true);
        const local = Ray.Transform(ray, world.clone().invert());
        const expected = chunk.intersects(local, false, undefined, false, world);
        const actual = intersectLandscapeChunk(chunk, local, world);
        if (!actual) continue;
        cellTested++;
        expect(actual.hit).toBe(expected.hit);
        if (!expected.hit) continue;
        expect(actual.distance).toBe(expected.distance);
        expect(actual.faceId).toBe(expected.faceId);
        expect([actual.bu, actual.bv]).toEqual([expected.bu, expected.bv]);
        expect(actual.pickedPoint!.asArray()).toEqual(expected.pickedPoint!.asArray());
        expect(actual.getNormal(true, true)!.asArray()).toEqual(expected.getNormal(true, true)!.asArray());
      }
    }
    return cellTested;
  };
  // Every short trace tests only its cells; a long tilted one crossing many cells is left to the whole mesh.
  expect(compare()).toBeGreaterThan(rays.length * chunks.length * 0.8);
  expect(rays.some((ray) => chunks.some((chunk) => intersectLandscapeChunk(chunk, Ray.Transform(ray, chunk.computeWorldMatrix(true).clone().invert()), chunk.getWorldMatrix()) === undefined))).toBe(true);
  // Sculpted heights are traced as drawn.
  updateLandscapeMesh(root, { ...properties, heights: heights(1.5) });
  compare();
});

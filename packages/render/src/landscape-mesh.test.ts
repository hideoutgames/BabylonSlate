import { afterEach, expect, it } from "vitest";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Ray } from "@babylonjs/core/Culling/ray";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { createActor, createDefaultScene, LandscapeSculptSession, parseLandscapeProperties, type LandscapeBrush, type LandscapeProperties } from "@haptic/core";
import { createTestEngine } from "./test-support/test-engine";
import { EditorSceneSync } from "./editor-scene-sync";
import { geometryRevision, unwatchGeometry, watchGeometry } from "./geometry-revision";
import { createLandscapeMesh, intersectLandscapeChunk, updateLandscapeMesh } from "./landscape-mesh";
const disposers: Array<() => void> = [];
afterEach(() => { while (disposers.length) disposers.pop()!(); });

const raise: LandscapeBrush = { tool: "raise", radius: 5, strength: 3, falloff: 0.5, height: 0, layer: 0 };

/** The terrain after one dab, from a session over `terrain` (which keeps its own arrays). */
function sculpted(terrain: LandscapeProperties, x: number, z: number, brush: LandscapeBrush): LandscapeProperties {
  const session = new LandscapeSculptSession(terrain);
  session.dab(x, z, brush);
  return session.liveProperties();
}

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
  const edited = sculpted(landscape, 0, 0, raise);
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
  expect(chunks[0]!.getVerticesData(VertexBuffer.PositionKind)!.slice(0, 33 * 33 * 3).filter((_, i) => i % 3 === 1).every((v) => v === 0)).toBe(true);
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
  // A frame computes each chunk's world matrix and culls it by its bounds: the quarter of the landscape it covers, down
  // to the skirts hanging from its edges shared with the other chunks.
  const frame = () => chunks.map((chunk) => {
    chunk.computeWorldMatrix();
    const box = chunk.getBoundingInfo().boundingBox;
    expect(box.minimumWorld.y).toBeLessThan(10 - pad);
    return [[box.minimumWorld.x, box.minimumWorld.z], box.maximumWorld.asArray()];
  });
  const quarters = (top: number) => [
    [[68 - pad, 18 - pad], [100 + pad, top + pad, 50 + pad]],
    [[100 - pad, 18 - pad], [132 + pad, top + pad, 50 + pad]],
    [[68 - pad, 50 - pad], [100 + pad, top + pad, 82 + pad]],
    [[100 - pad, 50 - pad], [132 + pad, top + pad, 82 + pad]],
  ];
  expect(frame()).toEqual(quarters(10));

  // Raise the middle of the landscape, where its four chunks meet, by 3. The landscape itself does not move.
  updateLandscapeMesh(root, sculpted(landscape, 0, 0, raise), assets);

  expect(frame()).toEqual(quarters(13));
});

it("picks every chunk on its full-resolution surface at any drawn LOD, never on a skirt", async () => {
  const { FreeCamera } = await import("@babylonjs/core/Cameras/freeCamera");
  const { updateLandscapeLods } = await import("./landscape-mesh");
  const { engine, scene } = createTestEngine();
  disposers.push(() => { scene.dispose(); engine.dispose(); });
  const subdivisions = 48;
  const side = subdivisions + 1;
  const heights = (shift: number) => Float32Array.from({ length: side * side }, (_, i) =>
    Math.sin((i % side) * 0.7 + shift) * 0.8 + Math.cos(Math.floor(i / side) * 1.3) * 0.5);
  const properties = { width: 24, depth: 30, subdivisions, heights: heights(0), materialGuid: null, collisionsEnabled: false };
  const root = createLandscapeMesh(scene, "terrain", properties);
  root.position.set(3, -1, 2);
  root.rotationQuaternion = Quaternion.RotationAxis(new Vector3(0.2, 1, 0.1).normalize(), 0.6);
  root.scaling.set(1.5, 0.8, 1.2);
  const chunks = root.getChildMeshes().filter((mesh): mesh is Mesh => mesh instanceof Mesh);
  expect(chunks.length).toBe(4);
  // Far away, every chunk draws a coarse LOD with skirts on its inner edges.
  const camera = new FreeCamera("cam", new Vector3(0, 400, 0), scene);
  camera.getViewMatrix();
  updateLandscapeLods(scene, camera);
  expect(chunks.every((chunk) => chunk.subMeshes[0]!.indexStart > 0)).toBe(true);
  /**
   * The nearest hit on the chunk's LOD0 surface triangles (its first `2 * w * d` faces), tested one by one after the
   * bounds test every Babylon mesh intersection starts with.
   */
  const reference = (chunk: Mesh, ray: Ray) => {
    const bounds = chunk.getBoundingInfo();
    if (!ray.intersectsSphere(bounds.boundingSphere, 0) || !ray.intersectsBox(bounds.boundingBox, 0)) return null;
    const [x, z] = chunk.name.split(":").slice(-2).map(Number);
    const cells = (x === 0 ? 32 : 16) * (z === 0 ? 32 : 16);
    const positions = chunk.getVerticesData(VertexBuffer.PositionKind)!;
    const indices = chunk.getIndices()!;
    const vertex = (i: number) => Vector3.FromArray(positions, indices[i]! * 3);
    let best: { distance: number; faceId: number } | null = null;
    for (let face = 0; face < cells * 2; face++) {
      const hit = ray.intersectsTriangle(vertex(face * 3), vertex(face * 3 + 1), vertex(face * 3 + 2));
      if (hit && hit.distance >= 0 && (!best || hit.distance < best.distance)) best = { distance: hit.distance, faceId: face };
    }
    return best;
  };
  // Traces down the landscape's own up axis and tilted ones, over cells, along grid lines, through vertices and past
  // the edges, and long ones crossing many cells.
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
    let hits = 0;
    for (const ray of rays) {
      let nearest = Infinity;
      for (const chunk of chunks) {
        const world = chunk.computeWorldMatrix(true);
        const local = Ray.Transform(ray, world.clone().invert());
        const expected = reference(chunk, local);
        const actual = chunk.intersects(local, false, undefined, false, world);
        expect(actual.hit).toBe(expected !== null);
        if (!expected) continue;
        hits++;
        const point = Vector3.TransformCoordinates(local.origin.add(local.direction.scale(expected.distance)), world);
        expect(Vector3.Distance(actual.pickedPoint!, point)).toBeLessThan(1e-4);
        nearest = Math.min(nearest, Vector3.Distance(ray.origin, point));
        // Away from cell edges, where two faces meet at one point, the face is the same one.
        if (ray.direction.y !== 0 && rays.indexOf(ray) % 4 !== 0) expect(actual.faceId).toBe(expected.faceId);
        expect(actual.getNormal(true, true)!.length()).toBeCloseTo(1, 5);
      }
      // A scene pick meets the same nearest surface.
      const picked = scene.pickWithRay(ray, (mesh) => chunks.includes(mesh as Mesh));
      expect(picked?.hit ?? false).toBe(Number.isFinite(nearest));
      if (picked?.hit) expect(picked.distance).toBeCloseTo(nearest, 4);
    }
    return hits;
  };
  expect(compare()).toBeGreaterThan(rays.length * 0.8);
  // Sculpted heights are traced as drawn.
  updateLandscapeMesh(root, { ...properties, heights: heights(1.5) });
  compare();
  // A trace just under a flat landscape's surface, across the seam of its chunks (local x = 0), crosses the drawn
  // skirts but picks nothing.
  const flat = createLandscapeMesh(scene, "flat", { width: 64, depth: 64, subdivisions: 64 });
  updateLandscapeLods(scene, camera);
  const seam = flat.getChildMeshes().find((chunk) => chunk.name.endsWith(":0:0")) as Mesh;
  const world = seam.computeWorldMatrix(true);
  const under = new Ray(new Vector3(-0.5, -0.2, -10), new Vector3(1, 0, 0), 1);
  const positions = seam.getVerticesData(VertexBuffer.PositionKind)!;
  const indices = seam.getIndices()!;
  const { indexStart, indexCount } = seam.subMeshes[0]!;
  const vertex = (i: number) => Vector3.FromArray(positions, indices[i]! * 3);
  let skirtHits = 0;
  for (let i = indexStart; i < indexStart + indexCount; i += 3) if (under.intersectsTriangle(vertex(i), vertex(i + 1), vertex(i + 2))) skirtHits++;
  expect(skirtHits).toBeGreaterThan(0);
  expect(seam.intersects(under, false, undefined, false, world).hit).toBe(false);
});

it("transitions chunks across LOD0..LOD3 with hysteresis, lodDistanceScale, autoLod, zero geometry/readiness churn, and LOD0-pinned picking", async () => {
  const { FreeCamera } = await import("@babylonjs/core/Cameras/freeCamera");
  const { RENDER_QUALITY_PROFILES } = await import("@haptic/core");
  const { updateSceneRenderingSettings } = await import("./render-settings");
  const { sceneReadinessRevision } = await import("./scene-readiness-signal");
  const { updateLandscapeLods } = await import("./landscape-mesh");

  const { engine, scene } = createTestEngine();
  disposers.push(() => { scene.dispose(); engine.dispose(); });
  const camera = new FreeCamera("cam", new Vector3(0, 5, 0), scene);
  camera.getViewMatrix();
  scene.activeCamera = camera;
  updateSceneRenderingSettings(scene, {
    quality: { ...RENDER_QUALITY_PROFILES.medium, geometry: { ...RENDER_QUALITY_PROFILES.medium.geometry, lodDistanceScale: 1, autoLod: true } },
  });

  // Single 32x32 chunk centered at origin with a sharp 1-cell spike at center (0, 0) = 6m
  // that coarse LOD3 (stride 8) would miss if picking used the active render LOD.
  const heights = new Float32Array(33 * 33);
  heights[16 * 33 + 16] = 6; // stride-8 hits x=16, z=16; put another sharp peak at x=17, z=17 (off stride-8 grid!)
  heights[17 * 33 + 17] = 9;
  const root = createLandscapeMesh(scene, "terrain", { width: 32, depth: 32, subdivisions: 32, heights });
  const chunk = root.getChildMeshes()[0] as Mesh;
  chunk.computeWorldMatrix(true);
  const subMesh = chunk.subMeshes[0]!;
  const initialGeometry = chunk.geometry;
  const initialSubMeshes = chunk.subMeshes;
  const radius = chunk.getBoundingInfo().boundingSphere.radiusWorld;

  // LOD0: 32x32x2 = 2048 tris (6144 indices), starts at 0.
  expect(subMesh.indexStart).toBe(0);
  expect(subMesh.indexCount).toBe(32 * 32 * 6);

  const readinessBefore = sceneReadinessRevision(scene);
  const placeCameraAtDist = (dist: number) => {
    camera.position.set(0, 0, -(dist + radius));
    camera.getViewMatrix();
    updateLandscapeLods(scene, camera);
  };

  // A lone chunk's edges are all the landscape's outer border, which has no skirts.
  // LOD1 (stride 2): 16x16x2 surface = 512 tris (1536 indices)
  placeCameraAtDist(50);
  expect(subMesh.indexStart).toBeGreaterThan(0);
  expect(subMesh.indexCount).toBe(16 * 16 * 6);

  // Hysteresis: stepping slightly inside 45m (to 44m, above 45 * 0.95 = 42.75m) keeps LOD1.
  placeCameraAtDist(44);
  expect(subMesh.indexCount).toBe(16 * 16 * 6);

  // LOD2 (stride 4): 8x8x2 surface = 128 tris (384 indices)
  placeCameraAtDist(130);
  expect(subMesh.indexCount).toBe(8 * 8 * 6);

  // LOD3 (stride 8): 4x4x2 surface = 32 tris (96 indices)
  placeCameraAtDist(280);
  expect(subMesh.indexCount).toBe(4 * 4 * 6);

  // Zero geometry replacement, zero subMesh replacement, and zero readiness invalidation across all LOD transitions.
  expect(chunk.geometry).toBe(initialGeometry);
  expect(chunk.subMeshes).toBe(initialSubMeshes);
  expect(sceneReadinessRevision(scene)).toBe(readinessBefore);

  // A scene pick (brush, foliage, placement) while the chunk draws LOD3 still meets the LOD0 spike at (x=1, z=1), as
  // foot placement's trace does.
  const pickAtLod3 = scene.pickWithRay(new Ray(new Vector3(1, 20, 1), Vector3.Down(), 40));
  expect(pickAtLod3?.pickedMesh).toBe(chunk);
  expect(pickAtLod3!.pickedPoint!.y).toBeCloseTo(9, 4);
  expect(intersectLandscapeChunk(chunk, new Ray(new Vector3(1, 20, 1), Vector3.Down(), 40), chunk.computeWorldMatrix(true))!.pickedPoint!.y).toBeCloseTo(9, 4);

  // Scaling lodDistanceScale to 2 doubles thresholds -> 280m drops from LOD3 back to LOD2.
  updateSceneRenderingSettings(scene, {
    quality: { ...RENDER_QUALITY_PROFILES.medium, geometry: { ...RENDER_QUALITY_PROFILES.medium.geometry, lodDistanceScale: 2, autoLod: true } },
  });
  updateLandscapeLods(scene, camera);
  expect(subMesh.indexCount).toBe(8 * 8 * 6);

  // Disabling autoLod pins the chunk back to LOD0 even at 280m.
  updateSceneRenderingSettings(scene, {
    quality: { ...RENDER_QUALITY_PROFILES.medium, geometry: { ...RENDER_QUALITY_PROFILES.medium.geometry, lodDistanceScale: 1, autoLod: false } },
  });
  updateLandscapeLods(scene, camera);
  expect(subMesh.indexStart).toBe(0);
  expect(subMesh.indexCount).toBe(32 * 32 * 6);
});

it.each([
  { title: "a valley", amplitude: -40 },
  { title: "a ridge", amplitude: 40 },
])("leaves no crack where a LOD0 chunk meets a LOD3 chunk along $title on their seam", async ({ amplitude }) => {
  const { FreeCamera } = await import("@babylonjs/core/Cameras/freeCamera");
  const { RENDER_QUALITY_PROFILES } = await import("@haptic/core");
  const { updateSceneRenderingSettings } = await import("./render-settings");
  const { updateLandscapeLods } = await import("./landscape-mesh");
  const { engine, scene } = createTestEngine();
  disposers.push(() => { scene.dispose(); engine.dispose(); });
  updateSceneRenderingSettings(scene, {
    quality: { ...RENDER_QUALITY_PROFILES.medium, geometry: { ...RENDER_QUALITY_PROFILES.medium.geometry, lodDistanceScale: 0.25, autoLod: true } },
  });
  // 2 x 2 chunks of 32 cells, 10 m each. Rows of the field rise or sag by `amplitude` between every eighth row, so a
  // LOD3 edge (every eighth sample) is a straight line while the LOD0 edge beside it follows the full relief.
  const side = 65;
  const heights = Float32Array.from({ length: side * side }, (_, i) => amplitude * Math.sin(Math.PI * (Math.floor(i / side) % 8) / 8));
  const root = createLandscapeMesh(scene, "terrain", { width: 640, depth: 640, subdivisions: 64, heights });
  const chunks = root.getChildMeshes().filter((mesh): mesh is Mesh => mesh instanceof Mesh);
  const near = chunks.find((chunk) => chunk.name.endsWith(":0:0"))!;
  const far = chunks.find((chunk) => chunk.name.endsWith(":32:0"))!;
  const camera = new FreeCamera("cam", new Vector3(-160, 0, -160), scene);
  camera.getViewMatrix();
  updateLandscapeLods(scene, camera);
  expect(near.subMeshes[0]!.indexStart).toBe(0);
  expect(far.subMeshes[0]!.indexCount).toBeLessThan(32 * 32 * 6 / 16);
  // The drawn triangles of a chunk at its active LOD, as the GPU sees them.
  const drawn = (chunk: Mesh) => {
    const positions = chunk.getVerticesData(VertexBuffer.PositionKind)!;
    const indices = chunk.getIndices()!;
    const { indexStart, indexCount } = chunk.subMeshes[0]!;
    const vertex = (i: number) => new Vector3(positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!);
    const triangles: Vector3[][] = [];
    for (let i = indexStart; i < indexStart + indexCount; i += 3) triangles.push([vertex(indices[i]!), vertex(indices[i + 1]!), vertex(indices[i + 2]!)]);
    return triangles;
  };
  const surfaces = [...drawn(near), ...drawn(far)];
  // Look across the seam (local x = 0) between the two chunks' edges, between the far chunk's samples (rows 0 and 8).
  let probes = 0;
  const holes: string[] = [];
  for (let row = 1; row < 8; row++) {
    const z = row * 10 - 320 + 0.5;
    const trueEdge = amplitude * Math.sin(Math.PI * (row + 0.05) / 8);
    for (let f = 0.1; f < 0.95; f += 0.2) {
      const y = trueEdge * f;
      probes++;
      const ray = new Ray(new Vector3(-1, y, z), new Vector3(1, 0, 0), 2);
      if (!surfaces.some(([a, b, c]) => ray.intersectsTriangle(a!, b!, c!))) holes.push(`z ${z.toFixed(1)} y ${y.toFixed(1)}`);
    }
  }
  expect(probes).toBe(35);
  expect(holes).toEqual([]);
});

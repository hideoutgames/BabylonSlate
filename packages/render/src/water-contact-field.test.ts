import { afterEach, describe, expect, it, vi } from "vitest";
import { ArcRotateCamera, Matrix, Mesh, MeshBuilder, NullEngine, Scene, Vector3, VertexData } from "@babylonjs/core";
import { createDefaultWaterDefinition, normalizeWaterBody } from "@babylonslate/core";
import { createEditorGrid } from "./editor-grid";
import { createWaterMesh, setSceneWaterTime, updateSceneWater } from "./water-mesh";
import { WATER_CONTACT_LAYER_OFFSETS, WaterContactField } from "./water-contact-field";
import type { WaterFieldSurface } from "./water-field";

type ContactView = { data: Uint8Array | null; width: number; height: number; bounds: number[]; range: number; amplitude: number; texture: unknown };
const view = (field: WaterContactField) => field as unknown as ContactView;
const contactsOf = (mesh: Mesh) => (mesh.material as unknown as { pluginManager: { _plugins: Array<{ contacts?: WaterContactField | null }> } })
  .pluginManager._plugins.find((plugin) => plugin.contacts)!.contacts!;

/** Signed metres per layer at a world X/Z; +range where nothing meets the water. */
function layers(field: WaterContactField, x: number, z: number): number[] {
  const f = view(field);
  if (!f.data) return WATER_CONTACT_LAYER_OFFSETS.map(() => f.range);
  const u = Math.floor((x - f.bounds[0]!) * f.bounds[2]! * f.width), v = Math.floor((z - f.bounds[1]!) * f.bounds[3]! * f.height);
  if (u < 0 || v < 0 || u >= f.width || v >= f.height) return WATER_CONTACT_LAYER_OFFSETS.map(() => f.range);
  const i = (v * f.width + u) * 4;
  return WATER_CONTACT_LAYER_OFFSETS.map((_, k) => (f.data![i + k]! / 255 * 2 - 1) * f.range);
}

/** The shader's blend: the two layers around a rendered wave height (relative to rest). */
function contactAt(field: WaterContactField, x: number, z: number, height: number): number {
  const values = layers(field, x, z), f = view(field);
  const layer = (Math.max(-1, Math.min(1, height / f.amplitude)) * 0.5 + 0.5) * (values.length - 1);
  return values.reduce((sum, value, k) => sum + value * Math.max(0, 1 - Math.abs(k - layer)), 0);
}

function flatSurface(scene: Scene, amplitude: number, surfaceY: (x: number, z: number) => number | null = () => 0): WaterFieldSurface {
  const mesh = MeshBuilder.CreateGround("water", { width: 40, height: 40 }, scene);
  mesh.metadata = { slateWater: true };
  return { mesh, unbounded: false, amplitude, contactRange: 2, surfaceY };
}

describe("Water contact field", () => {
  let engine: NullEngine, scene: Scene;
  const setup = () => { engine = new NullEngine(); scene = new Scene(engine); };
  // Transforms settle when a frame renders; a new render id lets moved meshes recompute.
  const frame = () => scene.incrementRenderId();
  afterEach(() => { vi.restoreAllMocks(); scene?.dispose(); engine?.dispose(); });

  it("keeps the editor grid and other helpers out of wave-aware contacts", () => {
    setup();
    const camera = new ArcRotateCamera("editor", 0, 1, 30, Vector3.Zero(), scene);
    // The default grid sits a few millimetres above y = 0, exactly where waves cross a lake at the origin.
    const grid = createEditorGrid(scene, { mode: "3d", camera });
    grid.sync(); grid.mesh.computeWorldMatrix(true);
    const proxy = MeshBuilder.CreateBox("pick proxy", { width: 3, height: 3, depth: 3 }, scene);
    proxy.position.set(-6, 0, 4); proxy.metadata = { editorPickProxy: true };
    const post = MeshBuilder.CreateBox("post", { width: 1, height: 6, depth: 1 }, scene);
    post.position.set(6, 0, 0);
    frame();
    setSceneWaterTime(scene, 1.3);
    const lake = createWaterMesh(scene, "lake", normalizeWaterBody({ width: 30, length: 30, waveScale: 1 }), createDefaultWaterDefinition());
    const contacts = contactsOf(lake);
    // Only the post meets the water: open water and the proxy's footprint stay clear at every height.
    for (const [x, z] of [[0, 0], [-6, 4], [-3, -8], [10, 9]] as const) {
      expect(layers(contacts, x, z).every((value) => value > view(contacts).range * 0.95)).toBe(true);
    }
    expect(Math.abs(contactAt(contacts, 6.55, 0, 0))).toBeLessThan(0.15);
  });

  it("stores each layer's own cross-section, so a sloped object's waterline moves with the wave height", () => {
    setup();
    // Radius 2 at y = -2 narrowing to a point at y = 2: radius 1 - y / 2.
    MeshBuilder.CreateCylinder("cone", { height: 4, diameterBottom: 4, diameterTop: 0, tessellation: 64 }, scene);
    const field = new WaterContactField(scene, flatSurface(scene, 1));
    expect(field.update(0)).toBe(true);
    // Layer heights -1, -1/3, 1/3, 1 cut radii 1.5, 1.17, 0.83, 0.5: radius 1 is inside the lowest
    // cross-section and outside the highest, about half a metre from each (less across the slope).
    const [low, , , high] = layers(field, 1, 0);
    expect(low).toBeLessThan(-0.35);
    expect(low).toBeGreaterThan(-0.55);
    expect(high).toBeGreaterThan(0.35);
    expect(high).toBeLessThan(0.55);
    // At rest the water meets the cone at radius 1; a crest meets it further in, a trough further out.
    expect(Math.abs(contactAt(field, 1, 0, 0))).toBeLessThan(0.08);
    expect(contactAt(field, 1, 0, 1)).toBeGreaterThan(0.35);
    expect(Math.abs(contactAt(field, 1.5, 0, -1))).toBeLessThan(0.08);
    expect(Math.abs(contactAt(field, 0, 0.5, 1))).toBeLessThan(0.08);
    // Far from the cone nothing is recorded.
    expect(contactAt(field, 8, 8, 0)).toBeCloseTo(2, 1);
    field.dispose();
  });

  it("keeps an oblique contact, a face resting on the waterline, and ignores submerged faces", () => {
    setup();
    const contact = new Mesh("contact", scene), triangles = new VertexData();
    triangles.positions = [
      // Crosses the water between (-5, -4) and (-4, -5) in world X/Z.
      -6, -2, -6, -4, 2, -2, -2, 2, -4,
      // An edge on the waterline keeps its contact from (3, -3) to (7, 1).
      3, 0, -3, 7, 0, 1, 5, 2, 5,
      // A submerged triangle must not contribute.
      -6, -2, 4, -2, -2, 4, -4, -2, 8,
    ];
    triangles.indices = [0, 1, 2, 3, 4, 5, 6, 7, 8];
    triangles.applyToMesh(contact);
    const field = new WaterContactField(scene, flatSurface(scene, 0.05));
    field.update(0);
    expect(Math.abs(contactAt(field, -4.5, -4.5, 0))).toBeLessThan(0.1);
    expect(Math.abs(contactAt(field, 5, -1, 0))).toBeLessThan(0.1);
    expect(Math.abs(contactAt(field, 3, -3, 0))).toBeLessThan(0.1);
    expect(contactAt(field, -4, 5, 0)).toBeGreaterThan(1.9);
    field.dispose();
  });

  it("marks closed objects' interiors negative and places every thin instance", () => {
    setup();
    const posts = MeshBuilder.CreateBox("posts", { width: 2, height: 4, depth: 2 }, scene);
    posts.position.set(0, 0, 3);
    const matrices = new Float32Array(32);
    Matrix.Translation(-5, 0, 0).copyToArray(matrices, 0);
    Matrix.Translation(5, 0, 0).copyToArray(matrices, 16);
    posts.thinInstanceSetBuffer("matrix", matrices, 16, true);
    posts.thinInstanceRefreshBoundingInfo(true);
    frame();
    const field = new WaterContactField(scene, flatSurface(scene, 0.5));
    field.update(0);
    for (const x of [-5, 5]) {
      expect(contactAt(field, x, 3, 0)).toBeLessThan(-0.8);
      expect(Math.abs(contactAt(field, x + 1.02, 3, 0))).toBeLessThan(0.1);
    }
    // The base placement is not drawn once thin instances exist.
    expect(contactAt(field, 0, 3, 0)).toBeGreaterThan(1.9);
    field.dispose();
  });

  it("keeps a pier whose centre stands on land beyond a finite body's footprint", () => {
    setup();
    const pier = MeshBuilder.CreateBox("pier", { width: 12, height: 3, depth: 1 }, scene);
    pier.position.set(4, 0, 0);
    frame();
    // Water covers only x < 0, so the pier's centre (x = 4) is on land.
    const field = new WaterContactField(scene, flatSurface(scene, 0.3, (x) => x < 0 ? 0 : null));
    field.update(0);
    expect(Math.abs(contactAt(field, -2.02, 0, 0))).toBeLessThan(0.1);
    field.dispose();
  });

  it("rebuilds for moving objects but never while waves animate, and releases contacts that leave the water", () => {
    setup();
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const post = MeshBuilder.CreateBox("post", { width: 1, height: 6, depth: 1 }, scene);
    const neighbour = MeshBuilder.CreateBox("neighbour", { width: 1, height: 6, depth: 1 }, scene);
    neighbour.position.x = -3;
    frame();
    const lake = createWaterMesh(scene, "lake", normalizeWaterBody({ width: 30, length: 30, waveScale: 1 }), { ...createDefaultWaterDefinition(), waveHeight: 1 });
    const contacts = contactsOf(lake);
    expect(contacts.texture).not.toBeNull();
    const uploads = [vi.spyOn(engine, "updateRawTexture"), vi.spyOn(engine, "createRawTexture")];
    for (let step = 1; step <= 6; step++) {
      clock += 250; setSceneWaterTime(scene, step * 0.4); updateSceneWater(scene);
    }
    for (const upload of uploads) expect(upload).not.toHaveBeenCalled();
    expect(Math.abs(contactAt(contacts, 0.55, 0, 0))).toBeLessThan(0.15);
    // A small move recomputes only the post's neighbourhood; the static neighbour inside it survives.
    post.position.x = 0.3;
    frame(); clock += 50; updateSceneWater(scene);
    expect(uploads.some((upload) => upload.mock.calls.length > 0)).toBe(true);
    expect(contactAt(contacts, 0.55, 0, 0)).toBeLessThan(-0.15);
    expect(Math.abs(contactAt(contacts, 0.85, 0, 0))).toBeLessThan(0.15);
    expect(Math.abs(contactAt(contacts, -2.45, 0, 0))).toBeLessThan(0.15);
    post.position.x = 6;
    frame(); clock += 50; updateSceneWater(scene);
    expect(contactAt(contacts, 0.85, 0, 0)).toBeGreaterThan(1);
    expect(Math.abs(contactAt(contacts, 6.55, 0, 0))).toBeLessThan(0.15);
    for (const mesh of [post, neighbour]) mesh.position.y = 20;
    frame(); clock += 250; updateSceneWater(scene);
    expect(contacts.texture).toBeNull();
  });
});

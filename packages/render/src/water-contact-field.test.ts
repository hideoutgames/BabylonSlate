import { afterEach, describe, expect, it, vi } from "vitest";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
// Registers thin instances, which the fixture adds.
import "@babylonjs/core/Meshes/thinInstanceMesh";
import { createDefaultWaterDefinition, normalizeRenderingQuality, normalizeWaterBody, qualityPresetPatch, type QualityLevel } from "@haptic/core";
import { createEditorGrid } from "./editor-grid";
import { updateSceneRenderingSettings } from "./render-settings";
import { createWaterMesh, setSceneWaterTime, settleSceneWater, updateSceneWater } from "./water-mesh";
import { minimumFilter, WATER_CONTACT_FRAME_BUDGET_MS, WATER_CONTACT_LAYER_OFFSETS, WaterContactField } from "./water-contact-field";
import { rasterContactWindow, type ContactRasterJob } from "./water-contact-raster";
import { ContactRasterClient } from "./water-contact-worker-client";
import type { WaterFieldSurface } from "./water-field";
import { builtInWaterMaterial } from "./water-template";
import { meshWaterNodeSurface } from "./water-node-blocks";

type ContactView = { data: Uint8Array | null; width: number; height: number; bounds: number[]; range: number; amplitude: number; texture: unknown };
const view = (field: WaterContactField) => field as unknown as ContactView;
const contactsOf = (mesh: Mesh) => meshWaterNodeSurface(mesh)!.contacts!;

/** Signed metres per layer at a world X/Z; +range where nothing meets the water. */
function layers(field: WaterContactField, x: number, z: number): number[] {
  const f = view(field);
  if (!f.data) return WATER_CONTACT_LAYER_OFFSETS.map(() => f.range);
  const u = Math.floor((x - f.bounds[0]!) * f.bounds[2]! * f.width), v = Math.floor((z - f.bounds[1]!) * f.bounds[3]! * f.height);
  if (u < 0 || v < 0 || u >= f.width || v >= f.height) return WATER_CONTACT_LAYER_OFFSETS.map(() => f.range);
  const i = (v * f.width + u) * 4;
  return WATER_CONTACT_LAYER_OFFSETS.map((_, k) => (f.data![i + k]! / 255 * 2 - 1) * f.range);
}

/**
 * Texels of `field` that differ from `reference`'s, cell by cell in the world (both lay their cells on one lattice); a
 * cell only one of them covers counts unless the other side reads far (255) there.
 */
function differing(field: WaterContactField, reference: WaterContactField): number {
  const a = view(field), b = view(reference);
  if (!a.data || !b.data) throw new Error("Both fields must be allocated.");
  const cell = 1 / (a.bounds[2]! * a.width);
  expect(1 / (b.bounds[2]! * b.width)).toBeCloseTo(cell, 9);
  const dx = Math.round((b.bounds[0]! - a.bounds[0]!) / cell), dz = Math.round((b.bounds[1]! - a.bounds[1]!) / cell);
  const texel = (f: ContactView, u: number, v: number, k: number) => u < 0 || v < 0 || u >= f.width || v >= f.height ? 255 : f.data![(v * f.width + u) * 4 + k]!;
  let count = 0;
  for (let v = Math.min(0, dz); v < Math.max(a.height, dz + b.height); v++) for (let u = Math.min(0, dx); u < Math.max(a.width, dx + b.width); u++) {
    for (let k = 0; k < 4; k++) if (texel(a, u, v, k) !== texel(b, u - dx, v - dz, k)) { count++; break; }
  }
  return count;
}

/** The shader's blend: the two layers around a rendered wave height (relative to rest). */
function contactAt(field: WaterContactField, x: number, z: number, height: number): number {
  const values = layers(field, x, z), f = view(field);
  const layer = (Math.max(-1, Math.min(1, height / f.amplitude)) * 0.5 + 0.5) * (values.length - 1);
  return values.reduce((sum, value, k) => sum + value * Math.max(0, 1 - Math.abs(k - layer)), 0);
}

function flatSurface(scene: Scene, amplitude: number, surfaceY: (x: number, z: number) => number | null = () => 0, range = 2, x = 0, z = 0): WaterFieldSurface {
  const mesh = MeshBuilder.CreateGround("water", { width: 40, height: 40 }, scene);
  mesh.position.set(x, 0, z); mesh.computeWorldMatrix(true);
  mesh.metadata = { slateWater: true };
  return { mesh, unbounded: false, amplitude, contactRange: range, surfaceY };
}

describe("Water contact field", () => {
  let engine: NullEngine, scene: Scene, frameId = 0;
  const setup = () => {
    engine = new NullEngine(); scene = new Scene(engine); frameId = 0;
    // These scenes never render, so a test frame advances the frame id that keys the contact budget itself. A clock that
    // stands still bills every window the budget's minimum, so a rebuild finishes within its frame unless a test says otherwise.
    vi.spyOn(scene, "getFrameId").mockImplementation(() => frameId);
    vi.spyOn(performance, "now").mockReturnValue(0);
  };
  // Transforms settle when a frame renders; a new render id lets moved meshes recompute.
  const frame = () => { scene.incrementRenderId(); frameId++; };
  afterEach(() => { vi.restoreAllMocks(); scene?.dispose(); engine?.dispose(); });

  it("keeps the editor grid, other helpers and infinite-distance sky domes out of wave-aware contacts", () => {
    setup();
    const camera = new ArcRotateCamera("editor", 0, 1, 30, Vector3.Zero(), scene);
    // The default grid sits a few millimetres above y = 0, exactly where waves cross a lake at the origin.
    const grid = createEditorGrid(scene, { mode: "3d", camera });
    grid.sync(); grid.mesh.computeWorldMatrix(true);
    const proxy = MeshBuilder.CreateBox("pick proxy", { width: 3, height: 3, depth: 3 }, scene);
    proxy.position.set(-6, 0, 4); proxy.metadata = { editorPickProxy: true };
    // A sky dome drawn at infinite distance follows the camera (about 16 m up at x = 25); its geometry crossing y = 0
    // (about 12 m around the camera, through x = 13 on the lake) is no waterline.
    const dome = MeshBuilder.CreateSphere("sky dome", { diameter: 40, sideOrientation: Mesh.BACKSIDE }, scene);
    dome.infiniteDistance = true;
    const post = MeshBuilder.CreateBox("post", { width: 1, height: 6, depth: 1 }, scene);
    post.position.set(6, 0, 0);
    frame();
    setSceneWaterTime(scene, 1.3);
    const lake = createWaterMesh(scene, "lake", normalizeWaterBody({ width: 30, length: 30, waveScale: 1 }), createDefaultWaterDefinition(), builtInWaterMaterial(scene));
    const contacts = contactsOf(lake);
    // Only the post meets the water: open water and the proxy's footprint stay clear at every height.
    for (const [x, z] of [[0, 0], [-6, 4], [-3, -8], [10, 9], [13.2, 0], [14, 4]] as const) {
      expect(layers(contacts, x, z).every((value) => value > view(contacts).range * 0.95)).toBe(true);
    }
    expect(Math.abs(contactAt(contacts, 6.55, 0, 0))).toBeLessThan(0.15);
  });

  describe("frame budget", () => {
    /** Six surfaces (contact range 1 m) that all track one box, which each build once. */
    const sixSurfaces = () => {
      const box = MeshBuilder.CreateBox("float", { width: 1, height: 1, depth: 1 }, scene);
      const fields = Array.from({ length: 6 }, () => new WaterContactField(scene, flatSurface(scene, 0.3, () => 0, 1)));
      for (const field of fields) field.update(0);
      return { box, fields };
    };
    /** The box moved 0.4 m along X: its far face's waterline now sits at x = 0.9. */
    const showsMove = (field: WaterContactField, x = 0, z = 0) => Math.abs(contactAt(field, x + 0.9, z, 0)) < 0.1;

    it("builds at most a frame's budget of windows, the rest in later frames, until every surface shows the move", () => {
      setup();
      const { box, fields } = sixSurfaces();
      // Each window, and each surface's re-slice, now takes a millisecond of the frame's two.
      let clock = 0;
      vi.spyOn(performance, "now").mockImplementation(() => clock++);
      box.position.x = 0.4;
      const shown: number[] = [];
      for (let step = 0; step < 12 && !fields.every((field) => showsMove(field)); step++) {
        frame();
        for (const field of fields) field.update(50 + step * 16);
        shown.push(fields.filter((field) => showsMove(field)).length);
      }
      expect(shown[0]).toBeGreaterThan(0);
      expect(shown[0]).toBeLessThan(fields.length);
      // Never more than the budget buys in one frame, yet every surface gets there within a few.
      expect(shown.every((count, i) => count - (shown[i - 1] ?? 0) <= WATER_CONTACT_FRAME_BUDGET_MS)).toBe(true);
      expect(fields.every((field) => showsMove(field))).toBe(true);
      expect(shown.length).toBeLessThanOrEqual(5);
      expect(fields.every((field) => field.queued === 0)).toBe(true);
    });

    it("keeps serving every surface while objects move constantly, so none starves behind the others", () => {
      setup();
      const { box, fields } = sixSurfaces();
      let clock = 0;
      vi.spyOn(performance, "now").mockImplementation(() => clock++);
      // One texture upload per window built (a NullEngine uploads every change whole), told apart by each surface's texture.
      const upload = vi.spyOn(engine, "updateRawTexture"), textures = fields.map((field) => field.texture!.getInternalTexture());
      const uploadsOf = (i: number) => upload.mock.calls.filter(([texture]) => texture === textures[i]).length;
      const counted = fields.map(() => 0), built: number[][] = fields.map(() => []);
      // The box shuttles 0.2 m every frame at 60 frames per second: every surface has a window to rebuild every other frame
      // (its own interval), three times what the budget builds.
      for (let step = 1; step <= 48; step++) {
        box.position.x = step % 2 ? 0.2 : 0;
        frame();
        for (const field of fields) field.update(step * 16);
        fields.forEach((_, i) => { const calls = uploadsOf(i); if (calls > counted[i]!) built[i]!.push(step); counted[i] = calls; });
      }
      for (const frames of built) {
        expect(frames.length).toBeGreaterThanOrEqual(6);
        // The longest wait between two of its rebuilds, or from the start to its first, stays a few frames.
        expect(Math.max(frames[0]!, ...frames.slice(1).map((step, i) => step - frames[i]!))).toBeLessThanOrEqual(8);
      }
    });

    it("serves the nearest seen window first and holds a window no camera sees back for a while, but not forever", () => {
      setup();
      const camera = new FreeCamera("camera", new Vector3(0, 6, -20), scene);
      camera.setTarget(Vector3.Zero());
      // Near the camera, farther along its view, and far off to the side where it looks nowhere.
      const spots = [[0, 0], [0, 100], [-300, 0]] as const;
      const fields = spots.map(([x, z]) => {
        const box = MeshBuilder.CreateBox("float", { width: 1, height: 1, depth: 1 }, scene);
        box.position.set(x, 0, z);
        return { box, field: new WaterContactField(scene, flatSurface(scene, 0.3, () => 0, 1, x, z)) };
      });
      frame();
      // Built whole at once: a first build without `force` would wait like any window (the far and unseen ones longer).
      for (const { field } of fields) field.update(0, true);
      const shows = fields.map(({ field }, i) => () => showsMove(field, spots[i]![0], spots[i]![1]));
      // One window fills the frame's budget.
      let clock = 0;
      vi.spyOn(performance, "now").mockImplementation(() => (clock += 2));
      for (const { box } of fields) box.position.x += 0.4;
      // A forced rebuild elsewhere spends the first frame, so all three windows are queued when the second begins.
      const filler = new WaterContactField(scene, flatSurface(scene, 0.3, () => 0, 1, 500, 0));
      frame();
      filler.update(50, true);
      for (const { field } of fields) field.update(50);
      expect(shows.map((shown) => shown())).toEqual([false, false, false]);
      for (const [now, expected] of [[66, [true, false, false]], [82, [true, true, false]]] as const) {
        frame();
        for (const { field } of fields) field.update(now);
        expect(shows.map((shown) => shown())).toEqual(expected);
      }
      // The unseen one waits out its delay (frames of 16 ms for about 400 ms), however free the budget is...
      let now = 82;
      while (now < 400) { now += 16; frame(); for (const { field } of fields) field.update(now); }
      expect(shows[2]!()).toBe(false);
      // ...and then it is built.
      frame();
      for (const { field } of fields) field.update(now + 100);
      expect(shows[2]!()).toBe(true);
      filler.dispose();
    });

    it("lets a window waiting long behind nearer, busier ones go first, so a far surface is still built", () => {
      setup();
      const camera = new FreeCamera("camera", new Vector3(0, 6, -20), scene);
      camera.setTarget(Vector3.Zero());
      const mover = (x: number, z: number) => {
        const box = MeshBuilder.CreateBox("float", { width: 1, height: 1, depth: 1 }, scene);
        box.position.set(x, 0, z);
        return { box, field: new WaterContactField(scene, flatSurface(scene, 0.3, () => 0, 1, x, z)) };
      };
      // Two near surfaces that move every frame, and one seen far down the camera's view (past where the delay is longest).
      const near = [mover(-3, 0), mover(3, 0)], far = mover(0, 400);
      frame();
      for (const { field } of [...near, far]) field.update(0);
      // A window takes the whole budget, and the near ones are rebuilt as fast as they change.
      let clock = 0;
      vi.spyOn(performance, "now").mockImplementation(() => (clock += 2));
      far.box.position.x += 0.4;
      let farShownAt = -1;
      for (let step = 1; step <= 60 && farShownAt < 0; step++) {
        for (const { box } of near) box.position.x += step % 2 ? 0.3 : -0.3;
        frame();
        for (const { field } of [...near, far]) field.update(step * 16);
        if (showsMove(far.field, 0, 400)) farShownAt = step * 16;
      }
      // Overdue after a quarter of a second, it outranks every nearer window.
      expect(farShownAt).toBeGreaterThan(0);
      expect(farShownAt).toBeLessThanOrEqual(500);
    });

    it("builds a window larger than a block in blocks over frames, across a growing allocation too, and ends exactly where one full rebuild would", () => {
      setup();
      // A 6 m tank: the window of its move is about 140 cells a side, nine blocks, and its waterline crosses their seams.
      const tank = MeshBuilder.CreateCylinder("tank", { height: 2, diameter: 6, tessellation: 64 }, scene);
      const field = new WaterContactField(scene, flatSurface(scene, 0.3, () => 0, 1));
      field.update(0);
      let clock = 0;
      vi.spyOn(performance, "now").mockImplementation(() => clock++);
      /**
       * Largest difference of any layer around the tank from a field built in one go at its pose, at the middle of every
       * cell of 0.06 m (a 1 m range's cell): both fields lay their cells on the same lattice.
       */
      const unlike = () => {
        const whole = new WaterContactField(scene, flatSurface(scene, 0.3, () => 0, 1));
        whole.update(0, true);
        let worst = 0;
        for (let i = -100; i <= 150; i++) for (let j = -85; j <= 85; j++) {
          const a = layers(field, (i + 0.5) * 0.06, (j + 0.5) * 0.06), b = layers(whole, (i + 0.5) * 0.06, (j + 0.5) * 0.06);
          for (let k = 0; k < a.length; k++) worst = Math.max(worst, Math.abs(a[k]! - b[k]!));
        }
        whole.dispose();
        return worst;
      };
      const settle = (from: number) => { for (let step = 1; step < 20 && field.queued > 0; step++) { frame(); field.update(from + step * 16); } };
      tank.position.x = 0.4;
      frame();
      field.update(50);
      // Where its waterline now runs, only the blocks built so far show it.
      const waterline = [[3.4, 0], [-2.6, 0], [2.521, 2.121], [-1.721, -2.121]] as const;
      const shown = waterline.filter(([x, z]) => Math.abs(contactAt(field, x, z, 0)) < 0.1).length;
      expect(shown).toBeGreaterThan(0);
      expect(shown).toBeLessThan(waterline.length);
      expect(field.queued).toBeGreaterThan(0);
      settle(50);
      expect(field.queued).toBe(0);
      // No seam shows where blocks meet: every cell agrees with the one-go field (to the 8 bits it stores).
      expect(unlike()).toBeLessThan(0.01);
      // Moving beyond the allocation grows it, carrying what it kept over, so this too ends the same way.
      tank.position.x = 3.4;
      frame();
      field.update(400);
      expect(field.queued).toBeGreaterThan(0);
      settle(400);
      expect(field.queued).toBe(0);
      expect(unlike()).toBeLessThan(0.01);
      field.dispose();
    });
  });

  describe("progressive rebuilds", () => {
    /** Posts spread along X (12 m apart) and across Z, on a surface whose envelope and range the test changes. */
    const posts = () => {
      for (let i = 0; i < 6; i++) MeshBuilder.CreateBox(`post ${i}`, { width: 0.8, height: 4, depth: 0.8 }, scene).position.set(-30 + i * 12, 0, (i % 3) * 2);
      frame();
    };
    const same = (surface: WaterFieldSurface) => ({ ...surface, mesh: flatSurface(scene, surface.amplitude).mesh });

    for (const [name, change] of [
      ["wave envelope", (surface: WaterFieldSurface) => { surface.amplitude = 0.6; }],
      ["contact range", (surface: WaterFieldSurface) => { surface.contactRange = 3; }],
      // The posts need 1024 cells at the finest size: 256 doubles the cells, so nothing carries over.
      ["Contact Resolution", (surface: WaterFieldSurface) => { surface.contactCells = 256; }],
    ] as const) {
      it(`spreads a changed ${name} over frames, keeping a texture bound, and ends exactly where a forced rebuild does`, () => {
        setup();
        posts();
        const surface = flatSurface(scene, 0.3), field = new WaterContactField(scene, surface);
        field.update(0, true);
        const textures = scene.textures.length;
        // Each window, and the update's own work, takes a millisecond of the frame's two.
        let clock = 0;
        vi.spyOn(performance, "now").mockImplementation(() => clock++);
        change(surface);
        frame();
        field.update(50);
        expect(field.queued).toBeGreaterThan(0);
        expect(field.texture).not.toBeNull();
        let frames = 0;
        for (; frames < 400 && field.queued > 0; frames++) {
          frame(); field.update(66 + frames * 16);
          expect(field.texture).not.toBeNull();
        }
        expect(field.queued).toBe(0);
        expect(frames).toBeGreaterThan(1);
        const forced = new WaterContactField(scene, same(surface));
        forced.update(0, true);
        expect(differing(field, forced)).toBe(0);
        expect(scene.textures.length).toBe(textures);
        forced.dispose(); field.dispose();
      });
    }

    it("builds a new surface without force over frames, and a settle finishes everything in one call", () => {
      setup();
      posts();
      let clock = 0;
      vi.spyOn(performance, "now").mockImplementation(() => clock++);
      const surface = flatSurface(scene, 0.3), field = new WaterContactField(scene, surface);
      field.update(0);
      // Allocated and bound at once, far everywhere until its windows are built.
      expect(field.texture).not.toBeNull();
      expect(field.queued).toBeGreaterThan(0);
      const forced = new WaterContactField(scene, same(surface));
      forced.update(0, true);
      expect(differing(field, forced)).toBeGreaterThan(0);
      frame();
      expect(field.settle(16)).toBe(true);
      expect(field.queued).toBe(0);
      expect(differing(field, forced)).toBe(0);
      // Nothing left to do: a second settle changes nothing.
      frame();
      expect(field.settle(32)).toBe(false);
      forced.dispose(); field.dispose();
    });

    it("leaves a created body's contacts to the frame budget, and a load's settle finishes them at once, seen or not", () => {
      setup();
      // The camera looks away from both lakes: no contact update runs for them in a frame of their own.
      const camera = new FreeCamera("camera", new Vector3(0, 5, 200), scene);
      camera.setTarget(new Vector3(0, 5, 400));
      for (const x of [-6, -2, 2, 6]) MeshBuilder.CreateBox(`post ${x}`, { width: 0.6, height: 4, depth: 0.6 }, scene).position.x = x;
      frame();
      let clock = 0;
      vi.spyOn(performance, "now").mockImplementation(() => clock++);
      const lakes = [0, 1].map((i) => createWaterMesh(scene, `lake ${i}`, normalizeWaterBody({ width: 20, length: 10 }), createDefaultWaterDefinition(), builtInWaterMaterial(scene)));
      const contacts = lakes.map(contactsOf);
      expect(contacts.every((field) => field.texture !== null && field.queued > 0)).toBe(true);
      // A new body counts as drawn for its first frame; after it, nothing draws these and no camera sees them.
      frame(); updateSceneWater(scene);
      expect(contacts.every((field) => field.queued > 0)).toBe(true);
      frame();
      settleSceneWater(scene, true);
      expect(contacts.map((field) => field.queued)).toEqual([0, 0]);
      for (const field of contacts) for (const x of [-6, 6]) expect(Math.abs(contactAt(field, x + 0.32, 0, 0))).toBeLessThan(0.15);
    });

    it("slices a backlog of moved objects over frames within the budget, least recently sliced first, so none starves", () => {
      setup();
      const boxes = Array.from({ length: 24 }, (_, i) => {
        const box = MeshBuilder.CreateBox(`float ${i}`, { width: 0.5, height: 1, depth: 0.5 }, scene);
        box.position.set(-12 + i, 0, 0);
        return box;
      });
      frame();
      const field = new WaterContactField(scene, flatSurface(scene, 0.3, () => 0, 1), { raster: null });
      field.update(0, true);
      // Each clock read is a millisecond: an update slices two objects before the frame's two are spent.
      let clock = 0;
      vi.spyOn(performance, "now").mockImplementation(() => clock++);
      const slices = boxes.map((box) => vi.spyOn(box, "getVerticesData"));
      for (const box of boxes) box.position.z = 0.3;
      const firstSliced: number[] = boxes.map(() => -1);
      for (let step = 1; step <= 30 && firstSliced.includes(-1); step++) {
        // The first four keep moving every frame, and come first in the scene.
        for (let i = 0; i < 4; i++) boxes[i]!.position.z = 0.3 + (step % 2) * 0.2;
        frame();
        field.update(step * 16);
        slices.forEach((slice, i) => { if (firstSliced[i]! < 0 && slice.mock.calls.length > 0) firstSliced[i] = step; });
      }
      // Never the whole backlog in one frame: the first frame that slices takes two.
      const first = Math.min(...firstSliced);
      expect(firstSliced.filter((at) => at === first)).toHaveLength(2);
      // Every object was cut again, the last within about a frame per two objects, though four kept moving throughout.
      expect(firstSliced.every((at) => at > 0)).toBe(true);
      expect(Math.max(...firstSliced)).toBeLessThanOrEqual(16);
      field.dispose();
    });

    it("rebuilds the cells along the old allocation's edges when a move grows it, so carried cells end as a whole build does", () => {
      setup();
      // A 3 m range: 12.5 cm cells and a 2-cell smoothing radius, whose rounding reaches 4 cells past the distances.
      // The static post's allocation ends exactly 3.25 m from it (x = -4, on a 2 m block), so its rounding ran into
      // that edge, which the other post's move far to the left turns into the middle of the field.
      const post = MeshBuilder.CreateBox("post", { width: 1, height: 4, depth: 1 }, scene);
      post.position.x = -0.25;
      const mover = MeshBuilder.CreateBox("mover", { width: 1, height: 4, depth: 1 }, scene);
      mover.position.x = 1;
      frame();
      const surface = flatSurface(scene, 0.3, () => 0, 3), field = new WaterContactField(scene, surface);
      field.update(0, true);
      expect(view(field).bounds[0]).toBeCloseTo(-4, 9);
      mover.position.x = -10;
      frame(); field.update(50);
      for (let step = 1; step < 40 && field.queued > 0; step++) { frame(); field.update(50 + step * 16); }
      expect(field.queued).toBe(0);
      const forced = new WaterContactField(scene, same(surface));
      forced.update(0, true);
      expect(differing(field, forced)).toBe(0);
      forced.dispose(); field.dispose();
    });

    it("keeps the contact texture out of the Scene's textures while it is allocated, grown, released and restored", () => {
      setup();
      const box = MeshBuilder.CreateBox("float", { width: 1, height: 1, depth: 1 }, scene);
      frame();
      const count = scene.textures.length;
      const field = new WaterContactField(scene, flatSurface(scene, 0.3, () => 0, 1));
      field.update(0, true);
      expect(field.texture).not.toBeNull();
      const first = field.texture;
      // Far beyond the allocation: a larger texture replaces it.
      box.position.x = 9;
      frame(); field.update(100, true);
      expect(field.texture).not.toBe(first);
      field.releaseTexture();
      expect(field.texture).toBeNull();
      field.restore(200);
      expect(field.texture).not.toBeNull();
      expect(scene.textures.length).toBe(count);
      field.dispose();
      expect(scene.textures.length).toBe(count);
    });
  });

  describe("contact worker", () => {
    /**
     * A worker stand-in the test answers by hand, in any order: each job is copied when it is sent (as `postMessage`
     * does) and answered with the real rasteriser's texels, or with `texels` given.
     */
    const manualWorker = () => {
      const jobs: { job: ContactRasterJob; resolve: (texels: Uint8Array) => void; reject: (error: Error) => void }[] = [];
      const client = new ContactRasterClient(() => ({
        post: (job) => new Promise<Uint8Array>((resolve, reject) => { jobs.push({ job: structuredClone(job), resolve, reject }); }),
        close: () => { for (const job of jobs.splice(0)) job.reject(new Error("closed")); },
      }));
      const answer = (index = 0, texels?: Uint8Array) => {
        const [{ job, resolve }] = jobs.splice(index, 1) as [typeof jobs[number]];
        const out = new Uint8Array((job.write.x1 - job.write.x0) * (job.write.z1 - job.write.z0) * 4);
        if (texels) out.set(texels.subarray(0, out.length)); else rasterContactWindow(job, out);
        resolve(out);
      };
      return { client, jobs, answer };
    };
    /** Lets the answered jobs' callbacks run. */
    const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

    it("builds a full rebuild at the worker in blocks of up to 256 cells, two at a time, applied on later updates", async () => {
      setup();
      for (const x of [-9, 9]) for (const z of [-9, 9]) MeshBuilder.CreateBox(`post ${x} ${z}`, { width: 1, height: 4, depth: 1 }, scene).position.set(x, 0, z);
      frame();
      const worker = manualWorker(), surface = flatSurface(scene, 0.3, () => 0, 1);
      const field = new WaterContactField(scene, surface, { raster: worker.client });
      field.update(0);
      // About 350 cells a side, four blocks: two of more than the main thread's 64 cells a side are out, two queued.
      expect(worker.jobs).toHaveLength(2);
      expect(field.queued).toBe(4);
      for (const { job } of worker.jobs) {
        expect(job.write.x1 - job.write.x0).toBeGreaterThan(64);
        expect(job.write.x1 - job.write.x0).toBeLessThanOrEqual(256);
      }
      const forced = new WaterContactField(scene, { ...surface, mesh: flatSurface(scene, 0.3).mesh }, { raster: null });
      forced.update(0, true);
      const before = differing(field, forced);
      worker.answer();
      await flush();
      // Nothing lands until the next update.
      expect(differing(field, forced)).toBe(before);
      for (let step = 1; step < 20 && field.queued > 0; step++) {
        frame(); expect(field.update(step * 16)).toBe(true);
        expect(worker.jobs.length).toBeLessThanOrEqual(2);
        while (worker.jobs.length > 0) worker.answer();
        await flush();
      }
      expect(field.queued).toBe(0);
      expect(differing(field, forced)).toBe(0);
      forced.dispose(); field.dispose();
    });

    it("drops a result sent before a forced rebuild or settle, which builds those cells itself", async () => {
      setup();
      const box = MeshBuilder.CreateBox("float", { width: 1, height: 1, depth: 1 }, scene);
      frame();
      const worker = manualWorker(), surface = flatSurface(scene, 0.3, () => 0, 1);
      const field = new WaterContactField(scene, surface, { raster: worker.client });
      field.update(0, true);
      for (const [now, finish] of [[50, () => field.update(60, true)], [100, () => field.settle(110)]] as const) {
        box.position.x += 0.4;
        frame(); field.update(now);
        expect(worker.jobs.length).toBeGreaterThan(0);
        frame(); finish();
        expect(field.queued).toBe(0);
        // The late answer says "inside" everywhere; it must not land.
        while (worker.jobs.length > 0) worker.answer(0, new Uint8Array(1 << 20));
        await flush();
        frame(); field.update(now + 30);
        const forced = new WaterContactField(scene, { ...surface, mesh: flatSurface(scene, 0.3).mesh }, { raster: null });
        forced.update(0, true);
        expect(differing(field, forced)).toBe(0);
        forced.dispose();
      }
      field.dispose();
    });

    it("queues the windows at the worker again in the new cells when the allocation grows, so none is lost", async () => {
      setup();
      const near = MeshBuilder.CreateBox("near", { width: 1, height: 1, depth: 1 }, scene);
      const far = MeshBuilder.CreateBox("far", { width: 1, height: 1, depth: 1 }, scene);
      far.position.x = 2;
      frame();
      const worker = manualWorker(), surface = flatSurface(scene, 0.3, () => 0, 1);
      const field = new WaterContactField(scene, surface, { raster: worker.client });
      field.update(0, true);
      // The near box moves: its window goes to the worker.
      near.position.z = 0.4;
      frame(); field.update(50);
      expect(worker.jobs).toHaveLength(1);
      // The other leaves the allocation: it grows on the same lattice, carrying its cells over.
      far.position.x = 8;
      frame(); field.update(100);
      // The answer computed for the old cells is dropped; the near box's window comes back for the new ones.
      for (let step = 1; step < 20 && field.queued > 0; step++) {
        while (worker.jobs.length > 0) worker.answer();
        await flush();
        frame(); field.update(100 + step * 16);
      }
      expect(field.queued).toBe(0);
      const forced = new WaterContactField(scene, { ...surface, mesh: flatSurface(scene, 0.3).mesh }, { raster: null });
      forced.update(0, true);
      expect(differing(field, forced)).toBe(0);
      forced.dispose(); field.dispose();
    });

    it("never lets an older result land over newer cells, whatever order the worker answers in", async () => {
      setup();
      const box = MeshBuilder.CreateBox("float", { width: 1, height: 1, depth: 1 }, scene);
      frame();
      const worker = manualWorker(), surface = flatSurface(scene, 0.3, () => 0, 1);
      const field = new WaterContactField(scene, surface, { raster: worker.client });
      field.update(0, true);
      // Two moves in a row: two overlapping windows at the worker, the second from the newer pose.
      box.position.x = 0.4;
      frame(); field.update(50);
      box.position.x = 0.8;
      frame(); field.update(100);
      expect(worker.jobs).toHaveLength(2);
      // The newer answer first: the far face's waterline is at x = 1.3 now, and nothing stands at x = 0.9 any more.
      worker.answer(1);
      await flush();
      frame(); field.update(116);
      expect(Math.abs(contactAt(field, 1.3, 0, 0))).toBeLessThan(0.1);
      // The older one arrives late: it would put the waterline back at x = 0.9. It is dropped and its window rebuilt.
      worker.answer(0);
      await flush();
      frame(); field.update(132);
      expect(Math.abs(contactAt(field, 1.3, 0, 0))).toBeLessThan(0.1);
      expect(contactAt(field, 0.9, 0, 0)).toBeLessThan(-0.1);
      for (let step = 1; step < 20 && field.queued > 0; step++) {
        while (worker.jobs.length > 0) worker.answer();
        await flush();
        frame(); field.update(132 + step * 16);
      }
      const forced = new WaterContactField(scene, { ...surface, mesh: flatSurface(scene, 0.3).mesh }, { raster: null });
      forced.update(0, true);
      expect(differing(field, forced)).toBe(0);
      forced.dispose(); field.dispose();
    });

    it("ends exactly where a forced rebuild does after an envelope change whose re-slicing spans frames while the worker answers", async () => {
      setup();
      // Cones and slanted boxes, whose sections differ at every envelope, so a cell built from a section cut for the
      // old envelope differs from the final one.
      const meshes = Array.from({ length: 10 }, (_, i) => {
        const mesh = i % 2
          ? MeshBuilder.CreateCylinder(`cone ${i}`, { height: 3, diameterBottom: 2.4, diameterTop: 0.2, tessellation: 24 }, scene)
          : MeshBuilder.CreateBox(`slab ${i}`, { width: 1.4, height: 0.5, depth: 0.8 }, scene);
        mesh.position.set(-9 + i * 2, i % 2 ? 0 : 0.1, (i % 3) - 1);
        mesh.rotation.z = i % 2 ? 0 : 0.35;
        return mesh;
      });
      frame();
      const worker = manualWorker(), surface = flatSurface(scene, 0.3, () => 0, 1);
      const field = new WaterContactField(scene, surface, { raster: worker.client });
      field.update(0, true);
      // Each clock read is a millisecond: an update re-slices two placements, so the backlog spans five frames.
      let clock = 0;
      vi.spyOn(performance, "now").mockImplementation(() => clock++);
      const slices = meshes.map((mesh) => vi.spyOn(mesh, "getVerticesData"));
      surface.amplitude = 0.8;
      const slicedAt: number[] = meshes.map(() => -1);
      let answeredBeforeLastSlice = 0;
      for (let step = 1; step < 60 && field.queued + slicedAt.filter((at) => at < 0).length > 0; step++) {
        frame(); field.update(step * 16);
        slices.forEach((slice, i) => { if (slicedAt[i]! < 0 && slice.mock.calls.length > 0) slicedAt[i] = step; });
        // The worker answers between frames, while placements still wait to be cut again.
        if (worker.jobs.length > 0 && slicedAt.includes(-1)) answeredBeforeLastSlice += worker.jobs.length;
        while (worker.jobs.length > 0) worker.answer();
        await flush();
      }
      expect(new Set(slicedAt).size).toBeGreaterThanOrEqual(4);
      expect(answeredBeforeLastSlice).toBeGreaterThan(0);
      expect(field.queued).toBe(0);
      const forced = new WaterContactField(scene, { ...surface, mesh: flatSurface(scene, 0.8).mesh }, { raster: null });
      forced.update(0, true);
      expect(differing(field, forced)).toBe(0);
      forced.dispose(); field.dispose();
    });

    it("falls back to the main thread when the worker fails, warning once, and still ends where a forced rebuild does", async () => {
      setup();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      for (const x of [-9, 9]) MeshBuilder.CreateBox(`post ${x}`, { width: 1, height: 4, depth: 1 }, scene).position.x = x;
      frame();
      const worker = manualWorker(), surface = flatSurface(scene, 0.3, () => 0, 1);
      const field = new WaterContactField(scene, surface, { raster: worker.client });
      field.update(0);
      expect(worker.jobs).toHaveLength(2);
      // One job fails: the worker is done for, and every job still out comes back to the queue.
      worker.jobs.shift()!.reject(new Error("worker crashed"));
      await flush();
      expect(worker.client.available).toBe(false);
      expect(worker.jobs).toHaveLength(0);
      for (let step = 1; step < 40 && field.queued > 0; step++) { frame(); field.update(step * 16); }
      expect(field.queued).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
      const forced = new WaterContactField(scene, { ...surface, mesh: flatSurface(scene, 0.3).mesh }, { raster: null });
      forced.update(0, true);
      expect(differing(field, forced)).toBe(0);
      forced.dispose(); field.dispose();
    });
  });

  it("leaves contacts under another body's water unbuilt, but builds the rest, until that body stops owning them", () => {
    setup();
    // High keeps 1024 cells, so a cell is 15 cm.
    updateSceneRenderingSettings(scene, { quality: normalizeRenderingQuality(qualityPresetPatch("high")) });
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    // One post stands in the Ocean, which owns the water there (it lies over Global Water Volume), one beyond it.
    const inside = MeshBuilder.CreateBox("inside", { width: 1, height: 6, depth: 1 }, scene);
    const outside = MeshBuilder.CreateBox("outside", { width: 1, height: 6, depth: 1 }, scene);
    outside.position.x = 60;
    frame();
    const water = createDefaultWaterDefinition();
    const ocean = createWaterMesh(scene, "ocean", normalizeWaterBody({ width: 40, length: 40 }, "ocean"), water, builtInWaterMaterial(scene));
    const sea = createWaterMesh(scene, "sea", normalizeWaterBody({}, "global"), water, builtInWaterMaterial(scene));
    const [oceanContacts, seaContacts] = [contactsOf(ocean), contactsOf(sea)];
    const step = () => { frame(); clock += 50; updateSceneWater(scene); };
    // Both are built whole when they are created; then each post moves 1.5 m (its waterline at x = 2 and 62).
    step();
    inside.position.x = 1.5; outside.position.x = 61.5;
    for (let i = 0; i < 4; i++) step();
    expect(Math.abs(contactAt(oceanContacts, 2.05, 0, 0))).toBeLessThan(0.3);
    expect(Math.abs(contactAt(seaContacts, 62.05, 0, 0))).toBeLessThan(0.3);
    // The Global water, discarded under the Ocean, never shows contacts there, so the move waits unbuilt: the post is
    // not even sliced again, so no window waits for it.
    expect(contactAt(seaContacts, 2.05, 0, 0)).toBeGreaterThan(1);
    expect(seaContacts.queued).toBe(0);
    expect(oceanContacts.queued).toBe(0);
    // Without the Ocean the Global water shows that spot, and the waiting window is built.
    ocean.setEnabled(false);
    for (let i = 0; i < 4; i++) step();
    expect(Math.abs(contactAt(seaContacts, 2.05, 0, 0))).toBeLessThan(0.3);
    expect(seaContacts.queued).toBe(0);
  });

  it("meets unindexed geometry, whose vertices are consecutive triangles", () => {
    setup();
    const box = MeshBuilder.CreateBox("indexed", { width: 1, height: 4, depth: 1 }, scene);
    const source = box.getVerticesData(VertexBuffer.PositionKind)!, indices = box.getIndices()!;
    const positions = Array.from(indices, (index) => [source[index * 3]!, source[index * 3 + 1]!, source[index * 3 + 2]!]).flat();
    box.dispose();
    const post = new Mesh("unindexed", scene);
    Object.assign(new VertexData(), { positions }).applyToMesh(post);
    post.isUnIndexed = true;
    post.position.set(2, 0, 0);
    frame();
    const field = new WaterContactField(scene, flatSurface(scene, 0.3));
    field.update(0);
    expect(Math.abs(contactAt(field, 2.52, 0, 0))).toBeLessThan(0.1);
    expect(contactAt(field, 2, 0, 0)).toBeLessThan(0);
    field.dispose();
  });

  it("rounds the crease where two objects' distances meet, but keeps each waterline exact", () => {
    setup();
    for (const x of [-2, 2]) MeshBuilder.CreateBox(`post ${x}`, { width: 1, height: 4, depth: 1 }, scene).position.set(x, 0, 0);
    frame();
    const field = new WaterContactField(scene, flatSurface(scene, 0.3));
    field.update(0);
    // Midway between the posts both are 1.5 m away: a hard minimum peaks there in a crease that every contour drawn
    // from it kinks along. Rounded like a smooth minimum, the peak sits lower and still falls off to either side.
    const mid = contactAt(field, 0, 0, 0), beside = contactAt(field, 0.3, 0, 0);
    expect(mid).toBeLessThan(1.45);
    expect(mid).toBeGreaterThan(1.2);
    expect(beside).toBeLessThan(mid);
    // Each hull's waterline keeps its place.
    expect(Math.abs(contactAt(field, 1.52, 0, 0))).toBeLessThan(0.1);
    expect(Math.abs(contactAt(field, -1.52, 0, 0))).toBeLessThan(0.1);
    field.dispose();
  });

  it("takes the minimum over each cell's clamped (2r + 1)² window at any radius", () => {
    let seed = 7;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (const [width, height, r] of [[9, 6, 1], [17, 11, 3], [5, 4, 9], [1, 7, 2]] as const) {
      const values = Float32Array.from({ length: width * height }, () => random() * 2 - 1), expected = new Float32Array(values.length);
      for (let z = 0; z < height; z++) for (let x = 0; x < width; x++) {
        let low = Infinity;
        for (let j = Math.max(0, z - r); j <= Math.min(height - 1, z + r); j++) for (let i = Math.max(0, x - r); i <= Math.min(width - 1, x + r); i++) low = Math.min(low, values[j * width + i]!);
        expected[z * width + x] = low;
      }
      minimumFilter(values, width, height, r);
      expect(Array.from(values)).toEqual(Array.from(expected));
    }
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

  it("gives a raft thinner than the layer spacing a waterline wherever the water meets it", () => {
    setup();
    // Layers at -0.7, -0.23, 0.23 and 0.7 m: the 0.3 m raft floats between the middle two without crossing either.
    const raft = MeshBuilder.CreateBox("raft", { width: 1.4, height: 0.3, depth: 1 }, scene);
    raft.position.set(0, -0.075, 0);
    frame();
    const field = new WaterContactField(scene, flatSurface(scene, 0.7));
    field.update(0);
    // Its hull is the waterline at the water heights it spans (and the layers either side), its deck is inside.
    for (const height of [-0.2, 0, 0.05]) {
      expect(Math.abs(contactAt(field, 0.72, 0, height))).toBeLessThan(0.1);
      expect(contactAt(field, 0, 0, height)).toBeLessThan(0);
    }
    // A crest well above it no longer meets it.
    expect(contactAt(field, 0.72, 0, 0.7)).toBeGreaterThan(0.25);
    field.dispose();
  });

  it("re-cuts objects for a surface moving every frame at most every 150 ms, landing its last pose", () => {
    setup();
    MeshBuilder.CreateBox("post", { width: 1, height: 4, depth: 1 }, scene);
    frame();
    const surface = flatSurface(scene, 0.3), field = new WaterContactField(scene, surface);
    expect(field.update(0)).toBe(true);
    // A tide raising the water 2 cm a frame for a quarter of a second at 60 frames per second.
    let rebuilds = 0, now = 0;
    for (let i = 0; i < 15; i++) {
      now += 1000 / 60; surface.mesh.position.y += 0.02; surface.mesh.computeWorldMatrix(true); frame();
      if (field.update(now)) rebuilds++;
    }
    expect(rebuilds).toBe(1);
    // Once it stops, the last pose lands within the interval.
    now += 150; frame();
    expect(field.update(now)).toBe(true);
    frame();
    expect(field.update(now + 150)).toBe(false);
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

  it("follows thin instances that move after their placements were cached", () => {
    setup();
    const posts = MeshBuilder.CreateBox("posts", { width: 1, height: 4, depth: 1 }, scene);
    const matrices = new Float32Array(32);
    Matrix.Translation(-5, 0, 0).copyToArray(matrices, 0);
    Matrix.Translation(5, 0, 0).copyToArray(matrices, 16);
    posts.thinInstanceSetBuffer("matrix", matrices, 16, false);
    frame();
    const field = new WaterContactField(scene, flatSurface(scene, 0.5));
    field.update(0);
    // A static forest is reused between scans...
    field.update(150);
    expect(Math.abs(contactAt(field, 5.52, 0, 0))).toBeLessThan(0.1);
    // ...until an instance moves.
    const placement = Matrix.Translation(9, 0, 0);
    posts.thinInstanceSetMatrixAt(1, placement);
    frame();
    field.update(300);
    expect(Math.abs(contactAt(field, 9.52, 0, 0))).toBeLessThan(0.1);
    expect(contactAt(field, 5.52, 0, 0)).toBeGreaterThan(1.9);
    expect(Math.abs(contactAt(field, -4.48, 0, 0))).toBeLessThan(0.1);
    // Babylon keeps the Matrix it was given: one reused for the next placement still moves the instance.
    Matrix.TranslationToRef(13, 0, 0, placement);
    posts.thinInstanceSetMatrixAt(1, placement);
    frame();
    field.update(450);
    expect(Math.abs(contactAt(field, 13.52, 0, 0))).toBeLessThan(0.1);
    expect(contactAt(field, 9.52, 0, 0)).toBeGreaterThan(1.9);
    field.dispose();
  });

  it("re-slices a mesh whose vertices are rewritten in place under a fixed transform, like a simulated cable", () => {
    setup();
    const strip = MeshBuilder.CreateBox("cable", { width: 0.4, height: 4, depth: 0.4, updatable: true }, scene);
    frame();
    const field = new WaterContactField(scene, flatSurface(scene, 0.3));
    field.update(0);
    expect(Math.abs(contactAt(field, 0.25, 0, 0))).toBeLessThan(0.1);
    const positions = strip.getVerticesData(VertexBuffer.PositionKind)!;
    for (let i = 0; i < positions.length; i += 3) positions[i] = positions[i]! + 3;
    strip.updateVerticesData(VertexBuffer.PositionKind, positions, true);
    frame();
    // Between scene scans, within a moving object's rebuild interval.
    field.update(50);
    expect(Math.abs(contactAt(field, 3.25, 0, 0))).toBeLessThan(0.1);
    expect(contactAt(field, 0.25, 0, 0)).toBeGreaterThan(1.9);
    field.dispose();
  });

  it("cuts an object on a sloped river at the rest height beneath each part of it", () => {
    setup();
    // A river falling 2 m over 20 m along Z (rest height -z / 10) and a 16 m log along it, 1 m tall around y = 0. Its
    // waves' envelope is about half a metre (contact layers about ±0.19 m around rest), so the log's ends sit clear of them.
    const water = { ...createDefaultWaterDefinition(), waveHeight: 0.21 };
    const river = createWaterMesh(scene, "river", normalizeWaterBody({ points: [[0, 1, -10], [0, -1, 10]], width: 6 }, "river"), water, builtInWaterMaterial(scene));
    const log = MeshBuilder.CreateBox("log", { width: 1, height: 1, depth: 16 }, scene);
    frame();
    const contacts = contactsOf(river);
    contacts.update(1000, true);
    // Mid-river the water crosses the log's sides...
    expect(Math.abs(contactAt(contacts, 0.55, 0, 0))).toBeLessThan(0.15);
    // ...upstream its end lies fully under the raised water, and downstream it stands clear above it: its top (or
    // bottom) face, a quarter of a metre from the water there (more than a layer spacing of the wave envelope), and its
    // waterline a metre and a half away do not count as near.
    expect(contactAt(contacts, 0.55, -7.5, 0)).toBeGreaterThan(1);
    expect(contactAt(contacts, 0.55, 7.5, 0)).toBeGreaterThan(1);
    // The sloping water crosses its horizontal top: the layer a third of the envelope below rest meets it near z = -5.4.
    expect(Math.abs(layers(contacts, 0, -5.4)[1]!)).toBeLessThan(0.15);
    log.dispose();
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
    const lake = createWaterMesh(scene, "lake", normalizeWaterBody({ width: 30, length: 30, waveScale: 1 }), { ...createDefaultWaterDefinition(), waveHeight: 1 }, builtInWaterMaterial(scene));
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

  it("slices a moving object again only once some point of it moved a quarter cell, so its bobbing costs no rebuild", () => {
    setup();
    // High keeps 1024 cells, so a cell is 15 cm and a placement waits for 3.75 cm of movement.
    updateSceneRenderingSettings(scene, { quality: normalizeRenderingQuality(qualityPresetPatch("high")) });
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const post = MeshBuilder.CreateBox("post", { width: 1, height: 6, depth: 1 }, scene);
    frame();
    const lake = createWaterMesh(scene, "lake", normalizeWaterBody({ width: 30, length: 30 }), createDefaultWaterDefinition(), builtInWaterMaterial(scene));
    const contacts = contactsOf(lake);
    const step = () => { frame(); clock += 50; updateSceneWater(scene); };
    step();
    const uploads = vi.spyOn(engine, "updateRawTexture");
    // Two, then three centimetres from where it was cut: short of the tolerance, so nothing rebuilds and the waterline
    // stays where it was cut.
    post.position.x = 0.02;
    step();
    post.position.x = 0.03;
    step();
    expect(uploads).not.toHaveBeenCalled();
    expect(Math.abs(contactAt(contacts, 0.5, 0, 0))).toBeLessThan(0.1);
    // Five centimetres passes it: the post is cut where it is now.
    post.position.x = 0.05;
    step();
    expect(uploads).toHaveBeenCalled();
    expect(Math.abs(contactAt(contacts, 0.55, 0, 0))).toBeLessThan(0.1);
  });

  it("caps the contact texture at the project's Contact Resolution and rebuilds it when that changes", () => {
    setup();
    // Two posts far apart need more cells than the lower caps allow at the finest cell size.
    for (const x of [-60, 60]) MeshBuilder.CreateBox(`post ${x}`, { width: 1, height: 6, depth: 1 }, scene).position.x = x;
    frame();
    const ocean = createWaterMesh(scene, "ocean", normalizeWaterBody({ width: 200, length: 40 }, "ocean"), createDefaultWaterDefinition(), builtInWaterMaterial(scene));
    const contacts = contactsOf(ocean);
    const side = (level: QualityLevel) => {
      updateSceneRenderingSettings(scene, { quality: normalizeRenderingQuality(qualityPresetPatch(level)) });
      // The new cells come in over frames, within the contact budget.
      updateSceneWater(scene);
      for (let i = 0; i < 20 && contacts.queued > 0; i++) { frame(); updateSceneWater(scene); }
      expect(contacts.queued).toBe(0);
      return Math.max(view(contacts).width, view(contacts).height);
    };
    // High allows 1024 cells per side; Low's 256 coarsens the cells instead of growing the texture.
    const high = side("high"), low = side("low");
    expect(high).toBeGreaterThan(512);
    expect(high).toBeLessThanOrEqual(1024);
    expect(low).toBeLessThanOrEqual(256);
    // Both waterlines survive the coarser cells.
    for (const x of [-60, 60]) expect(Math.abs(contactAt(contacts, x + 0.55, 0, 0))).toBeLessThan(0.5);
  });
});

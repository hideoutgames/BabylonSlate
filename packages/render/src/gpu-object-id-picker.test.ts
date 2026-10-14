import {
  Camera,
  Constants,
  FreeCamera,
  HemisphericLight,
  MaterialHelperGeometryRendering,
  Matrix,
  MeshBuilder,
  NullEngine,
  RawTexture,
  Scene,
  StandardMaterial,
  Vector3,
  type AbstractMesh,
  type Mesh,
} from "@babylonjs/core";
import { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { adaptNullEngineFrameGraph } from "./framegraph-test-fixtures";
import { gpuPickMesh, pickPixelProjection } from "./gpu-object-id-picker";
import { markSceneReadinessDirty } from "./scene-readiness-signal";

const WIDTH = 240;
const HEIGHT = 160;

/** Top-down `scene.pick` pixel coordinates of a projected point. */
function canvasPixel(ndc: Vector3) {
  return { x: ((ndc.x + 1) / 2) * WIDTH, y: ((1 - ndc.y) / 2) * HEIGHT };
}

describe("pickPixelProjection", () => {
  const projections = {
    perspective: Matrix.PerspectiveFovLH(0.8, WIDTH / HEIGHT, 0.1, 100),
    orthographic: Matrix.OrthoOffCenterLH(-3, 3, -2, 2, 0.1, 30),
  };

  for (const [mode, projection] of Object.entries(projections)) {
    it(`maps only the tapped ${mode} pixel onto the 1×1 target with unchanged depth`, () => {
      // View-space points near the corners and edges of the frame, off pixel boundaries.
      const points = [
        new Vector3(-2.951, 1.971, 7), new Vector3(2.961, -1.983, 7.5),
        new Vector3(2.903, 1.953, 7.2), new Vector3(-2.968, -0.41, 6.8), new Vector3(0.31, -1.991, 7),
      ];
      for (const point of points) {
        const ndc = Vector3.TransformCoordinates(point, projection);
        const pixel = canvasPixel(ndc);
        const px = Math.floor(pixel.x);
        const py = Math.floor(pixel.y);
        expect(px).toBeGreaterThanOrEqual(0);
        expect(px).toBeLessThan(WIDTH);
        expect(py).toBeGreaterThanOrEqual(0);
        expect(py).toBeLessThan(HEIGHT);

        const picked = Vector3.TransformCoordinates(point, pickPixelProjection(projection, px, py, WIDTH, HEIGHT));
        // Position within the tapped pixel becomes position within the target.
        expect(picked.x).toBeCloseTo(2 * (pixel.x - px - 0.5), 4);
        expect(picked.y).toBeCloseTo(-2 * (pixel.y - py - 0.5), 4);
        expect(Math.abs(picked.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(picked.y)).toBeLessThanOrEqual(1);
        expect(picked.z).toBeCloseTo(ndc.z, 6);

        // Neighbouring pixels fall outside the target.
        const right = Vector3.TransformCoordinates(point, pickPixelProjection(projection, px - 1, py, WIDTH, HEIGHT));
        const below = Vector3.TransformCoordinates(point, pickPixelProjection(projection, px, py - 1, WIDTH, HEIGHT));
        expect(right.x).toBeGreaterThan(1);
        expect(below.y).toBeLessThan(-1);
      }
    });
  }
});

const disposers: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (disposers.length) disposers.pop()!();
});

/**
 * A Scene with three pickable boxes (ids 1-3 in creation order) on an engine
 * that can build the pick graph headless. The one GPU boundary, the 1×1
 * read-back, returns whatever id `hit` names.
 */
function pickFixture() {
  const engine = adaptNullEngineFrameGraph(new NullEngine({
    renderWidth: WIDTH,
    renderHeight: HEIGHT,
    textureSize: 4,
    deterministicLockstep: false,
    lockstepMaxSteps: 1,
  }));
  Object.assign(engine.getCaps(), { maxDrawBuffers: 4, drawBuffersExtension: true });
  const scene = new Scene(engine);
  const camera = new FreeCamera("camera", new Vector3(0, 0, -8), scene);
  camera.setTarget(Vector3.Zero());
  scene.activeCamera = camera;
  const meshes = ["Left", "Middle", "Right"].map((name, index) => {
    const mesh = MeshBuilder.CreateBox(name, {}, scene);
    mesh.position.x = (index - 1) * 2;
    mesh.material = new StandardMaterial(`${name} Material`, scene);
    return mesh;
  });
  scene.updateTransformMatrix();
  let id = 0;
  const writeHit = (buffer: ArrayBufferView) => {
    (buffer as Uint8Array).set([(id >> 16) & 255, (id >> 8) & 255, id & 255]);
    return buffer;
  };
  const readback = vi.spyOn(engine, "_readTexturePixels")
    .mockImplementation(async (_texture, _width, _height, _face, _level, buffer) => writeHit(buffer!));
  disposers.push(() => { scene.dispose(); engine.dispose(); });
  return {
    engine, scene, camera, meshes, readback, writeHit,
    hit: (value: number) => { id = value; },
    tap: () => gpuPickMesh(scene, WIDTH / 2, HEIGHT / 2),
    /**
     * Live render pass ids of the pick graph: its object renderer and that
     * renderer's depth-peeling helper. A leaked or rebuilt graph changes them.
     */
    livePickPassIds: () => engine.getRenderPassNames().flatMap((name, id) =>
      name?.startsWith("GPU Pick") || name?.startsWith("DepthPeelingRenderer") ? [id] : []),
  };
}
type PickFixture = ReturnType<typeof pickFixture>;

/** Strict readiness probes (`mesh.isReady(true)`) each mesh receives; drawing only asks `isReady(false)`. */
function probeTracker(meshes: readonly AbstractMesh[]) {
  const spies = new Map<AbstractMesh, MockInstance<AbstractMesh["isReady"]>>();
  const watch = (mesh: AbstractMesh) => { spies.set(mesh, vi.spyOn(mesh, "isReady")); };
  meshes.forEach(watch);
  const strict = (mesh: AbstractMesh) => spies.get(mesh)!.mock.calls.filter(([complete]) => complete === true).length;
  return {
    watch,
    async probedDuring(action: () => Promise<unknown>) {
      const before = new Map([...spies.keys()].map((mesh) => [mesh, strict(mesh)]));
      await action();
      return [...spies.keys()].filter((mesh) => strict(mesh) > before.get(mesh)!).map((mesh) => mesh.name);
    },
  };
}

describe("gpuPickMesh", () => {
  it("serves every tap from one persistent pass instead of building and leaking one per tap", async () => {
    const f = pickFixture();
    f.hit(2);
    expect((await f.tap())?.name).toBe("Middle");
    const built = f.livePickPassIds();
    expect(built.length).toBeGreaterThan(0);
    for (let tap = 0; tap < 2; tap += 1) expect((await f.tap())?.name).toBe("Middle");
    f.hit(0);
    expect(await f.tap()).toBeNull();
    expect(f.livePickPassIds()).toEqual(built);
    expect(f.scene.objectRenderers).toHaveLength(1);
  });

  it("writes ids for the current tap's pickable meshes, with a LOD level reporting its master", async () => {
    const f = pickFixture();
    const lod = MeshBuilder.CreateBox("Middle LOD", {}, f.scene);
    lod.isPickable = false;
    f.meshes[1]!.addLODLevel(20, lod);
    const [left, middle, right] = f.meshes as [Mesh, Mesh, Mesh];
    f.hit(3);
    expect((await f.tap())?.name).toBe("Right");
    const renderPassId = f.scene.objectRenderers[0]!.renderPassId;
    const written = (mesh: AbstractMesh) =>
      MaterialHelperGeometryRendering.GetConfiguration(renderPassId)!.objectIdProvider!(mesh);
    expect([left, middle, right, lod].map(written)).toEqual([1, 2, 3, 2]);

    // The persistent pass must not keep the previous tap's numbering.
    left.dispose();
    f.hit(1);
    expect((await f.tap())?.name).toBe("Middle");
    expect([middle, right, lod].map(written)).toEqual([1, 2, 1]);
  });

  it("answers overlapping taps one at a time, each with its own read-back", async () => {
    const f = pickFixture();
    const execute = FrameGraph.prototype.execute;
    let awaitingReadback = 0;
    let deepest = 0;
    vi.spyOn(FrameGraph.prototype, "execute").mockImplementation(function (this: FrameGraph) {
      execute.call(this);
      deepest = Math.max(deepest, ++awaitingReadback);
    });
    const hits = [1, 3, 2];
    let read = 0;
    f.readback.mockImplementation(async (_texture, _width, _height, _face, _level, buffer) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      awaitingReadback -= 1;
      f.hit(hits[read++]!);
      return f.writeHit(buffer!);
    });
    const results = await Promise.all([f.tap(), f.tap(), f.tap()]);
    expect(results.map((mesh) => mesh?.name)).toEqual(["Left", "Right", "Middle"]);
    // A second pass drawn before the first read-back would overwrite the shared 1×1 texel.
    expect(deepest).toBe(1);
  });

  describe("readiness", () => {
    const all = ["Left", "Middle", "Right"];
    const changes: Array<{
      name: string;
      before?: (f: PickFixture) => void;
      change: (f: PickFixture, probes: ReturnType<typeof probeTracker>) => void;
      probed: string[];
    }> = [
      { name: "nothing changes", change: () => {}, probed: [] },
      {
        name: "a mesh is added",
        change: (f, probes) => {
          const extra = MeshBuilder.CreateBox("Extra", {}, f.scene);
          extra.material = new StandardMaterial("Extra Material", f.scene);
          probes.watch(extra);
        },
        probed: ["Extra"],
      },
      {
        name: "a mesh first becomes pickable",
        before: (f) => { f.meshes[0]!.isPickable = false; },
        change: (f) => { f.meshes[0]!.isPickable = true; },
        probed: ["Left"],
      },
      {
        name: "a mesh swaps its material",
        change: (f) => { f.meshes[1]!.material = new StandardMaterial("Swapped", f.scene); },
        probed: ["Middle"],
      },
      { name: "the project marks rendering definitions dirty", change: (f) => markSceneReadinessDirty(f.scene), probed: all },
      {
        name: "a mesh gains thin instances",
        change: (f) => { f.meshes[1]!.thinInstanceAdd(Matrix.Identity()); },
        probed: ["Middle"],
      },
      { name: "a light is added", change: (f) => { new HemisphericLight("Sun", Vector3.Up(), f.scene); }, probed: all },
      {
        name: "a light is disabled",
        before: (f) => { new HemisphericLight("Sun", Vector3.Up(), f.scene); },
        change: (f) => { f.scene.getLightByName("Sun")!.setEnabled(false); },
        probed: all,
      },
      {
        name: "a texture is added",
        change: (f) => { new RawTexture(new Uint8Array(4), 1, 1, Constants.TEXTUREFORMAT_RGBA, f.scene); },
        probed: all,
      },
      { name: "the camera switches projection", change: (f) => { f.camera.mode = Camera.ORTHOGRAPHIC_CAMERA; }, probed: all },
    ];

    it.each(changes)("re-probes only what needs it when $name", async ({ before, change, probed }) => {
      const f = pickFixture();
      before?.(f);
      const probes = probeTracker(f.meshes);
      f.hit(2);
      await f.tap();
      expect(await probes.probedDuring(async () => { await f.tap(); })).toEqual([]);
      change(f, probes);
      expect(await probes.probedDuring(async () => { await f.tap(); })).toEqual(probed);
      // And the tap after that is steady again.
      expect(await probes.probedDuring(async () => { await f.tap(); })).toEqual([]);
    });

    it("answers undefined for the CPU fallback when a mesh is not ready in time, then recovers on the same pass", async () => {
      const f = pickFixture();
      let now = 1_000;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      // Each strict probe of the stuck mesh costs 600 ms of the one-second budget.
      const stuck = vi.spyOn(f.meshes[1]!, "isReady").mockImplementation(() => { now += 600; return false; });
      f.hit(1);
      expect(await f.tap()).toBeUndefined();
      const built = f.livePickPassIds();
      expect(built.length).toBeGreaterThan(0);
      stuck.mockRestore();
      expect((await f.tap())?.name).toBe("Left");
      expect(f.livePickPassIds()).toEqual(built);
      expect(f.scene.objectRenderers).toHaveLength(1);
    });
  });

  describe("lifecycle", () => {
    it("falls back to the CPU ray after a failed read-back and rebuilds without leaking the failed pass", async () => {
      const f = pickFixture();
      f.readback.mockRejectedValueOnce(new Error("device lost"));
      expect(await f.tap()).toBeUndefined();
      expect(f.livePickPassIds()).toEqual([]);
      f.hit(2);
      expect((await f.tap())?.name).toBe("Middle");
      expect(f.livePickPassIds().length).toBeGreaterThan(0);
      expect(f.scene.objectRenderers).toHaveLength(1);
    });

    it("releases the pass with the scene", async () => {
      const f = pickFixture();
      f.hit(1);
      await f.tap();
      expect(f.livePickPassIds().length).toBeGreaterThan(0);
      f.scene.dispose();
      expect(f.livePickPassIds()).toEqual([]);
      expect(f.scene.objectRenderers).toHaveLength(0);
    });

    it("releases a pass whose scene is disposed while it is still building", async () => {
      const f = pickFixture();
      const build = FrameGraph.prototype.buildAsync;
      vi.spyOn(FrameGraph.prototype, "buildAsync").mockImplementation(async function (this: FrameGraph, waitForReadiness) {
        f.scene.dispose();
        return build.call(this, waitForReadiness);
      });
      f.hit(1);
      expect(await f.tap()).toBeUndefined();
      expect(f.livePickPassIds()).toEqual([]);
      expect(f.scene.objectRenderers).toHaveLength(0);
    });
  });
});

import {
  Camera,
  Constants,
  FreeCamera,
  HemisphericLight,
  MaterialHelperGeometryRendering,
  Matrix,
  Mesh,
  MeshBuilder,
  MorphTargetManager,
  NullEngine,
  RawTexture,
  Scene,
  Skeleton,
  StandardMaterial,
  Vector3,
  VertexBuffer,
  Viewport,
  type AbstractMesh,
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
 * that can build the pick graph headless. The boxes stand one behind another
 * on the centre pixel's ray, so each reaches the tap unless a test moves it.
 * The one GPU boundary, the 1×1 read-back, returns whatever id `hit` names.
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
    mesh.position.z = (index - 1) * 2;
    mesh.computeWorldMatrix(true);
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
  // CPU fallbacks are reported through console.warn; keep the test log clean and let tests read what was said.
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  disposers.push(() => { scene.dispose(); engine.dispose(); });
  return {
    engine, scene, camera, meshes, readback, writeHit, warn,
    hit: (value: number) => { id = value; },
    tap: () => gpuPickMesh(scene, WIDTH / 2, HEIGHT / 2),
    /** Babylon re-reads a world matrix once per render id and nothing here renders, so moving a mesh recomputes it. */
    place: (mesh: AbstractMesh, x: number) => { mesh.position.x = x; mesh.computeWorldMatrix(true); },
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

/**
 * Replace the 1×1 read-back with what the GPU would write: the id of the mesh nearest the camera
 * that actually reached a draw call in the pick pass. A mesh the pass skips (its variant is not
 * ready when drawn) leaves whatever lies behind it, which is how a stale mesh makes a tap select
 * the wrong actor. Each execution also records the view matrices the pass drew through.
 */
function readBackNearestDrawn(f: PickFixture) {
  const executions: Array<{ drawn: Mesh[]; views: Matrix[] }> = [];
  let current: { drawn: Mesh[]; views: Matrix[] } | undefined;
  const execute = FrameGraph.prototype.execute;
  vi.spyOn(FrameGraph.prototype, "execute").mockImplementation(function (this: FrameGraph) {
    current = { drawn: [], views: [] };
    executions.push(current);
    try { execute.call(this); } finally { current = undefined; }
  });
  const draw = Mesh.prototype._draw;
  vi.spyOn(Mesh.prototype, "_draw").mockImplementation(function (this: Mesh, subMesh, fillMode, instancesCount) {
    current?.drawn.push(this);
    return draw.call(this, subMesh, fillMode, instancesCount);
  });
  const setTransform = Scene.prototype.setTransformMatrix;
  vi.spyOn(Scene.prototype, "setTransformMatrix").mockImplementation(function (this: Scene, view, projection, ...rest) {
    if (current) current.views.push(view.clone());
    return setTransform.call(this, view, projection, ...rest);
  });
  f.readback.mockImplementation(async (_texture, _width, _height, _face, _level, buffer) => {
    const reach = (mesh: Mesh) => Vector3.Distance(f.camera.position, mesh.getAbsolutePosition());
    const nearest = [...(executions.at(-1)?.drawn ?? [])].sort((a, b) => reach(a) - reach(b))[0];
    f.hit(nearest ? f.meshes.indexOf(nearest) + 1 : 0);
    return f.writeHit(buffer!);
  });
  return executions;
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
        change: (f) => {
          f.engine.getCaps().instancedArrays = true; // NullEngine reports none; thin instances need it.
          f.meshes[1]!.thinInstanceAdd(Matrix.Identity());
        },
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

  describe("candidates", () => {
    /** Names of the meshes each pick pass draws, read once the graph has executed. */
    function drawnLists(f: PickFixture) {
      const drawn: string[][] = [];
      const execute = FrameGraph.prototype.execute;
      vi.spyOn(FrameGraph.prototype, "execute").mockImplementation(function (this: FrameGraph) {
        execute.call(this);
        drawn.push((f.scene.objectRenderers[0]!.renderList ?? []).map((mesh) => mesh.name));
      });
      return drawn;
    }

    it("draws and probes only the meshes that can reach the tapped pixel", async () => {
      const f = pickFixture();
      f.place(f.meshes[0]!, -3);
      f.place(f.meshes[2]!, 3);
      const probes = probeTracker(f.meshes);
      const drawn = drawnLists(f);
      f.hit(2);
      const picks: Array<AbstractMesh | null | undefined> = [];
      expect(await probes.probedDuring(async () => { picks.push(await f.tap()); })).toEqual(["Middle"]);
      // Ids still number every pickable mesh, so the read-back id keeps its meaning.
      expect(picks.map((mesh) => mesh?.name)).toEqual(["Middle"]);
      expect(drawn).toEqual([["Middle"]]);
    });

    it("answers a tap on empty space without building or drawing a pass", async () => {
      const f = pickFixture();
      for (const mesh of f.meshes) f.place(mesh, 3);
      const drawn = drawnLists(f);
      expect(await f.tap()).toBeNull();
      expect(drawn).toEqual([]);
      expect(f.livePickPassIds()).toEqual([]);
    });

    it("still draws a displaced mesh whose static bounds miss the pixel, and finds its hit", async () => {
      const f = pickFixture();
      const displaced = f.meshes[2]!;
      f.place(displaced, 3);
      displaced.material!.metadata = { boundsPadding: 1 };
      f.place(f.meshes[0]!, -3);
      const drawn = drawnLists(f);
      f.hit(3);
      expect((await f.tap())?.name).toBe("Right");
      expect(drawn).toEqual([["Middle", "Right"]]);
    });

    describe("a mesh that outlasts the readiness wait", () => {
      function stuckMiddle(f: PickFixture) {
        let now = 1_000;
        vi.spyOn(performance, "now").mockImplementation(() => now);
        const middle = f.meshes[1]!;
        const stuckMaterial = middle.material;
        // Each strict probe costs 600 ms of the one-second budget, until the material is replaced.
        const probe = vi.spyOn(middle, "isReady").mockImplementation(() => {
          if (middle.material !== stuckMaterial) return true;
          now += 600;
          return false;
        });
        return { middle, probe, sleeps: vi.spyOn(globalThis, "setTimeout") };
      }
      /** How often the readiness wait slept between polls. */
      const pollSleeps = (sleeps: { mock: { calls: readonly (readonly unknown[])[] } }) => sleeps.mock.calls.filter((call) => call[1] === 16).length;

      it("takes the CPU ray at once on the next tap that needs it, without waiting again", async () => {
        const f = pickFixture();
        const { probe, sleeps } = stuckMiddle(f);
        expect(await f.tap()).toBeUndefined();
        const waited = pollSleeps(sleeps);
        const probed = probe.mock.calls.length;
        expect(waited).toBeGreaterThan(0);
        expect(await f.tap()).toBeUndefined();
        expect(pollSleeps(sleeps)).toBe(waited);
        // One probe, to notice if it became ready meanwhile.
        expect(probe.mock.calls.length - probed).toBeGreaterThan(0);
        expect(probe.mock.calls.length - probed).toBeLessThan(probed);
      });

      it("is waited for again, not skipped, once its material changes", async () => {
        const f = pickFixture();
        const { middle, probe } = stuckMiddle(f);
        expect(await f.tap()).toBeUndefined();
        const probed = probe.mock.calls.length;
        middle.material = new StandardMaterial("Replacement", f.scene);
        f.hit(2);
        expect((await f.tap())?.name).toBe("Middle");
        expect(probe.mock.calls.length).toBeGreaterThan(probed);
      });

      it("recovers on the next tap when it became ready by itself", async () => {
        const f = pickFixture();
        const { probe } = stuckMiddle(f);
        expect(await f.tap()).toBeUndefined();
        probe.mockRestore();
        f.hit(1);
        expect((await f.tap())?.name).toBe("Left");
      });

      it("does not hold up taps whose pixel it cannot reach", async () => {
        const f = pickFixture();
        const left = f.meshes[0]!;
        f.place(left, -3);
        vi.spyOn(left, "isReady").mockReturnValue(false);
        f.hit(2);
        expect((await f.tap())?.name).toBe("Middle");
      });
    });
  });

  describe("a mesh changed in place after the pass drew it", () => {
    /**
     * Babylon recompiles a changed material's variant asynchronously and a draw skips the mesh
     * until it lands. Two not-ready answers after each change stand in for that wait.
     */
    function recompilesAfterChange(mesh: Mesh) {
      const material = mesh.material!;
      const isReady = material.isReadyForSubMesh.bind(material);
      let pending = 0;
      vi.spyOn(material, "isReadyForSubMesh").mockImplementation((...args) => {
        if (pending === 0) return isReady(...args);
        pending -= 1;
        return false;
      });
      return () => { pending = 2; };
    }
    const changes: Array<[string, (f: PickFixture, mesh: Mesh) => void]> = [
      ["a define-changing markDirty", (_f, mesh) => mesh.material!.markDirty(true)],
      ["a skeleton is assigned", (f, mesh) => { mesh.skeleton = new Skeleton("rig", "rig", f.scene); }],
      ["a morph target manager is assigned", (f, mesh) => { mesh.morphTargetManager = new MorphTargetManager(f.scene); }],
      ["its vertex layout changes", (_f, mesh) => { mesh.setVerticesData(VertexBuffer.ColorKind, new Float32Array(mesh.getTotalVertices() * 4).fill(1)); }],
    ];

    it.each(changes)("is still the mesh a tap selects after %s", async (_name, change) => {
      const f = pickFixture();
      readBackNearestDrawn(f);
      const front = f.meshes[0]!;
      const recompile = recompilesAfterChange(front);
      expect((await f.tap())?.name).toBe("Left");
      expect((await f.tap())?.name).toBe("Left");
      change(f, front);
      recompile();
      // The mesh in front must still win: the tap may not draw around it and select what lies behind.
      expect((await f.tap())?.name).toBe("Left");
    });
  });

  describe("a tap made while an earlier one is still waiting", () => {
    it("projects through the camera it was made with, not the one that has moved since", async () => {
      const f = pickFixture();
      const executions = readBackNearestDrawn(f);
      const material = f.meshes[0]!.material!;
      const isReady = material.isReadyForSubMesh.bind(material);
      let released = false;
      vi.spyOn(material, "isReadyForSubMesh").mockImplementation((...args) => released && isReady(...args));
      const original = f.camera.getViewMatrix().clone();
      const first = f.tap();
      // The first tap is now polling for the front mesh.
      await new Promise((resolve) => setTimeout(resolve, 80));
      f.camera.position.z -= 4;
      const moved = f.camera.getViewMatrix(true).clone();
      const second = f.tap();
      released = true;
      expect((await Promise.all([first, second])).map((mesh) => mesh?.name)).toEqual(["Left", "Left"]);
      expect(original.equals(moved)).toBe(false);
      expect(executions).toHaveLength(2);
      expect(executions[0]!.views.length).toBeGreaterThan(0);
      expect(executions[0]!.views.every((view) => view.equals(original))).toBe(true);
      expect(executions[1]!.views.length).toBeGreaterThan(0);
      expect(executions[1]!.views.every((view) => view.equals(moved))).toBe(true);
    });
  });

  describe("falling back to the CPU ray", () => {
    /** A clock the test owns, started far from every other test's so the rate limit never carries over. */
    let epoch = 0;
    function ownClock() {
      epoch += 1e9;
      let now = epoch;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      return { advance: (ms: number) => { now += ms; } };
    }
    const said = (f: PickFixture) => f.warn.mock.calls.map((call) => String(call[0]));

    it("says which mesh was not ready in time", async () => {
      const f = pickFixture();
      const clock = ownClock();
      vi.spyOn(f.meshes[1]!, "isReady").mockImplementation(() => { clock.advance(600); return false; });
      expect(await f.tap()).toBeUndefined();
      expect(said(f)).toHaveLength(1);
      expect(said(f)[0]).toMatch(/not ready/i);
      expect(said(f)[0]).toContain("Middle");
    });

    it("says why a failed read-back fell back", async () => {
      const f = pickFixture();
      ownClock();
      f.readback.mockRejectedValueOnce(new Error("device lost"));
      expect(await f.tap()).toBeUndefined();
      expect(said(f)).toHaveLength(1);
      expect(said(f)[0]).toContain("device lost");
    });

    it("says when the camera viewport is not full-frame", async () => {
      const f = pickFixture();
      ownClock();
      f.camera.viewport = new Viewport(0, 0, 0.5, 1);
      expect(await f.tap()).toBeUndefined();
      expect(said(f)).toHaveLength(1);
      expect(said(f)[0]).toMatch(/viewport/i);
    });

    it("says when a mesh that timed out earlier lies under the pixel", async () => {
      const f = pickFixture();
      const clock = ownClock();
      vi.spyOn(f.meshes[1]!, "isReady").mockImplementation(() => { clock.advance(600); return false; });
      expect(await f.tap()).toBeUndefined();
      clock.advance(10_000);
      expect(await f.tap()).toBeUndefined();
      expect(said(f)).toHaveLength(2);
      expect(said(f)[1]).toMatch(/earlier/i);
      expect(said(f)[1]).toContain("Middle");
    });

    it("reports a repeated cause once per interval", async () => {
      const f = pickFixture();
      const clock = ownClock();
      f.readback.mockRejectedValue(new Error("device lost"));
      await f.tap();
      clock.advance(100);
      await f.tap();
      expect(said(f)).toHaveLength(1);
      clock.advance(60_000);
      await f.tap();
      expect(said(f)).toHaveLength(2);
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

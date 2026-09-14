import { afterEach, expect, it, vi } from "vitest";
import {
  Constants,
  FreeCamera,
  NullEngine,
  Scene,
  Vector3,
} from "@babylonjs/core";
import { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import { FrameGraphObjectRendererTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/objectRendererTask";
import type { FrameGraphTask } from "@babylonjs/core/FrameGraph/frameGraphTask";
import { FrameGraphClearTextureTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/clearTextureTask";
import { FrameGraphCopyToBackbufferColorTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/copyToBackbufferColorTask";
import { createDefaultMaterialDocument } from "@babylonslate/shader-graph";
import { MaterialLibrary } from "./material-library";
import { prepareScenePostProcessPlan } from "./scene-post-process-plan";
import {
  createScenePostProcessGraph,
  type ScenePostProcessGraph,
} from "./scene-post-process-graph";
import {
  beginManagedRenderAllocation,
  limitManagedRenderBytes,
  managedRenderReservations,
} from "./managed-render-resources";
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
  vi.restoreAllMocks();
});

function document(resource?: "sceneDepth" | "sceneNormal") {
  const doc = createDefaultMaterialDocument("Post Process", "postProcess");
  doc.nodes.push(
    {
      id: "gain",
      type: "param.float",
      properties: { name: "Gain", value: [0.5] },
      position: { x: 0, y: 0 },
    },
    {
      id: "gain-mul",
      type: "math.multiply",
      properties: {},
      position: { x: 0, y: 0 },
    },
  );
  doc.edges = doc.edges.filter((edge) => edge.id !== "e-scene-output");
  doc.edges.push(
    {
      id: "scene-gain",
      sourceNodeId: "sceneColor",
      sourcePinId: "color",
      targetNodeId: "gain-mul",
      targetPinId: "a",
    },
    {
      id: "gain-value",
      sourceNodeId: "gain",
      sourcePinId: "out",
      targetNodeId: "gain-mul",
      targetPinId: "b",
    },
  );
  let output = "gain-mul";
  if (resource) {
    doc.nodes.push(
      {
        id: "buffer",
        type: `input.${resource}`,
        properties: {},
        position: { x: 0, y: 0 },
      },
      {
        id: "multiply",
        type: "math.multiply",
        properties: {},
        position: { x: 0, y: 0 },
      },
    );
    doc.edges.push({
      id: "uv",
      sourceNodeId: "screenUv",
      sourcePinId: "uv",
      targetNodeId: "buffer",
      targetPinId: "uv",
    });
    if (resource === "sceneNormal") {
      doc.nodes.push({
        id: "split",
        type: "vector.split",
        properties: {},
        position: { x: 0, y: 0 },
      });
      doc.edges.push({
        id: "normal-split",
        sourceNodeId: "buffer",
        sourcePinId: "normal",
        targetNodeId: "split",
        targetPinId: "value",
      });
    }
    doc.edges.push(
      {
        id: "buffer-mul",
        sourceNodeId: resource === "sceneDepth" ? "buffer" : "split",
        sourcePinId: resource === "sceneDepth" ? "depth" : "x",
        targetNodeId: "multiply",
        targetPinId: "a",
      },
      {
        id: "scene-mul",
        sourceNodeId: "gain-mul",
        sourcePinId: "out",
        targetNodeId: "multiply",
        targetPinId: "b",
      },
    );
    output = "multiply";
  }
  doc.edges.push({
    id: "out",
    sourceNodeId: output,
    sourcePinId: "out",
    targetNodeId: "output",
    targetPinId: "color",
  });
  return doc;
}
function host(bytes?: number) {
  const engine = new NullEngine({
    renderWidth: 16,
    renderHeight: 8,
    textureSize: 16,
    deterministicLockstep: false,
    lockstepMaxSteps: 4,
  });
  Object.assign(engine.getCaps(), {
    maxTextureSize: 4096,
    maxDrawBuffers: 4,
    drawBuffersExtension: true,
    depthTextureExtension: true,
    textureFloatRender: true,
    textureHalfFloatRender: true,
  });
  if (bytes !== undefined) limitManagedRenderBytes(engine, bytes);
  // Preserve native graph/material/texture ownership. NullEngine only lacks the
  // WebGL FrameGraph allocation and MRT layout boundaries.
  vi.spyOn(engine, "_createInternalTexture").mockImplementation(
    (size, options) => {
      const creation = typeof options === "object" ? options : {};
      const wrapper = engine.createRenderTargetTexture(size, {
        ...creation,
        generateDepthBuffer: false,
      });
      const texture = wrapper.texture!;
      texture.format = creation.format ?? Constants.TEXTUREFORMAT_RGBA;
      wrapper.dispose(true);
      return texture;
    },
  );
  vi.spyOn(engine, "createMultipleRenderTarget").mockImplementation((size) =>
    engine._createHardwareRenderTargetWrapper(true, false, size),
  );
  vi.spyOn(engine, "buildTextureLayout").mockImplementation((enabled) =>
    enabled.map((value, index) => (value ? 0x8ce0 + index : 0)),
  );
  const scene = new Scene(engine);
  const camera = new FreeCamera("camera", new Vector3(0, 0, -2), scene);
  scene.activeCamera = camera;
  const library = new MaterialLibrary();
  const graph = new FrameGraph(scene);
  let owned: ScenePostProcessGraph | null = null;
  const callerTasks: FrameGraphTask[] = [];
  const disposeGraph = () => {
    owned?.disposeTasks();
    for (const task of callerTasks.splice(0)) task.dispose();
    graph.dispose();
  };
  const retire = async () => {
    disposeGraph();
    if (owned) {
      await owned.whenDisposed();
      await owned.releaseAfterGraphDisposal();
    }
  };
  cleanup.push(async () => {
    if (!engine.isDisposed) await retire();
    library.dispose();
    scene.dispose();
    engine.dispose();
  });
  const create = (
    plan: ReturnType<typeof prepareScenePostProcessPlan>,
    resolutionScale = 1,
  ) => {
    const result = createScenePostProcessGraph({
      frameGraph: graph,
      library,
      camera,
      width: 16,
      height: 8,
      plan,
      resolutionScale,
    });
    owned = result.owner ?? null;
    return result;
  };
  const connect = (owner: ScenePostProcessGraph) => {
    const mainClear = new FrameGraphClearTextureTask("Scene source", graph);
    mainClear.targetTexture = owner.sceneColorTexture;
    mainClear.depthTexture = owner.depthTexture;
    graph.addTask(mainClear);
    callerTasks.push(mainClear);
    for (const task of owner.geometryTasks) graph.addTask(task);
    const objects = new FrameGraphObjectRendererTask(
      "Scene surfaces",
      graph,
      scene,
    );
    objects.camera = camera;
    objects.objectList = { meshes: [], particleSystems: [] };
    objects.targetTexture = mainClear.outputTexture;
    objects.depthTexture = mainClear.outputDepthTexture;
    graph.addTask(objects);
    callerTasks.push(objects);
    for (const task of owner.postProcessTasks) graph.addTask(task);
    const present = new FrameGraphCopyToBackbufferColorTask("Present", graph);
    present.sourceTexture = owner.outputTexture;
    graph.addTask(present);
    callerTasks.push(present);
  };
  return {
    engine,
    scene,
    camera,
    graph,
    library,
    create,
    connect,
    retire,
    disposeGraph,
  };
}
function successful(
  result: ReturnType<typeof createScenePostProcessGraph>,
): ScenePostProcessGraph {
  expect(result.ok).toBe(true);
  expect(result.owner).toBeTruthy();
  return result.owner!;
}

it("creates no auxiliary resources or Material instances for a disabled stack", () => {
  const h = host(0);
  const plan = prepareScenePostProcessPlan(
    h.library,
    [{ id: "disabled", materialGuid: "unused", order: 0, enabled: false }],
    () => {
      throw new Error("Disabled document loaded");
    },
  );
  const declare = vi.spyOn(h.graph.textureManager, "createRenderTargetTexture");
  const acquire = vi.spyOn(h.library, "acquire");
  expect(h.create(plan)).toEqual({ ok: true, owner: null });
  expect(declare).not.toHaveBeenCalled();
  expect(acquire).not.toHaveBeenCalled();
  expect(managedRenderReservations(h.engine).reservedBytes).toBe(0);
});

it("rejects unsupported depth and a constrained replacement before declaring targets", () => {
  const h = host(1024);
  const plan = prepareScenePostProcessPlan(
    h.library,
    [{ id: "depth", materialGuid: "depth", order: 0, enabled: true }],
    () => document("sceneDepth"),
  );
  const declare = vi.spyOn(h.graph.textureManager, "createRenderTargetTexture");
  h.engine.getCaps().textureFloatRender = false;
  h.engine.getCaps().textureHalfFloatRender = false;
  expect(h.create(plan)).toMatchObject({
    ok: false,
    reason: expect.stringMatching(/float/),
  });
  h.engine.getCaps().textureHalfFloatRender = true;
  expect(h.create(plan)).toMatchObject({
    ok: false,
    reason: expect.stringMatching(/reservation/),
  });
  expect(declare).not.toHaveBeenCalled();
  expect(managedRenderReservations(h.engine).reservedBytes).toBe(0);
});

it("shares one demanded geometry set and isolated Z, reconciles every output, and scales only opted-in passes", async () => {
  const h = host();
  const plan = prepareScenePostProcessPlan(
    h.library,
    [
      {
        id: "normal",
        materialGuid: "normal",
        enabled: true,
        order: 2,
        scalable: true,
      },
      { id: "depth", materialGuid: "depth", enabled: true, order: 0 },
    ],
    (guid) => document(guid === "depth" ? "sceneDepth" : "sceneNormal"),
  );
  const owner = successful(h.create(plan, 0.5));
  // 3 full-resolution RGBA8 targets (scene, normal, first pass), 2 Z targets,
  // RGBA32F normalized depth, and one 8x4 RGBA8 scalable output.
  expect(owner.estimatedBytes).toBe(4736);
  expect(managedRenderReservations(h.engine).pendingBytes).toBe(4736);
  expect(owner.geometryTask!.textureDescriptions).toHaveLength(2);
  expect(owner.geometryTask!.depthTexture).not.toBe(owner.depthTexture);
  expect(h.graph.tasks).toEqual([]); // Caller controls ordering around surfaces.
  h.connect(owner);
  await h.graph.buildAsync();
  owner.reconcile();
  const textures = h.graph.textureManager;
  expect(
    textures.getTextureDescription(owner.sceneColorTexture).options.types,
  ).toEqual([Constants.TEXTURETYPE_UNSIGNED_BYTE]);
  expect(
    textures.getTextureDescription(owner.postProcessTasks[0]!.outputTexture)
      .size,
  ).toEqual({ width: 16, height: 8 });
  expect(textures.getTextureDescription(owner.outputTexture).size).toEqual({
    width: 8,
    height: 4,
  });
  expect(
    textures.getTextureFromHandle(
      owner.geometryTask!.geometryNormViewDepthTexture,
    )!.type,
  ).toBe(Constants.TEXTURETYPE_FLOAT);
  const totals = managedRenderReservations(h.engine);
  expect(totals.pendingBytes).toBe(0);
  expect(totals.reservedBytes).toBeLessThanOrEqual(4736);
  expect(totals.categoryBytes.geometry).toBe(2560);
  expect(totals.categoryBytes.depth).toBe(1024);
  expect(() => owner.releaseAfterGraphDisposal()).toThrow(/Dispose/);
  await h.retire();
  expect(managedRenderReservations(h.engine).reservedBytes).toBe(0);
});

it("keeps duplicate entry parameters independent and resets the saved value without an asset mutation", async () => {
  const h = host();
  const source = document();
  const before = structuredClone(source);
  const plan = prepareScenePostProcessPlan(
    h.library,
    [
      {
        id: "first",
        materialGuid: "same",
        enabled: true,
        order: 0,
        parameters: { Gain: { kind: "float", value: 0.25 } },
      },
      { id: "second", materialGuid: "same", enabled: true, order: 1 },
    ],
    () => source,
  );
  const owner = successful(h.create(plan));
  h.connect(owner);
  await h.graph.buildAsync();
  owner.reconcile();
  expect(owner.geometryTask).toBeNull();
  expect(owner.geometryTasks).toEqual([]);
  expect(
    owner.setParameter("first", "Gain", { kind: "float", value: 0.75 }),
  ).toBe(true);
  expect(owner.getParameter("first", "Gain")).toEqual({
    kind: "float",
    value: 0.75,
  });
  expect(owner.getParameter("second", "Gain")).toEqual({
    kind: "float",
    value: 0.5,
  });
  expect(owner.resetParameter("first", "Gain")).toBe(true);
  expect(owner.getParameter("first", "Gain")).toEqual({
    kind: "float",
    value: 0.25,
  });
  expect(
    owner.setParameter("missing", "Gain", { kind: "float", value: 0.2 }),
  ).toBe(false);
  expect(source).toEqual(before);
  owner.disposeTasks();
  expect(owner.setParameter("first", "Gain", { kind: "float", value: 1 })).toBe(
    false,
  );
  expect(owner.getParameter("first", "Gain")).toBeNull();
});

it("retains a failed actual allocation's reservation until the caller disposes the partial graph", async () => {
  const h = host(2048);
  const plan = prepareScenePostProcessPlan(
    h.library,
    [{ id: "one", materialGuid: "one", enabled: true, order: 0 }],
    () => document(),
  );
  const allocate = h.engine._createInternalTexture;
  vi.spyOn(h.engine, "_createInternalTexture").mockImplementationOnce(
    (size, options, ...rest) =>
      allocate.call(h.engine, { width: 64, height: 8 }, options, ...rest),
  );
  const owner = successful(h.create(plan));
  h.connect(owner);
  await h.graph.buildAsync();
  expect(() => owner.reconcile()).toThrow(/reserved peak/);
  expect(managedRenderReservations(h.engine)).toMatchObject({
    pendingBytes: 1536,
    resourceBytes: 0,
  });
  expect(beginManagedRenderAllocation(h.engine, 513)).toBeUndefined();
  await h.retire();
  expect(managedRenderReservations(h.engine).reservedBytes).toBe(0);
});

it("retains a partial construction owner and refuses a stale plan without allocations", async () => {
  const h = host();
  const source = document();
  const plan = prepareScenePostProcessPlan(
    h.library,
    [{ id: "one", materialGuid: "one", enabled: true, order: 0 }],
    () => source,
  );
  const original = h.graph.textureManager.createRenderTargetTexture.bind(
    h.graph.textureManager,
  );
  const declare = vi
    .spyOn(h.graph.textureManager, "createRenderTargetTexture")
    .mockImplementationOnce((...args) => original(...args))
    .mockImplementationOnce(() => {
      throw new Error("Backend declaration failed");
    });
  const failed = h.create(plan);
  expect(failed).toMatchObject({
    ok: false,
    reason: "Backend declaration failed",
  });
  expect(failed.owner).toBeTruthy();
  expect(managedRenderReservations(h.engine).pendingBytes).toBe(1536);
  await h.retire();
  expect(managedRenderReservations(h.engine).reservedBytes).toBe(0);
  declare.mockRestore();
  const other = host();
  plan.entries[0]!.document.nodes.find(
    (node) => node.id === "gain",
  )!.properties.value = [0.9];
  const changed = vi.spyOn(
    other.graph.textureManager,
    "createRenderTargetTexture",
  );
  expect(other.create(plan)).toMatchObject({
    ok: false,
    reason: expect.stringMatching(/plan changed/),
  });
  expect(changed).not.toHaveBeenCalled();
});

it.each(["released", "uncertain"] as const)(
  "retains the graph reservation through %s task retirement independently of GPU frame drain",
  async (outcome) => {
    const h = host(2048);
    const plan = prepareScenePostProcessPlan(
      h.library,
      [{ id: "one", materialGuid: "one", enabled: true, order: 0 }],
      () => document(),
    );
    const owner = successful(h.create(plan));
    h.connect(owner);
    await h.graph.buildAsync();
    owner.reconcile();
    const task = owner.postProcessTasks[0]!;
    const nativeRetirement = task.whenDisposed.bind(task);
    let resolveNative!: () => void;
    let rejectNative!: (error: Error) => void;
    const native = new Promise<void>((resolve, reject) => {
      resolveNative = resolve;
      rejectNative = reject;
    });
    // Keep the real task disposal, but control its asynchronous native boundary.
    vi.spyOn(task, "whenDisposed").mockImplementation(() =>
      nativeRetirement().then(() => native),
    );
    Object.defineProperty(h.engine, "isWebGPU", { get: () => true });
    h.disposeGraph();
    const cpu = owner.whenDisposed();
    const gpu = owner.releaseAfterGraphDisposal();
    void cpu.catch(() => {});
    void gpu.catch(() => {});
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      h.engine.endFrame();
      expect(managedRenderReservations(h.engine).reservedBytes).toBeGreaterThan(
        0,
      );
      expect(beginManagedRenderAllocation(h.engine, 2048)).toBeUndefined();
      if (outcome === "uncertain") {
        rejectNative(new Error("Native retirement deadline"));
        await expect(cpu).rejects.toThrow("Native retirement deadline");
        await expect(gpu).rejects.toThrow("Native retirement deadline");
        h.engine.endFrame();
        expect(
          managedRenderReservations(h.engine).reservedBytes,
        ).toBeGreaterThan(0);
      } else {
        resolveNative();
        await cpu;
        expect(
          managedRenderReservations(h.engine).reservedBytes,
        ).toBeGreaterThan(0);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        h.engine.endFrame();
        await gpu;
        expect(managedRenderReservations(h.engine).reservedBytes).toBe(0);
      }
    } finally {
      resolveNative();
      h.engine.dispose();
    }
  },
);

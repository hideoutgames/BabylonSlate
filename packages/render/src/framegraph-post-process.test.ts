import { afterEach, expect, it, vi } from "vitest";
import {
  NullEngine,
  Scene,
  Texture,
  RawTexture,
  InputBlock,
  NodeMaterial,
  Effect,
} from "@babylonjs/core";
import { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import type { WebGLPipelineContext } from "@babylonjs/core/Engines/WebGL/webGLPipelineContext";
import { FrameGraphCopyToBackbufferColorTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/copyToBackbufferColorTask";
import {
  createDefaultMaterialDocument,
  createDefaultMaterialFunctionDocument,
  type MaterialDocument,
} from "@babylonslate/shader-graph";
import { MaterialLibrary } from "./material-library";
import { addAuthoredPostProcessTasks } from "./framegraph-post-process";
import type { PostProcessStackDiagnostic } from "./post-process-material";

const dispose: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (dispose.length) dispose.pop()!();
});

function gainDocument() {
  const doc = createDefaultMaterialDocument("Gain", "postProcess");
  doc.nodes.push(
    {
      id: "gain",
      type: "param.float",
      properties: { name: "Gain", value: [0.5] },
      position: { x: 0, y: 0 },
    },
    {
      id: "multiply",
      type: "math.multiply",
      properties: {},
      position: { x: 0, y: 0 },
    },
  );
  doc.edges = doc.edges.filter((edge) => edge.id !== "e-scene-output");
  doc.edges.push(
    {
      id: "color-mul",
      sourceNodeId: "sceneColor",
      sourcePinId: "color",
      targetNodeId: "multiply",
      targetPinId: "a",
    },
    {
      id: "gain-mul",
      sourceNodeId: "gain",
      sourcePinId: "out",
      targetNodeId: "multiply",
      targetPinId: "b",
    },
    {
      id: "mul-output",
      sourceNodeId: "multiply",
      sourcePinId: "out",
      targetNodeId: "output",
      targetPinId: "color",
    },
  );
  return doc;
}

function textureDocument() {
  const document = gainDocument();
  document.nodes = document.nodes.map((node) =>
    node.id === "gain"
      ? { ...node, type: "texture.sample", properties: { textureGuid: "mask" } }
      : node,
  );
  document.edges = document.edges.map((edge) =>
    edge.sourceNodeId === "gain" ? { ...edge, sourcePinId: "rgba" } : edge,
  );
  document.edges.push({
    id: "uv-mask",
    sourceNodeId: "screenUv",
    sourcePinId: "uv",
    targetNodeId: "gain",
    targetPinId: "uv",
  });
  return document;
}

function host(
  documents: Array<MaterialDocument | null>,
  functions = {},
  disabled: number[] = [],
  parameters: Array<Record<string, import("@babylonslate/core").MaterialParameterValue>> = [],
) {
  const engine = new NullEngine({
    renderWidth: 16,
    renderHeight: 16,
    textureSize: 16,
    deterministicLockstep: false,
    lockstepMaxSteps: 4,
  });
  const scene = new Scene(engine);
  // Babylon 9.20 NullEngine has no FrameGraph allocation overrides. Adapt only
  // those hardware boundaries, retaining real textures, wrappers and refcounts.
  vi.spyOn(engine, "_createInternalTexture").mockImplementation(
    (size, options) => {
      const wrapper = engine.createRenderTargetTexture(size, {
        ...(typeof options === "object" ? options : {}),
        generateDepthBuffer: false,
      });
      const texture = wrapper.texture!;
      texture.format = typeof options === "object" ? (options.format ?? 5) : 5;
      wrapper.dispose(true);
      return texture;
    },
  );
  vi.spyOn(engine, "createMultipleRenderTarget").mockImplementation((size) =>
    engine._createHardwareRenderTargetWrapper(true, false, size),
  );
  const source = RawTexture.CreateRGBATexture(
    new Uint8Array(16 * 16 * 4).fill(128),
    16,
    16,
    scene,
    false,
    false,
    Texture.NEAREST_SAMPLINGMODE,
  );
  // NullEngine creates the raw storage but never completes a GPU upload.
  source.getInternalTexture()!.isReady = true;
  const resolveTexture = vi.fn(() => source);
  const library = new MaterialLibrary({
    functions: () => functions,
    resolveTexture,
  });
  const graph = new FrameGraph(scene);
  const sourceTexture = graph.textureManager.importTexture(
    "Scene Color",
    source.getInternalTexture()!,
  );
  const diagnostics: PostProcessStackDiagnostic[] = [];
  const stack = addAuthoredPostProcessTasks({
    frameGraph: graph,
    library,
    sourceTexture,
    stack: documents.map((_, order) => ({
      materialGuid: String(order),
      order,
      enabled: !disabled.includes(order),
      parameters: parameters[order],
    })),
    documentFor: (guid) => documents[Number(guid)]!,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  const present = new FrameGraphCopyToBackbufferColorTask("Present", graph);
  present.sourceTexture = stack.outputTexture;
  graph.addTask(present);
  dispose.push(() => {
    stack.dispose();
    graph.dispose();
    library.dispose();
    scene.dispose();
    engine.dispose();
  });
  return {
    engine,
    scene,
    graph,
    library,
    source,
    resolveTexture,
    diagnostics,
    ...stack,
  };
}

it("runs real authored apply bindings with independent per-entry parameters and no legacy targets", async () => {
  const { graph, tasks, engine, scene, diagnostics } = host([
    gainDocument(),
    gainDocument(),
  ]);
  const allocate = vi.spyOn(engine, "createRenderTargetTexture");
  await Promise.all(tasks.map((task) => task.initAsync()));
  expect(allocate).not.toHaveBeenCalled();
  expect(scene.postProcesses).toHaveLength(0);
  expect(engine.postProcesses).toHaveLength(2);
  await graph.buildAsync();
  expect(tasks[0]!.setParameter("Gain", { kind: "float", value: 0.25 })).toBe(
    true,
  );
  const writes = engine.postProcesses.map((pass) =>
    vi.spyOn(pass.getEffect(), "setFloat"),
  );
  graph.execute();
  expect(writes[0]!.mock.calls.some(([, value]) => value === 0.25)).toBe(true);
  expect(writes[1]!.mock.calls.some(([, value]) => value === 0.5)).toBe(true);
  expect(tasks[0]!.getParameter("Gain")).toEqual({ kind: "float", value: 0.25 });
  expect(tasks[0]!.resetParameter("Gain")).toBe(true);
  writes[0]!.mockClear();
  graph.execute();
  expect(writes[0]!.mock.calls.some(([, value]) => value === 0.5)).toBe(true);
  expect(diagnostics).toEqual([]);
});

it("waits for its attached GPU effect and preserves a downstream pass after a binding failure", async () => {
  const { graph, tasks, engine, diagnostics } = host([
    gainDocument(),
    gainDocument(),
  ]);
  await graph.buildAsync();
  const [broken, downstream] = engine.postProcesses;
  const ready = vi.spyOn(broken!.getEffect(), "isReady").mockReturnValue(false);
  expect(graph.isReady()).toBe(false);
  ready.mockRestore();
  broken!.onApplyObservable.add(() => {
    throw new Error("Authored binding failed");
  });
  const applied = vi.fn();
  downstream!.onApplyObservable.add(applied);
  engine.setDepthWrite(true);
  expect(() => graph.execute()).not.toThrow();
  expect(applied).toHaveBeenCalledOnce();
  expect(engine.getDepthWrite()).toBe(true);
  expect(diagnostics).toEqual([
    expect.objectContaining({
      materialGuid: "0",
      message: expect.stringContaining("Authored binding failed"),
    }),
  ]);
  graph.execute();
  expect(applied).toHaveBeenCalledTimes(2);
  expect(tasks[0]!.isReady()).toBe(true);
  expect(diagnostics).toHaveLength(1);
});

it("rejects transitive logical depth before compiling or allocating a legacy renderer", async () => {
  const inner = createDefaultMaterialFunctionDocument("Depth Function");
  inner.inputs = [];
  inner.outputs = [{ id: "out_depth", name: "Depth", type: "float" }];
  inner.nodes.push(
    {
      id: "uv",
      type: "input.screenUv",
      properties: {},
      position: { x: 0, y: 0 },
    },
    {
      id: "depth",
      type: "input.sceneDepth",
      properties: {},
      position: { x: 0, y: 0 },
    },
  );
  inner.edges = [
    {
      id: "uv-depth",
      sourceNodeId: "uv",
      sourcePinId: "uv",
      targetNodeId: "depth",
      targetPinId: "uv",
    },
    {
      id: "depth-out",
      sourceNodeId: "depth",
      sourcePinId: "depth",
      targetNodeId: "outputs",
      targetPinId: "out_depth",
    },
  ];
  const doc = gainDocument();
  doc.nodes = doc.nodes.map((node) =>
    node.id === "gain"
      ? {
          ...node,
          type: "function.call",
          properties: { functionGuid: "inner" },
        }
      : node,
  );
  doc.edges = doc.edges.map((edge) =>
    edge.sourceNodeId === "gain" ? { ...edge, sourcePinId: "out_depth" } : edge,
  );
  const { graph, scene, engine, diagnostics, tasks } = host(
    [doc, gainDocument()],
    { inner },
  );
  const build = vi.spyOn(NodeMaterial.prototype, "build");
  await graph.buildAsync();
  expect(diagnostics).toEqual([
    expect.objectContaining({
      code: "material.framegraph.buffer",
      nodeId: "gain/depth",
    }),
  ]);
  expect(scene.prePassRenderer).toBeFalsy();
  expect(engine.postProcesses).toHaveLength(1);
  expect(tasks.every((task) => task.isReady())).toBe(true);
  expect(build.mock.calls.length).toBeLessThanOrEqual(1);
});

it("hot rebuilds without retaining old apply callbacks and ignores queued updates after disposal", async () => {
  const {
    graph,
    tasks,
    engine,
    scene,
    dispose: disposeStack,
  } = host([gainDocument()]);
  await graph.buildAsync();
  const oldPass = engine.postProcesses[0]!;
  expect(tasks[0]!.setParameter("Gain", { kind: "float", value: 0.75 })).toBe(
    true,
  );
  const revised = gainDocument();
  revised.name = "Revised Gain";
  await tasks[0]!.replaceDocument(revised);
  await graph.whenReadyAsync();
  expect(engine.postProcesses).toHaveLength(1);
  expect(engine.postProcesses[0]).not.toBe(oldPass);
  expect(oldPass.onApplyObservable.hasObservers()).toBe(false);
  const material = scene.materials.find(
    (entry) => entry instanceof NodeMaterial,
  ) as NodeMaterial;
  expect(
    material.attachedBlocks.find((block) => block.name === "gain"),
  ).toBeInstanceOf(InputBlock);
  expect(
    (
      material.attachedBlocks.find(
        (block) => block.name === "gain",
      ) as InputBlock
    ).value,
  ).toBe(0.75);
  const create = vi.spyOn(engine, "createEffect");
  const calls = create.mock.calls.length;
  oldPass.updateEffect();
  expect(create).toHaveBeenCalledTimes(calls);
  disposeStack();
  expect(engine.postProcesses).toHaveLength(0);
  expect(
    scene.materials.filter((entry) => entry instanceof NodeMaterial),
  ).toHaveLength(0);
});

it("disposal during deferred graph compilation cannot attach a late pass", async () => {
  const { tasks, engine, scene } = host([gainDocument()]);
  const pending = tasks[0]!.initAsync();
  tasks[0]!.dispose();
  await pending;
  expect(engine.postProcesses).toHaveLength(0);
  expect(
    scene.materials.filter((material) => material instanceof NodeMaterial),
  ).toHaveLength(0);
});

it.each(["replace", "dispose"] as const)(
  "%s before GPU compilation completes stops native polling without retiring the ready sibling",
  async (action) => {
    vi.useFakeTimers();
    try {
      const { engine, graph, tasks, diagnostics } = host([gainDocument(), gainDocument()]);
      const preparePipeline = engine._preparePipelineContextAsync.bind(engine);
      let pendingPipeline: WebGLPipelineContext | undefined;
      vi.spyOn(engine, "_preparePipelineContextAsync").mockImplementation((...args) => {
        const pipeline = args[0] as WebGLPipelineContext;
        // The graph also compiles its own copy Effect. Delay an authored pass,
        // identified by its actual native key, instead of whichever compiles first.
        if (!pendingPipeline && engine.postProcesses.some((pass) =>
          pass.getEffect()?.key.replace(/\r/g, "").replace(/\n/g, "|") === pipeline._name)) {
          pendingPipeline = pipeline;
          pipeline.isParallelCompiled = true;
        }
        return preparePipeline(...args);
      });
      let deletedProgramQueries = 0;
      // Retain native Effect, pipeline, retry timer and disposal. NullEngine has
      // no GPU compiler; only its driver's pending-completion query is supplied.
      vi.spyOn(engine, "_isRenderingStateCompiled").mockImplementation((pipeline) => {
        if ((pipeline as WebGLPipelineContext)._isDisposed) deletedProgramQueries++;
        return false;
      });
      await graph.buildAsync(false);
      await vi.waitFor(() => expect(pendingPipeline).toBeDefined());
      const retiringPass = engine.postProcesses.find((pass) => pass.getEffect().getPipelineContext() === pendingPipeline)!;
      const retiring = retiringPass.getEffect();
      const sibling = engine.postProcesses.find((pass) => pass !== retiringPass)!;
      const task = tasks.find((candidate) => candidate.name === retiringPass.name)!;
      const errors = vi.fn();
      retiring.onErrorObservable.add(errors);
      await vi.waitFor(() => expect(sibling.getEffect().isReady()).toBe(true));
      expect(retiring.isReady()).toBe(false);
      const applied = vi.fn();
      sibling.onApplyObservable.add(applied);

      if (action === "replace") await task.replaceDocument(gainDocument());
      else task.dispose();
      expect(retiring.isDisposed).toBe(true);
      await vi.advanceTimersByTimeAsync(32);
      expect(deletedProgramQueries).toBe(0);
      expect(errors).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(graph.isReady()).toBe(true);
      graph.execute();
      expect(applied).toHaveBeenCalledOnce();
      expect(sibling.getEffect().isDisposed).toBe(false);
      expect(diagnostics).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  },
);

it("waits for an authored texture and copies through a terminal texture failure", async () => {
  const { graph, source, diagnostics, engine } = host([
    textureDocument(),
    gainDocument(),
  ]);
  await graph.buildAsync();
  vi.spyOn(source, "isReady").mockReturnValue(false);
  expect(graph.isReady()).toBe(false);
  vi.spyOn(source, "loadingError", "get").mockReturnValue(true);
  expect(graph.isReady()).toBe(true);
  const downstream = vi.fn();
  engine.postProcesses[1]!.onApplyObservable.add(downstream);
  expect(() => graph.execute()).not.toThrow();
  expect(downstream).toHaveBeenCalledOnce();
  expect(diagnostics).toEqual([
    expect.objectContaining({
      materialGuid: "0",
      message: expect.stringContaining("failed to load"),
    }),
  ]);
});

it("releases owned shader sources while a sibling graph remains usable", async () => {
  const before = new Set(Object.keys(Effect.ShadersStore));
  const first = host([gainDocument()]);
  await first.graph.buildAsync();
  const owned = Object.keys(Effect.ShadersStore).filter(
    (key) => !before.has(key) && key.startsWith("material:"),
  );
  expect(owned).toHaveLength(2);
  const sibling = host([gainDocument()]);
  await sibling.graph.buildAsync();
  const applied = vi.fn();
  sibling.engine.postProcesses[0]!.onApplyObservable.add(applied);
  first.dispose();
  expect(owned.filter((key) => Effect.ShadersStore[key] !== undefined)).toEqual(
    [],
  );
  expect(sibling.graph.isReady()).toBe(true);
  sibling.graph.execute();
  expect(applied).toHaveBeenCalledOnce();
});

it("admits no disabled material and preserves overrides across disable and re-enable", async () => {
  const before = new Set(Object.keys(Effect.ShadersStore));
  const { graph, tasks, engine, scene, diagnostics, resolveTexture } = host(
    [gainDocument(), null, textureDocument()],
    {},
    [0, 1, 2],
  );
  await graph.buildAsync();
  expect(engine.postProcesses).toHaveLength(0);
  expect(
    scene.materials.filter((material) => material instanceof NodeMaterial),
  ).toHaveLength(0);
  expect(
    Object.keys(Effect.ShadersStore).filter(
      (key) => !before.has(key) && key.startsWith("material:"),
    ),
  ).toEqual([]);
  expect(diagnostics).toEqual([]);
  expect(resolveTexture).not.toHaveBeenCalled();
  const task = tasks[0]!;
  expect(task.setParameter("Gain", { kind: "float", value: 0.75 })).toBe(true);
  expect(task.setParameter("Unknown", { kind: "float", value: 0.75 })).toBe(
    false,
  );
  task.disabled = false;
  expect(task.isReady()).toBe(false);
  await task.initAsync();
  await graph.whenReadyAsync();
  const oldPass = engine.postProcesses[0]!;
  const writes = vi.spyOn(oldPass.getEffect(), "setFloat");
  graph.execute();
  expect(writes.mock.calls.some(([, value]) => value === 0.75)).toBe(true);
  const owned = Object.keys(Effect.ShadersStore).filter(
    (key) => !before.has(key) && key.startsWith("material:"),
  );
  expect(owned).toHaveLength(2);
  task.disabled = true;
  expect(task.isReady()).toBe(true);
  expect(engine.postProcesses).toHaveLength(0);
  expect(
    scene.materials.filter((material) => material instanceof NodeMaterial),
  ).toHaveLength(0);
  expect(owned.filter((key) => Effect.ShadersStore[key] !== undefined)).toEqual(
    [],
  );
  expect(task.setParameter("Gain", { kind: "float", value: 0.25 })).toBe(true);
  task.disabled = false;
  await task.initAsync();
  await graph.whenReadyAsync();
  expect(engine.postProcesses[0]).not.toBe(oldPass);
  const replay = vi.spyOn(engine.postProcesses[0]!.getEffect(), "setFloat");
  graph.execute();
  expect(replay.mock.calls.some(([, value]) => value === 0.25)).toBe(true);
  expect(diagnostics).toEqual([]);
});

it("resets to the owned authored entry override across disabled replay", async () => {
  const authored = { Gain: { kind: "float" as const, value: 0.2 } };
  const { graph, tasks, engine } = host([gainDocument()], {}, [], [authored]);
  await graph.buildAsync();
  const task = tasks[0]!;
  authored.Gain.value = 0.9;
  expect(task.setParameter("Gain", { kind: "float", value: 0.75 })).toBe(true);
  task.disabled = true;
  expect(task.resetParameter("Gain")).toBe(true);
  expect(task.getParameter("Gain")).toEqual({ kind: "float", value: 0.2 });
  task.disabled = false;
  await task.initAsync();
  await graph.whenReadyAsync();
  const writes = vi.spyOn(engine.postProcesses[0]!.getEffect(), "setFloat");
  graph.execute();
  expect(writes.mock.calls.some(([, value]) => value === 0.2)).toBe(true);
  task.dispose();
  expect(task.getParameter("Gain")).toBeNull();
  expect(task.resetParameter("Gain")).toBe(false);
});

it("cannot attach a late effect after disabling a pending acquisition", async () => {
  const { tasks, engine, scene, diagnostics } = host([gainDocument()]);
  const pending = tasks[0]!.initAsync();
  tasks[0]!.disabled = true;
  await pending;
  expect(tasks[0]!.isReady()).toBe(true);
  expect(engine.postProcesses).toHaveLength(0);
  expect(
    scene.materials.filter((material) => material instanceof NodeMaterial),
  ).toHaveLength(0);
  expect(diagnostics).toEqual([]);
});

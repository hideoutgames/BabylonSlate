import { afterEach, expect, it, vi } from "vitest";
import {
  NullEngine,
  Scene,
  Texture,
  RawTexture,
  InputBlock,
  NodeMaterial,
} from "@babylonjs/core";
import { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
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

function host(documents: Array<MaterialDocument | null>, functions = {}) {
  const engine = new NullEngine({
    renderWidth: 16,
    renderHeight: 16,
    textureSize: 16,
    deterministicLockstep: false,
    lockstepMaxSteps: 4,
  });
  const scene = new Scene(engine);
  const source = RawTexture.CreateRGBATexture(
    new Uint8Array(16 * 16 * 4).fill(128),
    16,
    16,
    scene,
    false,
    false,
    Texture.NEAREST_SAMPLINGMODE,
  );
  const library = new MaterialLibrary({ functions: () => functions });
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
      enabled: true,
    })),
    documentFor: (guid) => documents[Number(guid)]!,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  const present = new FrameGraphCopyToBackbufferColorTask("Present", graph);
  present.sourceTexture = stack.outputTexture;
  graph.addTask(present);
  dispose.push(() => {
    graph.dispose();
    library.dispose();
    scene.dispose();
    engine.dispose();
  });
  return { engine, scene, graph, library, source, diagnostics, ...stack };
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
  expect(scene.prePassRenderer).toBeNull();
  expect(engine.postProcesses).toHaveLength(1);
  expect(tasks.every((task) => task.isReady())).toBe(true);
  expect(build.mock.calls.length).toBeLessThanOrEqual(1);
});

it("hot rebuilds without retaining old apply callbacks and ignores queued updates after disposal", async () => {
  const { graph, tasks, engine, scene } = host([gainDocument()]);
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
  graph.dispose();
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

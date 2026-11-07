import { expect, it, vi } from "vitest";
import { InputBlock } from "@babylonjs/core/Materials/Node/Blocks/Input/inputBlock";
import { NodeMaterial } from "@babylonjs/core/Materials/Node/nodeMaterial";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { createEngine } from "@haptic/render";
import { adaptNullEngineFrameGraph } from "@haptic/render/framegraph-test-fixtures";
// The renderer draws lit surfaces on the light block, as a shipped Engine does.
import "@haptic/render/light-block-engine";
import { createInProcessRuntime } from "@haptic/runtime";
import { createActor, createDefaultScene } from "@haptic/core";
import {
  isPlayEngineCommandType,
  type CommandMessage,
} from "@haptic/bridge";
import {
  createDefaultMaterialDocument,
  buildMaterialParameterCatalog,
} from "@haptic/shader-graph";
import {
  compileGraph,
  type GraphNode,
  type LogicGraph,
} from "@haptic/scripting";
import { createDefaultNodeRegistry } from "@haptic/scripting-nodes";
import { playLoadControl } from "./play-physics";
import { runtimeOptionsFromLoadControl } from "@haptic/runtime";

/** Node's NullEngine needs the real view lifecycle, but no browser pixel surface. */
class Canvas extends EventTarget {
  width = 256;
  height = 256;
  clientWidth = 256;
  clientHeight = 256;
  style = { cursor: "", touchAction: "" };
  readonly drawImage = vi.fn();
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 256, height: 256 };
  }
  getContext(kind: string) {
    return kind === "2d" ? { clearRect() {}, drawImage: this.drawImage } : null;
  }
}

/** A post-process Material that multiplies the scene colour by its Gain parameter (0.5). */
function gainMaterial() {
  const material = createDefaultMaterialDocument("Gain", "postProcess");
  material.nodes.push(
    {
      id: "gain",
      type: "param.float",
      position: { x: 0, y: 0 },
      properties: { name: "Gain", value: [0.5] },
    },
    {
      id: "multiply",
      type: "math.multiply",
      position: { x: 0, y: 0 },
      properties: {},
    },
  );
  material.edges = material.edges.filter(
    (edge) => edge.id !== "e-scene-output",
  );
  material.edges.push(
    {
      id: "color",
      sourceNodeId: "sceneColor",
      sourcePinId: "color",
      targetNodeId: "multiply",
      targetPinId: "a",
    },
    {
      id: "gain",
      sourceNodeId: "gain",
      sourcePinId: "out",
      targetNodeId: "multiply",
      targetPinId: "b",
    },
    {
      id: "out",
      sourceNodeId: "multiply",
      sourcePinId: "out",
      targetNodeId: "output",
      targetPinId: "color",
    },
  );
  return material;
}

it("applies compiled gameplay entry reads, setters and resets through Play load metadata and the real renderer", async () => {
  // Real FrameGraph ownership; only absent NullEngine driver calls are adapted.
  const engine = adaptNullEngineFrameGraph(new NullEngine());
  Object.assign(engine.getCaps(), {
    maxTextureSize: 4096, maxDrawBuffers: 4, drawBuffersExtension: true,
    textureFloatRender: true, textureHalfFloatRender: true,
  });
  // Drive complete native frames explicitly, including the visible canvas copy.
  engine.customAnimationFrameRequester = {
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
  };
  vi.spyOn(engine, "getRenderingCanvas").mockReturnValue(
    new Canvas() as unknown as HTMLCanvasElement,
  );
  const material = gainMaterial();
  const materials = new Map([["post", material]]);
  const scene = createDefaultScene();
  scene.actors = [createActor("hero", "Hero", { classId: "Hero" })];
  scene.settings.postProcessStack = [
    {
      id: "first",
      materialGuid: "post",
      enabled: true,
      parameters: { Gain: { kind: "float", value: 0.25 } },
    },
    { id: "second", materialGuid: "post", enabled: true },
    { id: "disabled", materialGuid: "post", enabled: false },
  ];
  const before = structuredClone({ scene, material });
  const canvas = new Canvas();
  const handle = createEngine(canvas as unknown as HTMLCanvasElement, {
    sharedEngine: engine,
    playMode: true,
    materialDocuments: materials,
    postProcessStack: scene.settings.postProcessStack,
  });
  handle.setPaused(true);
  const commands: CommandMessage[] = [];
  const load = playLoadControl({
    sceneAssetGuid: "world",
    scene,
    materialParameterCatalog: buildMaterialParameterCatalog(materials),
    materialTextureAssetGuids: [],
  });
  const runtime = createInProcessRuntime({
    ...runtimeOptionsFromLoadControl(load),
    preferSoftwarePhysics: true,
    cooperativeSceneLoading: false,
    deferSceneLoadingPaint: false,
    onCommand: (command) => {
      commands.push(command);
      if (isPlayEngineCommandType(command.type)) handle.applyCommand(command);
    },
  });
  try {
    const registry = createDefaultNodeRegistry();
    const nodes: GraphNode[] = [];
    const edges: LogicGraph["edges"] = [];
    const node = (
      id: string,
      typeId: string,
      properties: Record<string, unknown> = {},
    ) =>
      nodes.push({
        id,
        typeId,
        properties,
        position: { x: 0, y: 0 },
        pins: registry.get(typeId)!.pins(properties),
      });
    const edge = (
      sourceNodeId: string,
      sourcePinId: string,
      targetNodeId: string,
      targetPinId: string,
    ) =>
      edges.push({
        id: `e${edges.length}`,
        sourceNodeId,
        sourcePinId,
        targetNodeId,
        targetPinId,
      });
    node("begin", "flow.event.beginPlay");
    node("scene", "gameInstance.getSceneReference");
    for (const id of ["first", "second", "disabled"]) {
      node(id, "material.getPostProcessEntry", { "default:entryId": id });
      edge("scene", "scene", id, "owner");
    }
    for (const [id, type, entry, value] of [
      ["write", "setFloat", "first", 0.8],
      ["copy", "setFloat", "second", 0],
      ["reset", "resetFloat", "first", 0],
      ["deferred", "setFloat", "disabled", 0.3],
    ] as const) {
      node(id, `material.${type}Parameter`, {
        "default:name": "Gain",
        "default:value": value,
      });
      edge(entry, "material", id, "material");
    }
    node("read", "material.getFloatParameter", { "default:name": "Gain" });
    edge("first", "material", "read", "material");
    edge("read", "value", "copy", "value");
    for (const [from, to] of [
      ["begin", "write"],
      ["write", "copy"],
      ["copy", "reset"],
      ["reset", "deferred"],
    ])
      edge(from!, "execOut", to!, "execIn");
    const graph = compileGraph(
      { id: "gameplay", kind: "event", nodes, edges },
      { assetGuid: "hero", registry },
    );
    await runtime.loadScripts([
      { ...graph, assetGuid: "hero", classId: "Hero", parentClassId: "Actor" },
    ]);
    runtime.realizePlayWorld();
    expect(
      commands.filter(
        (command) => command.type === "setPostProcessMaterialParameter",
      ),
    ).toEqual([]);
    handle.resize();
    await handle.prewarmSceneMaterials();
    const presentation = handle.presentFirstFrame();
    await vi.waitFor(() => {
      engine.beginFrame();
      engine._renderViews();
      engine.endFrame();
      expect(canvas.drawImage).toHaveBeenCalledOnce();
    });
    await presentation;
    runtime.notifySceneModelsReady("world", 1);
    const values = () =>
      handle.scene.materials
        .filter(
          (candidate): candidate is NodeMaterial =>
            candidate instanceof NodeMaterial &&
            candidate.name === "material:post",
        )
        .map(
          (candidate) => (candidate.getBlockByName("gain") as InputBlock).value,
        );
    expect(commands.filter((command) => command.type === "diagnostic")).toEqual(
      [],
    );
    expect(values()).toEqual([0.25, 0.8]);
    handle.setPostProcessStack(
      scene.settings.postProcessStack.map((entry) => ({
        ...entry,
        enabled: true,
      })),
    );
    // The coordinator materializes the replaced stack's graph passes on the
    // next preparation, not synchronously inside setPostProcessStack.
    await handle.prewarmSceneMaterials();
    expect(values()).toEqual([0.25, 0.8, 0.3]);
    expect({ scene, material }).toEqual(before);
  } finally {
    runtime.stop();
    handle.dispose();
    engine.dispose();
  }
});

it("runs the passes Register and Unregister Scene Post-Processing leave on the Scene, and the parameters set through the Pass output, through the real renderer", async () => {
  const engine = adaptNullEngineFrameGraph(new NullEngine());
  Object.assign(engine.getCaps(), {
    maxTextureSize: 4096, maxDrawBuffers: 4, drawBuffersExtension: true,
    textureFloatRender: true, textureHalfFloatRender: true,
  });
  engine.customAnimationFrameRequester = { requestAnimationFrame: () => 0, cancelAnimationFrame: () => {} };
  vi.spyOn(engine, "getRenderingCanvas").mockReturnValue(new Canvas() as unknown as HTMLCanvasElement);
  const materials = new Map([
    ["tint", createDefaultMaterialDocument("Tint", "postProcess")],
    ["gain", gainMaterial()],
  ]);
  const scene = createDefaultScene();
  scene.actors = [createActor("hero", "Hero", { classId: "Hero" })];
  const canvas = new Canvas();
  const handle = createEngine(canvas as unknown as HTMLCanvasElement, {
    sharedEngine: engine, playMode: true, materialDocuments: materials, postProcessStack: [],
  });
  handle.setPaused(true);
  const load = playLoadControl({
    sceneAssetGuid: "world", scene, materialParameterCatalog: buildMaterialParameterCatalog(materials), materialTextureAssetGuids: [],
  });
  const commands: CommandMessage[] = [];
  const runtime = createInProcessRuntime({
    ...runtimeOptionsFromLoadControl(load),
    preferSoftwarePhysics: true,
    cooperativeSceneLoading: false,
    deferSceneLoadingPaint: false,
    onCommand: (command) => {
      commands.push(command);
      if (isPlayEngineCommandType(command.type)) handle.applyCommand(command);
    },
  });
  try {
    const registry = createDefaultNodeRegistry();
    const node = (id: string, typeId: string, properties: Record<string, unknown> = {}): GraphNode =>
      ({ id, typeId, properties, position: { x: 0, y: 0 }, pins: registry.get(typeId)!.pins(properties) });
    // Register Tint and Gain, set the Gain pass's parameter through its Pass output, then remove Tint.
    const nodes: GraphNode[] = [
      node("begin", "flow.event.beginPlay"),
      node("tint", "scene.registerPostProcess", { "default:material": "tint" }),
      node("gain", "scene.registerPostProcess", { "default:material": "gain" }),
      node("set", "material.setFloatParameter", { "default:name": "Gain", "default:value": 0.9 }),
      node("remove", "scene.unregisterPostProcess", { "default:material": "tint" }),
    ];
    const edges = [
      ...nodes.slice(1).map((target, index) => ({
        id: `e${index}`, sourceNodeId: nodes[index]!.id, sourcePinId: "execOut", targetNodeId: target.id, targetPinId: "execIn",
      })),
      { id: "pass", sourceNodeId: "gain", sourcePinId: "pass", targetNodeId: "set", targetPinId: "material" },
    ];
    const graph = compileGraph({ id: "gameplay", kind: "event", nodes, edges }, { assetGuid: "hero", registry });
    await runtime.loadScripts([{ ...graph, assetGuid: "hero", classId: "Hero", parentClassId: "Actor" }]);
    runtime.realizePlayWorld();
    handle.resize();
    await handle.prewarmSceneMaterials();
    const presentation = handle.presentFirstFrame();
    await vi.waitFor(() => {
      engine.beginFrame();
      engine._renderViews();
      engine.endFrame();
      expect(canvas.drawImage).toHaveBeenCalledOnce();
    });
    await presentation;
    expect(handle.postProcessPassCount()).toBe(0);
    // Begin Play runs once the Scene's models are ready.
    runtime.notifySceneModelsReady("world", 1);
    expect(runtime.getWorld().currentScene?.postProcessStack.map((entry) => entry.materialGuid)).toEqual(["gain"]);
    // The coordinator materializes a replaced stack's passes on its next preparation.
    await handle.prewarmSceneMaterials();
    expect(handle.postProcessPassCount()).toBe(1);
    const passes = handle.scene.materials
      .filter((candidate): candidate is NodeMaterial => candidate instanceof NodeMaterial && candidate.name.startsWith("material:"));
    expect(passes.map((candidate) => candidate.name)).toEqual(["material:gain"]);
    // The Pass output's parameter write reached the pass it registered.
    expect((passes[0]!.getBlockByName("gain") as InputBlock).value).toBe(0.9);
    expect(commands.filter((command) => command.type === "diagnostic" || (command.type === "log" && command.severity === "error"))).toEqual([]);
  } finally {
    runtime.stop();
    handle.dispose();
    engine.dispose();
  }
});

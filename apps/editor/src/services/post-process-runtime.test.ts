import { expect, it, vi } from "vitest";
import { InputBlock, NodeMaterial, NullEngine } from "@babylonjs/core";
import { createEngine } from "@babylonslate/render";
import { createInProcessRuntime } from "@babylonslate/runtime";
import { createActor, createDefaultScene } from "@babylonslate/core";
import {
  isPlayEngineCommandType,
  type CommandMessage,
} from "@babylonslate/bridge";
import {
  createDefaultMaterialDocument,
  buildMaterialParameterCatalog,
} from "@babylonslate/shader-graph";
import {
  compileGraph,
  type GraphNode,
  type LogicGraph,
} from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "@babylonslate/scripting-nodes";
import { playLoadControl } from "./play-physics";
import { runtimeOptionsFromLoadControl } from "@babylonslate/runtime";

/** Node's NullEngine needs the real view lifecycle, but no browser pixel surface. */
class Canvas extends EventTarget {
  width = 256;
  height = 256;
  clientWidth = 256;
  clientHeight = 256;
  style = { cursor: "", touchAction: "" };
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 256, height: 256 };
  }
  getContext(kind: string) {
    return kind === "2d" ? { clearRect() {}, drawImage() {} } : null;
  }
}

it("applies compiled gameplay entry reads, setters and resets through Play load metadata and the real renderer", async () => {
  const engine = new NullEngine();
  const upload = engine.createRawTexture.bind(engine);
  vi.spyOn(engine, "createRawTexture").mockImplementation((...args) => {
    const texture = upload(...args);
    texture.isReady = true;
    return texture;
  });
  vi.spyOn(engine, "buildTextureLayout").mockImplementation(
    (enabled, backbuffer) =>
      backbuffer
        ? [0x0405]
        : enabled.map((value, index) => (value ? 0x8ce0 + index : 0)),
  );
  vi.spyOn(engine, "bindAttachments").mockImplementation(() => {});
  vi.spyOn(engine, "restoreSingleAttachment").mockImplementation(() => {});
  vi.spyOn(engine, "restoreSingleAttachmentForRenderTarget").mockImplementation(
    () => {},
  );
  const loop = vi.spyOn(engine, "runRenderLoop");
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
  const handle = createEngine(new Canvas() as unknown as HTMLCanvasElement, {
    sharedEngine: engine,
    playMode: true,
    materialDocuments: materials,
    postProcessStack: scene.settings.postProcessStack,
  });
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
    await handle.prewarmSceneMaterials();
    const presentation = handle.presentFirstFrame();
    loop.mock.calls[0]![0]();
    engine.onEndFrameObservable.notifyObservers(engine);
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
    expect(values()).toEqual([0.25, 0.8, 0.3]);
    expect({ scene, material }).toEqual(before);
  } finally {
    runtime.stop();
    handle.dispose();
    engine.dispose();
  }
});

import { describe, expect, it } from "vitest";
import {
  createActor,
  createDefaultScene,
  createDefaultSceneLayer,
  type MaterialParameterCatalog,
} from "@babylonslate/core";
import {
  type CommandMessage,
  isPlayEngineCommandType,
} from "@babylonslate/bridge";
import {
  compileGraph,
  type GraphNode,
  type LogicGraph,
} from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "@babylonslate/scripting-nodes";
import { createInProcessRuntime } from "./driver";
import { runtimeOptionsFromLoadControl } from "./play-load";

const catalog: MaterialParameterCatalog = {
  post: {
    domain: "postProcess",
    planHash: "lowered-post",
    parameters: {
      Gain: { kind: "float", value: 0.5 },
      Tint: { kind: "color", value: [1, 1, 1, 1] },
      Image: { kind: "texture", textureAssetGuid: "default-image" },
    },
  },
  surface: { domain: "surface", planHash: "lowered-surface", parameters: {} },
};
function documents() {
  const scene = createDefaultScene();
  scene.actors = [createActor("hero", "Hero", { classId: "Hero" })];
  scene.settings.postProcessStack = [
    {
      id: "first",
      materialGuid: "post",
      enabled: true,
      parameters: {
        Gain: { kind: "float", value: 0.25 },
        Image: { kind: "texture", textureAssetGuid: "saved-image" },
      },
    },
    { id: "second", materialGuid: "post", enabled: true },
    { id: "disabled", materialGuid: "post", enabled: false },
    { id: "wrong-domain", materialGuid: "surface", enabled: true },
  ];
  const layer = createDefaultSceneLayer();
  layer.settings.postProcessStack = structuredClone(
    scene.settings.postProcessStack,
  );
  return { scene, layer };
}
function writes(commands: CommandMessage[]) {
  return commands.filter(
    (command) => command.type === "setPostProcessMaterialParameter",
  );
}

it("compiles Scene entry lookup, typed reads, shared setters and authored reset into bridge commands", async () => {
  const registry = createDefaultNodeRegistry();
  const nodes: GraphNode[] = [];
  const edges: LogicGraph["edges"] = [];
  const node = (
    id: string,
    typeId: string,
    properties: Record<string, unknown> = {},
  ) => {
    nodes.push({
      id,
      typeId,
      position: { x: 0, y: 0 },
      properties,
      pins: registry.get(typeId)!.pins(properties),
    });
  };
  const edge = (
    sourceNodeId: string,
    sourcePinId: string,
    targetNodeId: string,
    targetPinId: string,
  ) =>
    edges.push({
      id: `edge-${edges.length}`,
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
  let previous = "begin";
  for (const [id, type, target, value, read] of [
    ["write", "setFloat", "first", 0.75, false],
    ["copy", "setFloat", "second", undefined, true],
    ["reset", "resetFloat", "first", undefined, false],
    ["disabled-copy", "setFloat", "disabled", undefined, true],
  ] as const) {
    node(id, `material.${type}Parameter`, {
      "default:name": "Gain",
      ...(value === undefined ? {} : { "default:value": value }),
    });
    edge(previous, "execOut", id, "execIn");
    edge(target, "material", id, "material");
    previous = id;
    if (read) {
      node(`read-${id}`, "material.getFloatParameter", {
        "default:name": "Gain",
      });
      edge("first", "material", `read-${id}`, "material");
      edge(`read-${id}`, "value", id, "value");
    }
  }
  const compiled = compileGraph(
    { id: "entry-graph", kind: "event", nodes, edges },
    { assetGuid: "hero", registry },
  );
  const { scene } = documents();
  const before = structuredClone(scene);
  const commands: CommandMessage[] = [];
  const runtime = createInProcessRuntime({
    seed: 1,
    preferSoftwarePhysics: true,
    playScene: scene,
    playSceneGuid: "world",
    materialParameterCatalog: catalog,
    materialTextureAssetGuids: ["default-image", "saved-image"],
    onCommand: (command) => commands.push(command),
  });
  try {
    await runtime.loadScripts([
      {
        ...compiled,
        assetGuid: "hero",
        classId: "Hero",
        parentClassId: "Actor",
      },
    ]);
    runtime.realizePlayWorld();
    expect(commands.filter((command) => command.type === "diagnostic")).toEqual(
      [],
    );
    expect(
      writes(commands).map((command) => [command.entryId, command.parameter]),
    ).toEqual([
      ["first", { kind: "float", value: 0.75 }],
      ["second", { kind: "float", value: 0.75 }],
      ["first", { kind: "float", value: 0.25 }],
      ["disabled", { kind: "float", value: 0.25 }],
    ]);
    expect(
      writes(commands).every(
        (command) =>
          isPlayEngineCommandType(command.type) &&
          command.owner.kind === "scene" &&
          command.owner.sceneAssetGuid === "world" &&
          command.owner.sceneLoadId === 1,
      ),
    ).toBe(true);
    expect(scene).toEqual(before);
  } finally {
    runtime.stop();
  }
});

describe("Post Process owner reads and resets", () => {
  it("rejects wrong domains/types/assets and preserves copied per-entry defaults", async () => {
    const { scene } = documents();
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      preferSoftwarePhysics: true,
      ...runtimeOptionsFromLoadControl({
        type: "load",
        sceneAssetGuid: "world",
        scene,
        materialParameterCatalog: structuredClone(catalog),
        materialTextureAssetGuids: [
          "default-image",
          "saved-image",
          "new-image",
        ],
      }),
      cooperativeSceneLoading: false,
      onCommand: (command) => commands.push(command),
    });
    try {
      await runtime.loadScripts([
        {
          assetGuid: "hero",
          classId: "Hero",
          parentClassId: "Actor",
          anchors: [],
          entryPoints: [
            { name: "onBeginPlay", event: "onBeginPlay", isAsync: false },
          ],
          source: `export function onBeginPlay(ctx) {
          const owner = ctx.getSceneReference();
          const first = ctx.getPostProcessEntry(owner, "first"); const second = ctx.getPostProcessEntry(owner, "second");
          ctx.self.setVariable("identity", first === ctx.getPostProcessEntry(owner, "first"));
          ctx.self.setVariable("wrong", ctx.getPostProcessEntry(owner, "wrong-domain"));
          ctx.setMaterialColorParameter(first, "Tint", {x:0.1,y:0.2,z:0.3,w:0.4});
          const color = ctx.getMaterialColorParameter(first, "Tint"); color.value.x = 9;
          ctx.self.setVariable("color", ctx.getMaterialColorParameter(first, "Tint"));
          ctx.self.setVariable("sibling", ctx.getMaterialColorParameter(second, "Tint"));
          ctx.setMaterialTextureParameter(first, "Image", "new-image");
          ctx.setMaterialTextureParameter(first, "Image", "material-guid");
          ctx.setMaterialFloatParameter(first, "Image", 1);
          ctx.setMaterialFloatParameter(first, "Missing", 1);
          ctx.self.setVariable("image", ctx.getMaterialTextureParameter(first, "Image"));
          ctx.self.setVariable("reset", ctx.resetMaterialTextureParameter(first, "Image"));
          ctx.self.setVariable("saved", ctx.getMaterialTextureParameter(first, "Image"));
          ctx.setMaterialTextureParameter(second, "Image", null);
          ctx.self.setVariable("empty", ctx.getMaterialTextureParameter(second, "Image"));
          ctx.resetMaterialTextureParameter(second, "Image");
          ctx.self.setVariable("default", ctx.getMaterialTextureParameter(second, "Image"));
          ctx.self.setVariable("wrongType", ctx.getMaterialFloatParameter(first, "Tint"));
          ctx.self.setVariable("wrongReset", ctx.resetMaterialFloatParameter(first, "Tint"));
        }`,
        },
      ]);
      runtime.realizePlayWorld();
      const actor = runtime.getWorld().getActors()[0]!;
      expect(actor.getVariable("identity")).toBe(true);
      expect(actor.getVariable("wrong")).toBeNull();
      expect(actor.getVariable("color")).toEqual({
        found: true,
        value: { x: 0.1, y: 0.2, z: 0.3, w: 0.4 },
      });
      expect(actor.getVariable("sibling")).toEqual({
        found: true,
        value: { x: 1, y: 1, z: 1, w: 1 },
      });
      expect(actor.getVariable("image")).toEqual({
        found: true,
        value: "new-image",
      });
      expect(actor.getVariable("reset")).toBe(true);
      expect(actor.getVariable("saved")).toEqual({
        found: true,
        value: "saved-image",
      });
      expect(actor.getVariable("empty")).toEqual({ found: true, value: null });
      expect(actor.getVariable("default")).toEqual({
        found: true,
        value: "default-image",
      });
      expect(actor.getVariable("wrongType")).toEqual({
        found: false,
        value: 0,
      });
      expect(actor.getVariable("wrongReset")).toBe(false);
      expect(writes(commands)).toHaveLength(5);
      expect(
        commands.filter((command) => command.type === "diagnostic"),
      ).toEqual([]);
    } finally {
      runtime.stop();
    }
  });

  it("requires ready Scene and Layer owners and invalidates handles across same-asset reload and removal", async () => {
    const { scene, layer } = documents();
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      preferSoftwarePhysics: true,
      playScene: scene,
      playSceneGuid: "world",
      sceneLibrary: { world: scene },
      sceneLayerLibrary: { overlay: layer },
      deferSceneModelsReady: true,
      materialParameterCatalog: catalog,
      materialTextureAssetGuids: ["default-image", "saved-image"],
      onCommand: (command) => commands.push(command),
    });
    try {
      await runtime.loadScripts([
        {
          assetGuid: "caller",
          classId: "Caller",
          parentClassId: "GameInstance",
          anchors: [],
          entryPoints: [{ name: "probe", event: "probe", isAsync: false }],
          source: `export function probe(ctx) {
          const handle = ctx.args.handle ?? ctx.getPostProcessEntry(ctx.args.owner, "first");
          ctx.self.setVariable("handle", handle);
          ctx.self.setVariable("read", ctx.getMaterialFloatParameter(handle, "Gain"));
          ctx.setMaterialFloatParameter(handle, "Gain", 0.8);
        }`,
        },
      ]);
      runtime.realizePlayWorld();
      const world = runtime.getWorld();
      const gi = world.gameInstance!;
      const probe = (args: Record<string, unknown>) =>
        runtime.invokeScriptEvent("Caller", "probe", gi, args);
      probe({ owner: world.currentScene });
      expect(gi.getVariable("handle")).toBeNull();
      expect(writes(commands)).toHaveLength(0);
      runtime.notifySceneModelsReady("world", 1);
      probe({ owner: world.currentScene });
      const old = gi.getVariable("handle");
      expect(old).not.toBeNull();
      expect(writes(commands).at(-1)?.owner).toEqual({
        kind: "scene",
        sceneAssetGuid: "world",
        sceneLoadId: 1,
      });
      const overlay = runtime.createSceneLayer("overlay")!;
      probe({ owner: overlay });
      expect(gi.getVariable("handle")).toBeNull();
      runtime.notifySceneLayerReady(overlay.guid, 1);
      probe({ owner: overlay });
      const oldLayer = gi.getVariable("handle");
      expect(writes(commands).at(-1)?.owner).toEqual({
        kind: "sceneLayer",
        layerId: overlay.guid,
        layerLoadId: 1,
      });
      runtime.removeSceneLayer(overlay.guid);
      const count = writes(commands).length;
      probe({ handle: oldLayer });
      expect(writes(commands)).toHaveLength(count);
      expect(gi.getVariable("read")).toEqual({ found: false, value: 0 });
      runtime.executeConsoleCommand("changescene world");
      runtime.notifySceneModelsReady("world", 2);
      probe({ handle: old });
      expect(writes(commands)).toHaveLength(count);
      probe({ owner: world.currentScene });
      expect(gi.getVariable("handle")).not.toBe(old);
      expect(writes(commands).at(-1)?.owner).toEqual({
        kind: "scene",
        sceneAssetGuid: "world",
        sceneLoadId: 2,
      });
      runtime.stop();
      const stoppedCount = writes(commands).length;
      probe({ owner: world.currentScene });
      expect(writes(commands)).toHaveLength(stoppedCount);
    } finally {
      runtime.stop();
    }
  });
});

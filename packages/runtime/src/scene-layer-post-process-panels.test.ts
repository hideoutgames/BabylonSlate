import { describe, expect, it } from "vitest";
import type { CommandMessage, SceneLayerPostProcessPanelPayload } from "@haptic/bridge";
import { createActor, createDefaultScene, createDefaultSceneLayer, type SerializedComponent, type SerializedSceneLayer } from "@haptic/core";
import { createInProcessRuntime } from "./driver";

const panel = (id: string, properties: Record<string, unknown>): SerializedComponent =>
  ({ id, classId: "2DPostProcessingPanelComponent", properties: { enabled: true, ...properties } });
const texture = (id: string): SerializedComponent => ({ id, classId: "2DTextureComponent", properties: { textureGuid: "tex" } });

/**
 * Frame (a panel with a Material Instance override) holds Icon and Badge (an inner panel holding Pip); Plain sits
 * outside; Off is switched off and Empty has no Material, so their children draw as under any parent.
 */
function hud(): SerializedSceneLayer {
  const frame = createActor("frame", "Frame", { classId: "PanelOwner", components: [panel("pp", { materialGuid: "blur" })] });
  frame.components[0]!.materialInstance = { materialGuid: "blur", parameters: { Strength: { kind: "float", value: 0.5 } } };
  return {
    ...createDefaultSceneLayer(),
    name: "HUD",
    actors: [
      frame,
      createActor("icon", "Icon", { classId: "SceneLayerActor", parentId: "frame", components: [texture("t")] }),
      createActor("badge", "Badge", { classId: "SceneLayerActor", parentId: "frame", components: [panel("pp", { materialGuid: "wobble" })] }),
      createActor("pip", "Pip", { classId: "SceneLayerActor", parentId: "badge", components: [texture("t")] }),
      createActor("plain", "Plain", { classId: "SceneLayerActor", components: [texture("t")] }),
      createActor("off", "Off", { classId: "SceneLayerActor", components: [panel("pp", { enabled: false, materialGuid: "blur" })] }),
      createActor("off-child", "Off Child", { classId: "SceneLayerActor", parentId: "off", components: [texture("t")] }),
      createActor("empty", "Empty", { classId: "SceneLayerActor", components: [panel("pp", {})] }),
    ],
  };
}

async function panelRuntime() {
  const commands: CommandMessage[] = [];
  const runtime = createInProcessRuntime({
    seed: 1,
    preferSoftwarePhysics: true,
    playScene: createDefaultScene(),
    sceneLayerLibrary: { hud: hud() },
    materialParameterCatalog: {
      blur: { domain: "postProcess", planHash: "blur", parameters: { Strength: { kind: "float", value: 1 } } },
      wobble: { domain: "postProcess", planHash: "wobble", parameters: {} },
    },
    onCommand: (command) => commands.push(command),
  });
  await runtime.loadScripts([{
    assetGuid: "panel-owner", classId: "PanelOwner", parentClassId: "SceneLayerActor", anchors: [],
    source: [
      'const material = (ctx) => ctx.callComponentFunction(ctx.getComponentById(ctx.self, "pp"), "getMaterialObject", {}).material;',
      'export function strength(ctx) { ctx.setMaterialFloatParameter(material(ctx), "Strength", 2); }',
      'export function off(ctx) { ctx.setVariableOn(ctx.getComponentById(ctx.self, "pp"), "enabled", false); }',
    ].join("\n"),
    entryPoints: ["strength", "off"].map((name) => ({ name, event: name, isAsync: false })),
  }]);
  runtime.realizePlayWorld();
  const layer = runtime.createSceneLayer("hud", 0)!;
  runtime.start();
  runtime.tick();
  const world = runtime.getWorld();
  const actor = (id: string) => world.findActor(`${layer.guid}:${id}`)!;
  const slot = (id: string) => commands.find((command) => command.type === "spawn" && command.actorGuid === actor(id).guid)?.slotId;
  const panelLists = () => commands.flatMap((command) => command.type === "sceneLayerPostProcessPanels" ? [command] : []);
  return { runtime, commands, layer, actor, slot, panelLists };
}

describe("Scene Layer Post Processing Panels", () => {
  it("sends each enabled panel with a Material, inner first, with the slots drawn into it and its authored values", async () => {
    const { runtime, layer, slot, panelLists } = await panelRuntime();
    try {
      const lists = panelLists();
      expect(lists).toHaveLength(1);
      expect(lists[0]!.layerId).toBe(layer.guid);
      const expected: SceneLayerPostProcessPanelPayload[] = [
        { slotId: slot("badge")!, componentId: "pp", materialGuid: "wobble", parameters: {}, contentSlotIds: [slot("badge")!, slot("pip")!], parentSlotId: slot("frame")! },
        { slotId: slot("frame")!, componentId: "pp", materialGuid: "blur", parameters: { Strength: { kind: "float", value: 0.5 } },
          contentSlotIds: [slot("frame")!, slot("icon")!], parentSlotId: null },
      ];
      expect(lists[0]!.panels).toEqual(expected);
      // A steady layer sends nothing more.
      runtime.tick();
      runtime.tick();
      expect(panelLists()).toHaveLength(1);
    } finally { runtime.stop(); }
  });

  it("writes live parameters through the panel's Material Object and ends the panel when it is switched off", async () => {
    const { runtime, commands, actor, slot, panelLists } = await panelRuntime();
    try {
      const frameSlot = slot("frame");
      const from = commands.length;
      runtime.invokeScriptEvent("PanelOwner", "strength", actor("frame"));
      expect(commands.slice(from).filter((command) => command.type === "setMaterialParameter")).toEqual([{
        type: "setMaterialParameter", slotId: frameSlot, componentId: "pp", materialAssetGuid: "blur",
        parameterName: "Strength", parameter: { kind: "float", value: 2 },
      }]);
      runtime.invokeScriptEvent("PanelOwner", "off", actor("frame"));
      runtime.tick();
      const last = panelLists().at(-1)!;
      // The inner panel is still on: it now draws straight into the layer, and Frame's actors under no panel.
      expect(last.panels.map((entry) => [entry.materialGuid, entry.parentSlotId])).toEqual([["wobble", null]]);
    } finally { runtime.stop(); }
  });
});

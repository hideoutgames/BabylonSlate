import { describe, expect, it } from "vitest";
import { createActor, createDefaultScene, createDefaultSceneLayer, identitySerializedTransform, normalizeFocusNavigationSettings } from "@babylonslate/core";
import type { CommandMessage } from "@babylonslate/bridge";
import { createInProcessRuntime } from "./driver";
import { runtimeOptionsFromLoadControl } from "./play-load";

describe("SceneLayer focus runtime integration", () => {
  it("navigates by standalone attached visuals and skips hidden or disabled visual attachments without layout boxes", () => {
    const layer = createDefaultSceneLayer();
    const offset = identitySerializedTransform(); offset.position[0] = 10;
    layer.actors = [
      createActor("start", "Start", { classId: "SceneLayerActor", components: [{ id: "start-focus", classId: "2DButtonComponent", properties: { focusInitial: true } }] }),
      createActor("offset", "Offset", { classId: "SceneLayerActor", components: [
        { id: "offset-visual", classId: "2DMaterialComponent", transform: offset, properties: {} },
        { id: "offset-focus", classId: "2DFocusTargetComponent", properties: {} },
      ] }),
      createActor("middle", "Middle", { classId: "SceneLayerActor", components: [{ id: "middle-focus", classId: "2DButtonComponent", properties: {} }] }),
      createActor("hidden", "Hidden", { classId: "SceneLayerActor", components: [
        { id: "hidden-visual", classId: "2DMaterialComponent", properties: { visible: false } },
        { id: "hidden-focus", classId: "2DButtonComponent", properties: {} },
      ] }),
      createActor("disabled-parent", "Disabled Parent", { classId: "SceneLayerActor", components: [{ id: "disabled-visual", classId: "2DMaterialComponent", properties: { enabled: false } }] }),
      createActor("helper", "Helper", { classId: "SceneLayerActor", parentId: "disabled-parent", components: [{ id: "helper-focus", classId: "2DFocusTargetComponent", properties: {} }] }),
    ];
    layer.actors[2]!.transform.position[0] = 5;
    layer.actors[3]!.transform.position[0] = 2;
    layer.actors[4]!.transform.position[0] = 3;
    const runtime = createInProcessRuntime({ seed: 1, preferSoftwarePhysics: true, playScene: createDefaultScene(), sceneLayerLibrary: { menu: layer }, onCommand: () => {} });
    try {
      runtime.realizePlayWorld(); runtime.createSceneLayer("menu"); runtime.start(); runtime.tick();
      const navigate = () => { runtime.pushInput([
        { kind: "key", tick: 0, code: "ArrowRight", phase: "down" },
        { kind: "key", tick: 0, code: "ArrowRight", phase: "up" },
      ]); runtime.tick(); };
      const focused = () => runtime.getWorld().getActors().flatMap(actor => actor.components).find(component => component.getVariable("focused") === true)?.guid;
      navigate(); expect(focused()).toBe("middle-focus");
      navigate(); expect(focused()).toBe("offset-focus");
      expect(runtime.getWorld().findActor("offset")!.components.find(component => component.guid === "offset-visual")!.transform.position.x).toBe(10);
    } finally { runtime.stop(); }
  });

  it.each([true, false])("honors worker-loaded project enablement (%s) and invokes component-bound native focus and activation", async (enabled) => {
    const layer = createDefaultSceneLayer();
    layer.actors = [createActor("menu", "Menu", {
      classId: "MenuActor",
      components: [
        { id: "first", classId: "2DButtonComponent", properties: {} },
        { id: "second", classId: "2DFocusTargetComponent", properties: {} },
      ],
    })];
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      ...runtimeOptionsFromLoadControl({
        type: "load", sceneAssetGuid: "world", scene: createDefaultScene(),
        sceneLayers: [{ guid: "menu-layer", layer }],
        focusNavigation: normalizeFocusNavigationSettings({ enabled }),
      }),
      cooperativeSceneLoading: false, preferSoftwarePhysics: true, onCommand: (command) => commands.push(command),
    });
    try {
      await runtime.loadScripts([{
        assetGuid: "menu-script", classId: "MenuActor", parentClassId: "SceneLayerActor", anchors: [],
        source: [
          'export function onBeginPlay(ctx) { const target = ctx.getComponentById(ctx.self, "second"); ctx.callComponentFunction(target, "setFocusTarget", {}); }',
          'export function entered(ctx) { ctx.log("log", "focus-proof", "entered"); }',
          'export function activated(ctx) { ctx.log("log", "focus-proof", "activated"); }',
        ].join("\n"),
        entryPoints: [
          { name: "onBeginPlay", event: "onBeginPlay", isAsync: false },
          { name: "entered", event: "onFocusEnter", isAsync: false, componentId: "second" },
          { name: "activated", event: "onFocusActivate", isAsync: false, componentId: "second" },
        ],
      }]);
      runtime.realizePlayWorld();
      runtime.createSceneLayer("menu-layer");
      runtime.start();
      runtime.tick();
      runtime.pushInput([
        { kind: "key", tick: 0, code: "Enter", phase: "down" },
        { kind: "key", tick: 0, code: "Enter", phase: "up" },
      ]);
      runtime.tick();
      const messages = commands.flatMap((command) => command.type === "log" && command.category === "focus-proof" ? [command.message] : []);
      expect(messages).toEqual(enabled ? ["entered", "activated"] : []);
      expect(runtime.getWorld().findActor("menu")?.components.find((component) => component.guid === "first")?.getVariable("focused") === true).toBe(false);
    } finally { runtime.stop(); }
  });
});

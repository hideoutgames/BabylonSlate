import { describe, expect, it } from "vitest";
import { ENGINE_COMPONENT_DESCRIPTORS } from "@haptic/core";
import {
  ENGINE_CLASS_SCRIPT_APIS,
  engineEventTypeClassIds,
  engineNativeEventsFor,
  engineScriptApiFor,
} from "./engine-script-api";

/**
 * Engine components that graphs reach through dedicated nodes or editor modes instead of
 * catalog members, each with the reason.
 */
const COMPONENTS_WITHOUT_SCRIPT_MEMBERS: Readonly<Record<string, string>> = {
  SaveGameComponent: "Save Game nodes",
  LandscapeComponent: "edited in the Landscape Scene mode",
  FoliageComponent: "painted in the Foliage Scene mode",
  AnimationGraphComponent: "Animation Graph nodes",
  BehaviourTreeComponent: "Behaviour Tree nodes",
  BlockingVolumeComponent: "no settings; its collision is the actor's scale",
};

describe("engine script API catalog", () => {
  it("gives every engine component script members unless it is listed with a reason", () => {
    const listed = new Set(ENGINE_CLASS_SCRIPT_APIS.map((api) => api.classId));
    const missing = ENGINE_COMPONENT_DESCRIPTORS.map((descriptor) => descriptor.classId)
      .filter((classId) => !listed.has(classId) && !Object.hasOwn(COMPONENTS_WITHOUT_SCRIPT_MEMBERS, classId));
    expect(missing).toEqual([]);
    // An exemption that gained members is stale.
    expect(Object.keys(COMPONENTS_WITHOUT_SCRIPT_MEMBERS).filter((classId) => listed.has(classId))).toEqual([]);
  });

  it("exposes NavMesh bake settings read-only and Scene Streaming's Target Scene", () => {
    const names = (classId: string) =>
      engineScriptApiFor(classId)?.variables?.map((variable) => `${variable.name}${variable.getOnly ? " (get)" : ""}`);
    expect(names("NavMeshComponent")).toContain("Walkable Radius (get)");
    expect(names("NavMeshBlockerComponent")).toEqual(["Dynamic (get)", "Kind", "Area", "Cost"]);
    expect(engineScriptApiFor("SceneStreamingComponent")?.variables).toEqual([
      { name: "Target Scene", typeId: "asset", typeClassId: "Scene", propertyKey: "sceneGuid" },
    ]);
  });

  it("maps event types onto the classes that expose them", () => {
    const types = engineEventTypeClassIds();
    expect(types["flow.event.onClick"]).toEqual(["2DButtonComponent"]);
    expect(types["flow.event.beginOverlap"]).toEqual(["ColliderComponent"]);
    expect(types["flow.event.textChanged"]).toEqual([
      "Text3DComponent",
      "2DTextComponent",
      "2DRichTextComponent",
    ]);
    expect(types["flow.event.audioFinished"]).toEqual(["AudioComponent"]);
    expect(types["flow.event.beginPlay"]).toBeUndefined();
    // Native lifecycle events must never demand a component binding.
    for (const eventType of [
      "flow.event.init",
      "flow.event.tick",
      "flow.event.sceneExit",
      "flow.event.sceneLoaded",
      "flow.event.sceneActorSpawned",
    ]) {
      expect(types[eventType]).toBeUndefined();
    }
  });

  it("resolves native lifecycle events from the nearest engine class in the ancestry", () => {
    const typesFor = (ancestry: string[]) =>
      engineNativeEventsFor(ancestry).map((event) => event.eventType);
    const gameInstance = typesFor(["MyGame", "GameInstance", "Object"]);
    // A user subsystem chain (user parent first) inherits GameSubsystem's set,
    // which has full Game Instance parity.
    expect(
      typesFor(["Inventory", "BaseInventory", "GameSubsystem", "Subsystem", "Object"]),
    ).toEqual(gameInstance);
    const sceneSubsystem = typesFor(["Weather", "SceneSubsystem", "Subsystem", "Object"]);
    expect(sceneSubsystem).toEqual(expect.arrayContaining([
      "flow.event.init",
      "flow.event.end",
      "flow.event.sceneLoaded",
      "flow.event.sceneActorDestroyed",
    ]));
    // Scene-scoped subsystems do not receive the session-level scene hooks.
    expect(sceneSubsystem).not.toContain("flow.event.sceneExit");
    expect(typesFor(["Hero", "Actor", "Object"])).toEqual([]);
    expect(typesFor(["Subsystem", "Object"])).toEqual([]);
    // Host-only functions stay off subsystem catalog entries (no stray Call rows).
    expect(engineScriptApiFor("GameSubsystem")?.functions).toBeUndefined();
    expect(engineScriptApiFor("SceneSubsystem")?.functions).toBeUndefined();
  });
});

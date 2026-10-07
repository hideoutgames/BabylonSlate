import { describe, expect, it } from "vitest";
import {
  engineEventTypeClassIds,
  engineNativeEventsFor,
  engineScriptApiFor,
} from "./engine-script-api";

describe("engine script API catalog", () => {
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
    const gameInstance = typesFor(["MyGame", "GameInstance", "BObject"]);
    // A user subsystem chain (user parent first) inherits GameSubsystem's set,
    // which has full Game Instance parity.
    expect(
      typesFor(["Inventory", "BaseInventory", "GameSubsystem", "Subsystem", "BObject"]),
    ).toEqual(gameInstance);
    const sceneSubsystem = typesFor(["Weather", "SceneSubsystem", "Subsystem", "BObject"]);
    expect(sceneSubsystem).toEqual(expect.arrayContaining([
      "flow.event.init",
      "flow.event.end",
      "flow.event.sceneLoaded",
      "flow.event.sceneActorDestroyed",
    ]));
    // Scene-scoped subsystems do not receive the session-level scene hooks.
    expect(sceneSubsystem).not.toContain("flow.event.sceneExit");
    expect(typesFor(["Hero", "Actor", "BObject"])).toEqual([]);
    expect(typesFor(["Subsystem", "BObject"])).toEqual([]);
    // Host-only functions stay off subsystem catalog entries (no stray Call rows).
    expect(engineScriptApiFor("GameSubsystem")?.functions).toBeUndefined();
    expect(engineScriptApiFor("SceneSubsystem")?.functions).toBeUndefined();
  });
});

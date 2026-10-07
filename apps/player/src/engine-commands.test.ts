import { describe, expect, it } from "vitest";
import { createDefaultScene } from "@babylonslate/core";
import {
  applyPlayerActiveScene,
  applyPlayerEngineCommand,
} from "./engine-commands";

describe("applyPlayerEngineCommand", () => {
  it("forwards assignMaterial onto the Engine handle", () => {
    const applied: string[] = [];
    const handle = {
      applyCommand: (command: { type: string }) => {
        applied.push(command.type);
      },
    };
    expect(
      applyPlayerEngineCommand(handle, {
        type: "assignMaterial",
        slotId: 1,
        materialAssetGuid: "mat-rock",
      }),
    ).toBe(true);
    expect(applied).toEqual(["assignMaterial"]);
  });

  it("ignores commands the Engine does not apply", () => {
    const applied: string[] = [];
    const handle = {
      applyCommand: (command: { type: string }) => {
        applied.push(command.type);
      },
    };
    expect(applyPlayerEngineCommand(handle, { type: "stats" })).toBe(false);
    expect(applyPlayerEngineCommand(handle, { type: "print" })).toBe(false);
    expect(applyPlayerEngineCommand(handle, { type: "uiApply" })).toBe(false);
    expect(applyPlayerEngineCommand(handle, { type: "uiRemove" })).toBe(false);
    expect(applyPlayerEngineCommand(handle, { type: "uiSetVisible" })).toBe(false);
    expect(applyPlayerEngineCommand(handle, { type: "setInputMode" })).toBe(false);
    expect(applied).toEqual([]);
  });
});

describe("applyPlayerActiveScene", () => {
  it("replaces reverb on scene changes and clears it for scenes without a bake", () => {
    const first = new Uint8Array([1]);
    const second = new Uint8Array([2]);
    let reverb: Uint8Array | null = first;
    const handle = { loadScene: () => {}, applySceneEnvironment: () => {},
      resetAudioSession: () => { reverb = first; },
      setAudioReverbField: (bytes: Uint8Array | null) => { reverb = bytes; } };
    const scenes = new Map(["first", "second", "dry"].map((guid) => [guid, createDefaultScene()]));
    const fields = new Map([["first", first], ["second", second]]);
    applyPlayerActiveScene(handle, scenes, { type: "activeScene", sceneAssetGuid: "second" }, "first", false, fields);
    expect(reverb).toBe(second);
    applyPlayerActiveScene(handle, scenes, { type: "activeScene", sceneAssetGuid: "dry" }, "second", false, fields);
    expect(reverb).toBeNull();
    applyPlayerActiveScene(handle, scenes, { type: "activeScene", sceneAssetGuid: "first" }, "dry", false, fields);
    expect(reverb).toBe(first);
  });
  it("loads the destination scene stack and environment", () => {
    const loaded: string[] = [];
    const handle = {
      loadScene: (scene: { name: string }) => {
        loaded.push(`load:${scene.name}`);
      },
      applySceneEnvironment: (scene: { name: string }) => {
        loaded.push(`env:${scene.name}`);
      },
      resetAudioSession: () => {
        loaded.push("reset-audio");
      },
      resetParticleSession: () => {
        loaded.push("reset-particles");
      },
    };
    const scene = { ...createDefaultScene(), name: "Level 2" };
    const scenes = new Map([["scene-2", scene]]);
    expect(
      applyPlayerActiveScene(handle, scenes, {
        type: "activeScene",
        sceneAssetGuid: "scene-2",
      }),
    ).toBe(true);
    expect(loaded).toEqual([
      "load:Level 2",
      "env:Level 2",
      "reset-audio",
      "reset-particles",
    ]);
  });

  it("does not reload or reset when the host already has that scene", () => {
    const loaded: string[] = [];
    const handle = {
      loadScene: (scene: { name: string }) => {
        loaded.push(`load:${scene.name}`);
      },
      applySceneEnvironment: (scene: { name: string }) => {
        loaded.push(`env:${scene.name}`);
      },
      resetAudioSession: () => {
        loaded.push("reset-audio");
      },
      resetParticleSession: () => {
        loaded.push("reset-particles");
      },
    };
    const scene = { ...createDefaultScene(), name: "Level 1" };
    const scenes = new Map([["scene-1", scene]]);
    expect(
      applyPlayerActiveScene(
        handle,
        scenes,
        { type: "activeScene", sceneAssetGuid: "scene-1" },
        "scene-1",
      ),
    ).toBe(true);
    expect(loaded).toEqual([]);
    expect(applyPlayerActiveScene(handle, scenes, { type: "activeScene", sceneAssetGuid: "scene-1" }, "scene-1", true)).toBe(true);
    expect(loaded).toEqual(["load:Level 1", "env:Level 1", "reset-audio", "reset-particles"]);
  });
});

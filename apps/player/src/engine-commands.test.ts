import { describe, expect, it, vi } from "vitest";
import { createDefaultScene } from "@babylonslate/core";
import {
  applyPlayerActiveScene,
  applyPlayerEngineCommand,
  schedulePlayerMaterialPrewarm,
  schedulePlayerSceneModelsReady,
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

  it("forwards assignParticle and setParticlePlaying onto the Engine handle", () => {
    const applied: string[] = [];
    const handle = {
      applyCommand: (command: { type: string }) => {
        applied.push(command.type);
      },
    };
    expect(
      applyPlayerEngineCommand(handle, {
        type: "assignParticle",
        slotId: 1,
        actorGuid: "fx",
        componentId: "particle-1",
        particleSystemGuid: "sys-1",
        play: true,
      }),
    ).toBe(true);
    expect(
      applyPlayerEngineCommand(handle, {
        type: "setParticlePlaying",
        actorGuid: "fx",
        playing: false,
      }),
    ).toBe(true);
    expect(applied).toEqual(["assignParticle", "setParticlePlaying"]);
  });

  it("forwards playSound and mixer commands onto the Engine handle", () => {
    const applied: string[] = [];
    const handle = {
      applyCommand: (command: { type: string }) => {
        applied.push(command.type);
      },
    };
    expect(
      applyPlayerEngineCommand(handle, {
        type: "playSound",
        assetGuid: "jump",
        volume: 1,
        frameId: 1,
      }),
    ).toBe(true);
    expect(applyPlayerEngineCommand(handle, { type: "stopSound", voiceId: "v1" })).toBe(
      true,
    );
    expect(
      applyPlayerEngineCommand(handle, {
        type: "setChannelVolume",
        channelGuid: "sfx",
        volume: 0.5,
      }),
    ).toBe(true);
    expect(
      applyPlayerEngineCommand(handle, { type: "setGlobalVolume", volume: 0.25 }),
    ).toBe(true);
    expect(applyPlayerEngineCommand(handle, { type: "spawn", slotId: 1, actorGuid: "a" })).toBe(
      true,
    );
    expect(applied).toEqual([
      "playSound",
      "stopSound",
      "setChannelVolume",
      "setGlobalVolume",
      "spawn",
    ]);
  });

  it("forwards Play hardware scaling and frame cap commands", () => {
    const applied: string[] = [];
    const handle = {
      applyCommand: (command: { type: string }) => {
        applied.push(command.type);
      },
    };
    expect(
      applyPlayerEngineCommand(handle, { type: "setFrameCap", fps: 30 }),
    ).toBe(true);
    expect(
      applyPlayerEngineCommand(handle, { type: "setRenderQuality", level: "low" }),
    ).toBe(true);
    expect(
      applyPlayerEngineCommand(handle, {
        type: "setResolutionScale",
        scale: 1.5,
      }),
    ).toBe(true);
    expect(applied).toEqual([
      "setFrameCap",
      "setRenderQuality",
      "setResolutionScale",
    ]);
  });

  it("forwards setFreeCam onto the Engine handle", () => {
    const applied: string[] = [];
    const handle = {
      applyCommand: (command: { type: string }) => {
        applied.push(command.type);
      },
    };
    expect(
      applyPlayerEngineCommand(handle, { type: "setFreeCam", enabled: true }),
    ).toBe(true);
    expect(applied).toEqual(["setFreeCam"]);
  });

  it("forwards SceneLayer compositor commands onto the Engine handle", () => {
    const applied: string[] = [];
    const handle = {
      applyCommand: (command: { type: string }) => {
        applied.push(command.type);
      },
    };
    expect(
      applyPlayerEngineCommand(handle, {
        type: "sceneLayerCreate",
        layerId: "hud",
        assetGuid: "hud-asset",
        zOrder: 1,
        ownerSceneGuid: null,
        postProcessStack: [],
      }),
    ).toBe(true);
    expect(
      applyPlayerEngineCommand(handle, { type: "sceneLayerRemove", layerId: "hud" }),
    ).toBe(true);
    expect(applyPlayerEngineCommand(handle, { type: "sceneLayerClear" })).toBe(true);
    expect(
      applyPlayerEngineCommand(handle, {
        type: "sceneLayerPostProcess",
        layerId: "hud",
        postProcessStack: [],
      }),
    ).toBe(true);
    expect(applied).toEqual([
      "sceneLayerCreate",
      "sceneLayerRemove",
      "sceneLayerClear",
      "sceneLayerPostProcess",
    ]);
  });

  it("forwards despawn onto the Engine handle", () => {
    const applied: string[] = [];
    const handle = {
      applyCommand: (command: { type: string }) => {
        applied.push(command.type);
      },
    };
    expect(
      applyPlayerEngineCommand(handle, {
        type: "despawn",
        slotId: 4,
        actorGuid: "banner",
      }),
    ).toBe(true);
    expect(applied).toEqual(["despawn"]);
  });

  it("forwards Play visualization commands onto the Engine handle", () => {
    const applied: string[] = [];
    const handle = {
      applyCommand: (command: { type: string }) => {
        applied.push(command.type);
      },
    };
    expect(
      applyPlayerEngineCommand(handle, { type: "setWireframe", enabled: true }),
    ).toBe(true);
    expect(
      applyPlayerEngineCommand(handle, {
        type: "debugColliders",
        colliders: [],
      }),
    ).toBe(true);
    expect(applyPlayerEngineCommand(handle, { type: "setShowNav", enabled: true })).toBe(
      true,
    );
    expect(
      applyPlayerEngineCommand(handle, { type: "setShowAudioDebug", enabled: true }),
    ).toBe(true);
    expect(applied).toEqual(["setWireframe", "debugColliders", "setShowNav", "setShowAudioDebug"]);
  });

  it("forwards debugDraw onto the Engine handle without a debugger bundle", () => {
    const applied: string[] = [];
    const handle = {
      applyCommand: (command: { type: string }) => {
        applied.push(command.type);
      },
    };
    expect(
      applyPlayerEngineCommand(handle, {
        type: "debugDraw",
        kind: "line",
        duration: 0,
        color: { x: 1, y: 1, z: 1, w: 1 },
        frameId: 1,
        start: { x: 0, y: 0, z: 0 },
        end: { x: 1, y: 0, z: 0 },
        thickness: 1,
      }),
    ).toBe(true);
    expect(applied).toEqual(["debugDraw"]);
  });

  it("forwards setCursorVisible onto the Engine handle", () => {
    const applied: string[] = [];
    const handle = {
      applyCommand: (command: { type: string }) => {
        applied.push(command.type);
      },
    };
    expect(
      applyPlayerEngineCommand(handle, {
        type: "setCursorVisible",
        visible: true,
        frameId: 1,
      }),
    ).toBe(true);
    expect(applied).toEqual(["setCursorVisible"]);
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
  });
});

describe("schedulePlayerMaterialPrewarm", () => {
  it("prewarms after the first assignMesh once models are ready", async () => {
    const order: string[] = [];
    const handle = {
      whenEditorModelsReady: async () => {
        order.push("models");
      },
      prewarmSceneMaterials: async () => {
        order.push("prewarm");
      },
    };
    const scheduled = { current: false };
    schedulePlayerMaterialPrewarm(handle, "spawn", scheduled);
    expect(scheduled.current).toBe(false);
    schedulePlayerMaterialPrewarm(handle, "assignMesh", scheduled);
    schedulePlayerMaterialPrewarm(handle, "assignMesh", scheduled);
    expect(scheduled.current).toBe(true);
    await vi.waitFor(() => {
      expect(order).toEqual(["models", "prewarm"]);
    });
  });
});

describe("schedulePlayerSceneModelsReady", () => {
  it("posts sceneModelsReady after models are ready", async () => {
    const posted: Array<{ type: string; sceneAssetGuid: string }> = [];
    const handle = {
      whenEditorModelsReady: async () => {},
    };
    schedulePlayerSceneModelsReady(
      (message) => {
        posted.push(message);
      },
      handle,
      "scene-1",
    );
    await vi.waitFor(() => {
      expect(posted).toEqual([
        { type: "sceneModelsReady", sceneAssetGuid: "scene-1" },
      ]);
    });
  });
});

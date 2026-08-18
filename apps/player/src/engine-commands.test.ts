import { describe, expect, it } from "vitest";
import { createDefaultScene } from "@babylonslate/core";
import { applyPlayerActiveScene, applyPlayerEngineCommand } from "./engine-commands";

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
    expect(applied).toEqual(["setWireframe", "debugColliders"]);
  });

  it("ignores commands the Engine does not apply", () => {
    const applied: string[] = [];
    const handle = {
      applyCommand: (command: { type: string }) => {
        applied.push(command.type);
      },
    };
    expect(applyPlayerEngineCommand(handle, { type: "stats" })).toBe(false);
    expect(applyPlayerEngineCommand(handle, { type: "uiApply" })).toBe(false);
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
});

import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@babylonslate/bridge";
import {
  createActor,
  createDefaultSceneSettings,
} from "@babylonslate/core";
import { createInProcessRuntime } from "./driver";

describe("ParticleComponent play-on-start", () => {
  it("prepares particles before presentation and starts them only after owner readiness", () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      deferSceneModelsReady: true,
      playSceneGuid: "particle-scene",
      playScene: {
        name: "Particles",
        viewportMode: "3d",
        settings: createDefaultSceneSettings(),
        folders: [],
        actors: [
          createActor("fx", "Sparks", {
            components: [
              {
                id: "particle-1",
                classId: "ParticleComponent",
                properties: {
                  particleSystemGuid: "sys-1",
                  playOnStart: true,
                  sortingLayer: "Foreground",
                  orderInLayer: 2,
                },
              },
            ],
          }),
        ],
      },
      onCommand: (command) => commands.push(command),
    });
    runtime.realizePlayWorld();
    expect(
      commands.filter((command) => command.type === "assignParticle"),
    ).toEqual([
      {
        type: "assignParticle",
        slotId: expect.any(Number),
        actorGuid: "fx",
        componentId: "particle-1",
        particleSystemGuid: "sys-1",
        play: false,
        sortingLayer: "Foreground",
        orderInLayer: 2,
      },
    ]);
    expect(commands.filter((command) => command.type === "setParticlePlaying")).toEqual([]);
    const realized = commands.find((command) => command.type === "sceneRealized")!;
    runtime.notifySceneModelsReady(realized.sceneAssetGuid, realized.sceneLoadId);
    expect(commands.filter((command) => command.type === "setParticlePlaying")).toEqual([
      { type: "setParticlePlaying", actorGuid: "fx", componentId: "particle-1", playing: true },
    ]);
    runtime.stop();
  });

  it("assigns without play when playOnStart is false", () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      playScene: {
        name: "Particles",
        viewportMode: "3d",
        settings: createDefaultSceneSettings(),
        folders: [],
        actors: [
          createActor("fx", "Sparks", {
            components: [
              {
                id: "particle-1",
                classId: "ParticleComponent",
                properties: {
                  particleSystemGuid: "sys-1",
                  playOnStart: false,
                },
              },
            ],
          }),
        ],
      },
      onCommand: (command) => commands.push(command),
    });
    runtime.realizePlayWorld();
    expect(
      commands.filter((command) => command.type === "assignParticle"),
    ).toEqual([
      expect.objectContaining({
        type: "assignParticle",
        particleSystemGuid: "sys-1",
        play: false,
      }),
    ]);
    runtime.stop();
  });

  it("emits assignParticle with a null guid on destroy so Play teardown disposes", () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      playScene: {
        name: "Particles",
        viewportMode: "3d",
        settings: createDefaultSceneSettings(),
        folders: [],
        actors: [
          createActor("fx", "Sparks", {
            components: [
              {
                id: "particle-1",
                classId: "ParticleComponent",
                properties: {
                  particleSystemGuid: "sys-1",
                  playOnStart: true,
                },
              },
            ],
          }),
        ],
      },
      sceneLibrary: {
        Other: {
          name: "Other",
          viewportMode: "3d",
          settings: createDefaultSceneSettings(),
          folders: [],
          actors: [],
        },
      },
      sceneGuidByKey: { Other: "other-scene" },
      onCommand: (command) => commands.push(command),
    });
    runtime.realizePlayWorld();
    commands.length = 0;
    runtime.executeConsoleCommand("changescene Other");
    expect(
      commands.filter((command) => command.type === "assignParticle"),
    ).toEqual([
      expect.objectContaining({
        type: "assignParticle",
        actorGuid: "fx",
        componentId: "particle-1",
        particleSystemGuid: null,
      }),
    ]);
    runtime.stop();
  });
});

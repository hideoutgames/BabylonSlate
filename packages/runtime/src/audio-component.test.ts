import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@babylonslate/bridge";
import {
  createActor,
  createDefaultSceneSettings,
} from "@babylonslate/core";
import { createInProcessRuntime } from "./driver";

describe("AudioComponent play-on-start", () => {
  it("emits playSound with the component voice and actor emitter", () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      playScene: {
        name: "Audio",
        viewportMode: "3d",
        settings: createDefaultSceneSettings(),
        folders: [],
        actors: [
          createActor("speaker", "Speaker", {
            components: [
              {
                id: "audio-1",
                classId: "AudioComponent",
                properties: {
                  audioAssetGuid: "jump",
                  playOnStart: true,
                  loop: true,
                  volume: 0.5,
                },
              },
            ],
          }),
        ],
      },
      onCommand: (command) => commands.push(command),
    });
    runtime.realizePlayWorld();
    expect(commands.filter((command) => command.type === "playSound")).toEqual([
      {
        type: "playSound",
        assetGuid: "jump",
        volume: 0.5,
        frameId: expect.any(Number),
        loop: true,
        voiceId: "audio-1",
        emitterActorGuid: "speaker",
      },
    ]);
    runtime.start();
    for (let i = 0; i < 2000; i++) runtime.tick();
    expect(commands.filter((command) => command.type === "playSound")).toHaveLength(
      1,
    );
    runtime.stop();
  });

  it("skips play-on-start when playOnStart is false or the asset is missing", () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      playScene: {
        name: "Audio",
        viewportMode: "3d",
        settings: createDefaultSceneSettings(),
        folders: [],
        actors: [
          createActor("quiet", "Quiet", {
            components: [
              {
                id: "audio-off",
                classId: "AudioComponent",
                properties: {
                  audioAssetGuid: "jump",
                  playOnStart: false,
                  volume: 1,
                },
              },
              {
                id: "audio-empty",
                classId: "AudioComponent",
                properties: { playOnStart: true, audioAssetGuid: null },
              },
            ],
          }),
        ],
      },
      onCommand: (command) => commands.push(command),
    });
    runtime.realizePlayWorld();
    expect(commands.filter((command) => command.type === "playSound")).toEqual([]);
    runtime.stop();
  });

  it("emits stopSound for AudioComponent voices on scene change", () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      playScene: {
        name: "Audio",
        viewportMode: "3d",
        settings: createDefaultSceneSettings(),
        folders: [],
        actors: [
          createActor("speaker", "Speaker", {
            components: [
              {
                id: "audio-1",
                classId: "AudioComponent",
                properties: {
                  audioAssetGuid: "jump",
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
    runtime.executeConsoleCommand("changescene Other");
    expect(commands.filter((command) => command.type === "stopSound")).toEqual([
      { type: "stopSound", voiceId: "audio-1" },
    ]);
    runtime.stop();
  });
});

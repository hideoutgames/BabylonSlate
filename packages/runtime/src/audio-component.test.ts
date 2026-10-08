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
    for (let i = 0; i < 120; i++) runtime.tick();
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

describe("AudioComponent script Stop", () => {
  it("stops the component voice and drops it from the trace record", async () => {
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
            classId: "Speaker",
            components: [{
              id: "audio-1",
              classId: "AudioComponent",
              properties: { audioAssetGuid: "jump", playOnStart: false, loop: true, volume: 0.5 },
            }],
          }),
        ],
      },
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([{
      assetGuid: "speaker-script", classId: "Speaker", parentClassId: "Actor", anchors: [],
      entryPoints: ["Play", "Stop"].map((name) => ({ name, event: name, isAsync: false })),
      source: `
        export function Play(ctx) { ctx.callComponentFunction(ctx.getComponentById(ctx.self, "audio-1"), "playAudio", {}); }
        export function Stop(ctx) { ctx.callComponentFunction(ctx.getComponentById(ctx.self, "audio-1"), "stopAudio", {}); }`,
    }]);
    runtime.realizePlayWorld();
    runtime.start();
    const speaker = runtime.getWorld().findActor("speaker")!;
    const audioCommands = () => commands.filter((command) => command.type === "playSound" || command.type === "stopSound");
    runtime.executeConsoleCommand("snapshot start");
    runtime.invokeScriptEvent("Speaker", "Play", speaker);
    runtime.tick();
    expect(audioCommands()).toEqual([expect.objectContaining({ type: "playSound", assetGuid: "jump", voiceId: "audio-1" })]);
    commands.length = 0;
    runtime.invokeScriptEvent("Speaker", "Stop", speaker);
    runtime.tick();
    runtime.executeConsoleCommand("snapshot stop");
    expect(audioCommands()).toEqual([{ type: "stopSound", voiceId: "audio-1" }]);
    const frames = runtime.stopTrace()!.frames;
    expect(frames[0]!.audio?.voices.map((voice) => voice.voiceId)).toEqual(["audio-1"]);
    expect(frames.at(-1)!.audio?.voices).toEqual([]);
    runtime.stop();
  });
});

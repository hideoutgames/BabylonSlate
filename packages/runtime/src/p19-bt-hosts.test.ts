import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@babylonslate/bridge";
import { quaternionToEulerDegrees } from "@babylonslate/core";
import {
  createActor,
  createDefaultSceneSettings,
  type SerializedScene,
} from "@babylonslate/core";
import type { BehaviourTreeDocument } from "@babylonslate/behaviour-tree";
import { createInProcessRuntime } from "./driver";

function leafTree(
  id: string,
  classId: string,
  properties: Record<string, unknown>,
  extras?: Partial<BehaviourTreeDocument["nodes"][number]>,
): BehaviourTreeDocument {
  return {
    name: "Host",
    rootId: id,
    blackboardGuid: null,
    nodes: [
      {
        id,
        kind: "task",
        classId,
        children: [],
        decorators: extras?.decorators ?? [],
        services: [],
        properties,
      },
    ],
  };
}

function hostScene(): SerializedScene {
  return {
    name: "AI",
    viewportMode: "3d",
    settings: createDefaultSceneSettings(),
    folders: [],
    actors: [
      createActor("guard", "Guard", {
        components: [
          {
            id: "bt-1",
            classId: "BehaviourTreeComponent",
            properties: { treeGuid: "tree-1" },
          },
        ],
      }),
    ],
  };
}

describe("P19 behaviour tree task hosts", () => {
  it("Rotate To Face yaws the actor toward the target", () => {
    const runtime = createInProcessRuntime({
      seed: 1,
      maxActors: 4,
      seedDemoActors: false,
      playScene: hostScene(),
      behaviourTrees: {
        "tree-1": leafTree("face", "bt.task.rotateToFace", {
          target: { x: 1, y: 0, z: 0 },
        }),
      },
    });
    runtime.start();
    runtime.realizePlayWorld();
    runtime.tick();
    const actor = runtime.getWorld().findActor("guard");
    expect(actor).toBeTruthy();
    const rotation = actor!.transform.rotation;
    const euler = quaternionToEulerDegrees([
      rotation.x,
      rotation.y,
      rotation.z,
      rotation.w,
    ]);
    expect(euler[0]).toBeCloseTo(0, 4);
    expect(euler[1]).toBeCloseTo(90, 4);
    expect(euler[2]).toBeCloseTo(0, 4);
    runtime.stop();
  });

  it("Rotate To Face fails without a finite target", () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      maxActors: 4,
      seedDemoActors: false,
      playScene: hostScene(),
      behaviourTrees: {
        "tree-1": leafTree("face", "bt.task.rotateToFace", {}),
      },
      onCommand: (command) => commands.push(command),
    });
    runtime.start();
    runtime.realizePlayWorld();
    runtime.tick();
    expect(
      commands.filter((command) => command.type === "btState").at(-1),
    ).toMatchObject({ status: "failure" });
    runtime.stop();
  });

  it("Play Animation seeks a catalogued Animation clip through animState", () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      maxActors: 4,
      seedDemoActors: false,
      dt: 0.1,
      playScene: hostScene(),
      behaviourTrees: {
        "tree-1": leafTree("anim", "bt.task.playAnimation", {
          clipKind: "animation",
          clipAssetGuid: "walk-1",
        }),
      },
      animClipCatalog: [
        {
          guid: "walk-1",
          type: "Animation",
          name: "Walk",
          clipName: "Walk",
          durationMs: 200,
        },
      ],
      onCommand: (command) => commands.push(command),
    });
    runtime.start();
    runtime.realizePlayWorld();
    runtime.tick();
    const mid = commands.filter((command) => command.type === "animState");
    expect(mid).toEqual([
      expect.objectContaining({
        type: "animState",
        clipName: "Walk",
        clipKind: "animation",
        clipAssetGuid: "walk-1",
        normalisedTime: 0.5,
        justFinished: false,
      }),
    ]);
    expect(
      commands.filter((command) => command.type === "btState").at(-1),
    ).toMatchObject({ status: "running" });
    runtime.tick();
    const done = commands.filter((command) => command.type === "animState").at(-1);
    expect(done).toMatchObject({
      type: "animState",
      normalisedTime: 1,
      justFinished: true,
      layers: [
        expect.objectContaining({
          clipAssetGuid: "walk-1",
          clipName: "Walk",
          clipKind: "animation",
          normalisedTime: 1,
          weight: 1,
        }),
      ],
    });
    expect(
      commands.filter((command) => command.type === "btState").at(-1),
    ).toMatchObject({ status: "success" });
    runtime.stop();
  });

  it("Play Animation fails when the clip guid is missing from the catalog", () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      maxActors: 4,
      seedDemoActors: false,
      playScene: hostScene(),
      behaviourTrees: {
        "tree-1": leafTree("anim", "bt.task.playAnimation", {
          clipKind: "animation",
          clipAssetGuid: "missing",
        }),
      },
      animClipCatalog: [],
      onCommand: (command) => commands.push(command),
    });
    runtime.start();
    runtime.realizePlayWorld();
    runtime.tick();
    expect(commands.filter((command) => command.type === "animState")).toEqual([]);
    expect(
      commands.filter((command) => command.type === "btState").at(-1),
    ).toMatchObject({ status: "failure" });
    runtime.stop();
  });

  it("Play Sound emits a stable voiceId without a loop flag", () => {
    const commands: CommandMessage[] = [];
    const tree = leafTree("sound", "bt.task.playSound", {
      audioAssetGuid: "audio-1",
      volume: 0.4,
    });
    const runtime = createInProcessRuntime({
      seed: 1,
      maxActors: 4,
      seedDemoActors: false,
      playScene: hostScene(),
      behaviourTrees: { "tree-1": tree },
      audioAssetGuids: ["audio-1"],
      onCommand: (command) => commands.push(command),
    });
    runtime.start();
    runtime.realizePlayWorld();
    runtime.tick();
    expect(commands.filter((command) => command.type === "playSound")).toEqual([
      expect.objectContaining({
        type: "playSound",
        assetGuid: "audio-1",
        volume: 0.4,
        emitterActorGuid: "guard",
        voiceId: "bt:guard:sound",
      }),
    ]);
    expect(
      commands.find((command) => command.type === "playSound"),
    ).not.toHaveProperty("loop");
    runtime.tick();
    const sounds = commands.filter((command) => command.type === "playSound");
    expect(sounds).toHaveLength(2);
    expect(sounds[1]).toMatchObject({ voiceId: "bt:guard:sound" });
    runtime.stop();
  });

  it("Play Animation abort stops emitting animState after TimeLimit", () => {
    const commands: CommandMessage[] = [];
    const tree = leafTree(
      "anim",
      "bt.task.playAnimation",
      { clipKind: "animation", clipAssetGuid: "walk-1" },
      {
        decorators: [
          {
            id: "limit",
            classId: "bt.decorator.timeLimit",
            abortMode: "none",
            observedKeys: [],
            properties: { durationMs: 150 },
          },
        ],
      },
    );
    const runtime = createInProcessRuntime({
      seed: 1,
      maxActors: 4,
      seedDemoActors: false,
      dt: 0.1,
      playScene: hostScene(),
      behaviourTrees: { "tree-1": tree },
      animClipCatalog: [
        {
          guid: "walk-1",
          type: "Animation",
          name: "Walk",
          clipName: "Walk",
          durationMs: 2000,
        },
      ],
      onCommand: (command) => commands.push(command),
    });
    runtime.start();
    runtime.realizePlayWorld();
    runtime.tick();
    expect(commands.some((command) => command.type === "animState")).toBe(true);
    expect(
      commands.filter((command) => command.type === "btState").at(-1),
    ).toMatchObject({ status: "running" });
    commands.length = 0;
    runtime.tick();
    expect(
      commands.filter((command) => command.type === "btState").at(-1),
    ).toMatchObject({ status: "failure" });
    expect(commands.filter((command) => command.type === "animState")).toEqual([]);
    runtime.stop();
  });

  it("Play Animation seeks a catalogued Sprite Animation clip through animState", () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      maxActors: 4,
      seedDemoActors: false,
      dt: 0.1,
      playScene: hostScene(),
      behaviourTrees: {
        "tree-1": leafTree("anim", "bt.task.playAnimation", {
          clipKind: "sprite",
          clipAssetGuid: "idle-1",
        }),
      },
      animClipCatalog: [
        {
          guid: "idle-1",
          type: "SpriteAnimation",
          name: "Idle",
          durationMs: 200,
        },
      ],
      onCommand: (command) => commands.push(command),
    });
    runtime.start();
    runtime.realizePlayWorld();
    runtime.tick();
    expect(commands.filter((command) => command.type === "animState")).toEqual([
      expect.objectContaining({
        type: "animState",
        clipKind: "sprite",
        clipAssetGuid: "idle-1",
        normalisedTime: 0.5,
        justFinished: false,
      }),
    ]);
    runtime.tick();
    expect(
      commands.filter((command) => command.type === "animState").at(-1),
    ).toMatchObject({
      normalisedTime: 1,
      justFinished: true,
      clipKind: "sprite",
    });
    expect(
      commands.filter((command) => command.type === "btState").at(-1),
    ).toMatchObject({ status: "success" });
    runtime.stop();
  });

  it("Play Sound abort emits stopSound for the voiceId", () => {
    const commands: CommandMessage[] = [];
    const tree: BehaviourTreeDocument = {
      name: "Host",
      rootId: "root",
      blackboardGuid: null,
      nodes: [
        {
          id: "root",
          kind: "sequence",
          classId: "bt.composite.sequence",
          children: ["sound", "wait"],
          decorators: [
            {
              id: "limit",
              classId: "bt.decorator.timeLimit",
              abortMode: "none",
              observedKeys: [],
              properties: { durationMs: 150 },
            },
          ],
          services: [],
          properties: {},
        },
        {
          id: "sound",
          kind: "task",
          classId: "bt.task.playSound",
          children: [],
          decorators: [],
          services: [],
          properties: { audioAssetGuid: "audio-1", volume: 0.4 },
        },
        {
          id: "wait",
          kind: "task",
          classId: "bt.task.wait",
          children: [],
          decorators: [],
          services: [],
          properties: { durationMs: 2000 },
        },
      ],
    };
    const runtime = createInProcessRuntime({
      seed: 1,
      maxActors: 4,
      seedDemoActors: false,
      dt: 0.1,
      playScene: hostScene(),
      behaviourTrees: { "tree-1": tree },
      audioAssetGuids: ["audio-1"],
      onCommand: (command) => commands.push(command),
    });
    runtime.start();
    runtime.realizePlayWorld();
    runtime.tick();
    expect(commands.filter((command) => command.type === "playSound")).toEqual([
      expect.objectContaining({ voiceId: "bt:guard:sound" }),
    ]);
    commands.length = 0;
    runtime.tick();
    expect(commands.filter((command) => command.type === "stopSound")).toEqual([
      { type: "stopSound", voiceId: "bt:guard:sound" },
    ]);
    runtime.stop();
  });
});

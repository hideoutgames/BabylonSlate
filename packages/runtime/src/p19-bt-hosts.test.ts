import { beforeAll, describe, expect, it } from "vitest";
import type { CommandMessage } from "@babylonslate/bridge";
import { createDefaultAnimGraph } from "@babylonslate/anim-graph";
import { quaternionToEulerDegrees } from "@babylonslate/core";
import {
  createActor,
  createDefaultSceneSettings,
  type SerializedScene,
} from "@babylonslate/core";
import type { BehaviourTreeDocument } from "@babylonslate/behaviour-tree";
import { generateNavMesh, initNavigation } from "@babylonslate/navigation";
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

  it("Play Animation counts the tick's step when slomo changes mid-tick", () => {
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
        { guid: "walk-1", type: "Animation", name: "Walk", clipName: "Walk", durationMs: 1000 },
      ],
      onCommand: (command) => commands.push(command),
    });
    const normalisedTime = () =>
      commands.filter((command) => command.type === "animState").at(-1)?.normalisedTime;
    try {
      runtime.start();
      runtime.realizePlayWorld();
      const world = runtime.getWorld();
      let changed = false;
      world.spawnActorNow(world.createActor({ guid: "slomo", classId: "Actor", hooks: { onTick: () => {
        if (!changed) changed = runtime.executeConsoleCommand("slomo 2").success;
      } } }));
      // Tick 1 keeps its 0.1 s step; the 0.2 s step slomo 2 sets starts with tick 2.
      runtime.tick();
      expect(changed).toBe(true);
      expect(normalisedTime()).toBeCloseTo(0.1);
      runtime.tick();
      expect(normalisedTime()).toBeCloseTo(0.3);
    } finally {
      runtime.stop();
    }
  });

  it.each([
    ["the clip guid is missing from the catalog", []],
    [
      "catalog durationMs is not positive",
      [{ guid: "missing", type: "Animation", name: "Walk", clipName: "Walk", durationMs: 0 }],
    ],
  ] as const)("Play Animation fails when %s", (_reason, animClipCatalog) => {
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
      animClipCatalog: [...animClipCatalog],
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

  it.each([
    ["destroyed", (runtime: ReturnType<typeof createInProcessRuntime>) => {
      runtime.getWorld().destroyActor("guard");
      runtime.tick();
    }],
    ["removed by a Scene change", (runtime: ReturnType<typeof createInProcessRuntime>) => {
      runtime.executeConsoleCommand("changescene Other");
    }],
  ] as const)("Play Sound voice stops once when its actor is %s", (_how, remove) => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      maxActors: 4,
      seedDemoActors: false,
      playScene: hostScene(),
      behaviourTrees: {
        "tree-1": leafTree("sound", "bt.task.playSound", { audioAssetGuid: "audio-1" }),
      },
      audioAssetGuids: ["audio-1"],
      sceneLibrary: {
        Other: { name: "Other", viewportMode: "3d", settings: createDefaultSceneSettings(), folders: [], actors: [] },
      },
      sceneGuidByKey: { Other: "other-scene" },
      onCommand: (command) => commands.push(command),
    });
    runtime.start();
    runtime.realizePlayWorld();
    runtime.tick();
    expect(commands.filter((command) => command.type === "playSound")).toEqual([
      expect.objectContaining({ voiceId: "bt:guard:sound" }),
    ]);
    commands.length = 0;
    remove(runtime);
    expect(commands.filter((command) => command.type === "stopSound")).toEqual([
      { type: "stopSound", voiceId: "bt:guard:sound" },
    ]);
    runtime.stop();
  });

  it("Animation Graph drives an actor reusing the slot of an actor despawned mid Play Animation", async () => {
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
      animGraphs: { "graph-1": createDefaultAnimGraph("Hero") },
      animClipCatalog: [
        { guid: "walk-1", type: "Animation", name: "Walk", clipName: "Walk", durationMs: 2000 },
      ],
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([{
      assetGuid: "replacement-script", classId: "Replacement", parentClassId: "Actor",
      source: "export function onTick() {}", anchors: [],
      entryPoints: [{ name: "onTick", event: "onTick", isAsync: false }],
    }]);
    runtime.start();
    runtime.realizePlayWorld();
    runtime.tick();
    expect(commands.filter((command) => command.type === "animState")).toEqual([
      expect.objectContaining({ slotId: 0, stateId: "bt.playAnimation", justFinished: false }),
    ]);
    runtime.getWorld().destroyActor("guard");
    runtime.tick();
    const replacement = runtime.spawnScriptedActor({ classId: "Replacement" });
    replacement!.attachComponent(runtime.getWorld().createComponent({
      classId: "AnimationGraphComponent", variables: { graphGuid: "graph-1" },
    }));
    expect(commands.filter((command) => command.type === "spawn").at(-1)).toMatchObject({
      actorGuid: replacement!.guid,
      slotId: 0,
    });
    commands.length = 0;
    runtime.tick();
    const graphStates = commands.filter((command) => command.type === "animState");
    expect(graphStates).toEqual([expect.objectContaining({ slotId: 0 })]);
    expect(graphStates[0]).not.toMatchObject({ stateId: "bt.playAnimation" });
    runtime.stop();
  });

  it("Rotate To Face yaws around Z in a 2D scene", () => {
    const scene = hostScene();
    scene.viewportMode = "2d";
    scene.settings = createDefaultSceneSettings("2d");
    const runtime = createInProcessRuntime({
      seed: 1,
      maxActors: 4,
      seedDemoActors: false,
      playScene: scene,
      behaviourTrees: {
        "tree-1": leafTree("face", "bt.task.rotateToFace", {
          target: { x: 0, y: 1, z: 0 },
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
    expect(euler[1]).toBeCloseTo(0, 4);
    expect(euler[2]).toBeCloseTo(90, 4);
    runtime.stop();
  });

  it("Play Animation last animState wins over Animation Graph and then skips the graph", () => {
    const commands: CommandMessage[] = [];
    const scene = hostScene();
    scene.actors[0]!.components.push({
      id: "anim-1",
      classId: "AnimationGraphComponent",
      properties: { graphGuid: "graph-1" },
    });
    const runtime = createInProcessRuntime({
      seed: 1,
      maxActors: 4,
      seedDemoActors: false,
      dt: 0.1,
      playScene: scene,
      behaviourTrees: {
        "tree-1": leafTree("anim", "bt.task.playAnimation", {
          clipKind: "animation",
          clipAssetGuid: "walk-1",
        }),
      },
      animGraphs: { "graph-1": createDefaultAnimGraph("Hero") },
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
    const first = commands.filter((command) => command.type === "animState");
    expect(first.at(-1)).toMatchObject({
      type: "animState",
      stateId: "bt.playAnimation",
      clipAssetGuid: "walk-1",
    });
    commands.length = 0;
    runtime.tick();
    const second = commands.filter((command) => command.type === "animState");
    expect(second).toEqual([
      expect.objectContaining({
        type: "animState",
        stateId: "bt.playAnimation",
        clipAssetGuid: "walk-1",
      }),
    ]);
    runtime.stop();
  });

  function graphAndPlayAnimationRuntime(commands: CommandMessage[]) {
    const scene = hostScene();
    scene.actors[0]!.components.push({
      id: "anim-1",
      classId: "AnimationGraphComponent",
      properties: { graphGuid: "graph-1" },
    });
    return createInProcessRuntime({
      seed: 1,
      maxActors: 4,
      seedDemoActors: false,
      dt: 0.1,
      playScene: scene,
      behaviourTrees: {
        "tree-1": leafTree("anim", "bt.task.playAnimation", {
          clipKind: "animation",
          clipAssetGuid: "walk-1",
        }),
      },
      animGraphs: { "graph-1": createDefaultAnimGraph("Hero") },
      animClipCatalog: [
        { guid: "walk-1", type: "Animation", name: "Walk", clipName: "Walk", durationMs: 2000 },
      ],
      onCommand: (command) => commands.push(command),
    });
  }

  it("Play Animation keeps its slot after a trace restore, as in the uninterrupted run", () => {
    const recordedCommands: CommandMessage[] = [];
    const recorded = graphAndPlayAnimationRuntime(recordedCommands);
    recorded.start();
    recorded.realizePlayWorld();
    recorded.executeConsoleCommand("snapshot start");
    recorded.tick();
    recordedCommands.length = 0;
    recorded.tick();
    recorded.executeConsoleCommand("snapshot stop");
    const uninterrupted = recordedCommands.filter((command) => command.type === "animState");
    expect(uninterrupted).toEqual([expect.objectContaining({ stateId: "bt.playAnimation" })]);
    const frame = recorded.stopTrace()!.frames[0]!;
    recorded.stop();

    const replayCommands: CommandMessage[] = [];
    const replay = graphAndPlayAnimationRuntime(replayCommands);
    replay.start();
    replay.realizePlayWorld();
    replay.restoreBtFromTrace(frame.bt!);
    replayCommands.length = 0;
    replay.tick();
    expect(replayCommands.filter((command) => command.type === "animState")).toEqual(uninterrupted);
    replay.stop();
  });

  it("trace restore drops Play Animation ownership the restored state does not hold", () => {
    const freshCommands: CommandMessage[] = [];
    const fresh = graphAndPlayAnimationRuntime(freshCommands);
    fresh.start();
    fresh.realizePlayWorld();
    fresh.tick();
    const stateIds = (commands: CommandMessage[]) =>
      commands.flatMap((command) => (command.type === "animState" ? [command.stateId] : []));
    const firstTick = stateIds(freshCommands);
    expect(firstTick).toHaveLength(2);
    fresh.stop();

    const commands: CommandMessage[] = [];
    const runtime = graphAndPlayAnimationRuntime(commands);
    runtime.start();
    runtime.realizePlayWorld();
    runtime.tick();
    runtime.restoreBtFromTrace([]);
    commands.length = 0;
    runtime.tick();
    expect(stateIds(commands)).toEqual(firstTick);
    runtime.stop();
  });
});

describe("trace restore of Play Sound voices", () => {
  function task(id: string, classId: string, properties: Record<string, unknown>) {
    return { id, kind: "task" as const, classId, children: [], decorators: [], services: [], properties };
  }

  function soundRuntime(children: string[], timeLimitMs: number | null, commands: CommandMessage[]) {
    const tree: BehaviourTreeDocument = {
      name: "Host",
      rootId: "root",
      blackboardGuid: null,
      nodes: [
        {
          id: "root",
          kind: "sequence",
          classId: "bt.composite.sequence",
          children,
          decorators: timeLimitMs === null ? [] : [{
            id: "limit", classId: "bt.decorator.timeLimit", abortMode: "none", observedKeys: [],
            properties: { durationMs: timeLimitMs },
          }],
          services: [],
          properties: {},
        },
        task("sound", "bt.task.playSound", { audioAssetGuid: "audio-1", volume: 0.4 }),
        task("wait", "bt.task.wait", { durationMs: 2000 }),
        task("delay", "bt.task.wait", { durationMs: 200 }),
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
    return runtime;
  }

  const audioCommands = (commands: CommandMessage[]) => commands.flatMap((command) =>
    command.type === "playSound" || command.type === "stopSound"
      ? [command.type === "playSound"
          ? { type: command.type, voiceId: command.voiceId, offset: command.startOffsetSeconds }
          : { type: command.type, voiceId: command.voiceId }]
      : []);

  it("resumes a voice mid-sound at its recorded offset, and a later abort stops it", () => {
    const recordedCommands: CommandMessage[] = [];
    const recorded = soundRuntime(["sound", "wait"], 350, recordedCommands);
    recorded.executeConsoleCommand("snapshot start");
    for (let i = 0; i < 3; i += 1) recorded.tick();
    recorded.executeConsoleCommand("snapshot stop");
    recordedCommands.length = 0;
    recorded.tick();
    expect(audioCommands(recordedCommands)).toEqual([{ type: "stopSound", voiceId: "bt:guard:sound" }]);
    const frame = recorded.stopTrace()!.frames.at(-1)!;
    recorded.stop();

    const commands: CommandMessage[] = [];
    const replay = soundRuntime(["sound", "wait"], 350, commands);
    commands.length = 0;
    replay.restoreFromTrace(frame);
    expect(commands.filter((command) => command.type === "playSound" || command.type === "stopSound")).toEqual([
      expect.objectContaining({
        type: "playSound", assetGuid: "audio-1", volume: 0.4, voiceId: "bt:guard:sound",
        emitterActorGuid: "guard", startOffsetSeconds: expect.closeTo(0.2, 9),
      }),
    ]);
    commands.length = 0;
    replay.tick();
    expect(audioCommands(commands)).toEqual([{ type: "stopSound", voiceId: "bt:guard:sound" }]);
    replay.stop();
  });

  it("stops a live voice the restored frame was not playing, then replays the recorded run", () => {
    const commands: CommandMessage[] = [];
    const runtime = soundRuntime(["delay", "sound", "wait"], null, commands);
    runtime.executeConsoleCommand("snapshot start");
    runtime.tick();
    commands.length = 0;
    runtime.tick();
    runtime.tick();
    runtime.executeConsoleCommand("snapshot stop");
    const uninterrupted = audioCommands(commands);
    expect(uninterrupted).toEqual([{ type: "playSound", voiceId: "bt:guard:sound", offset: undefined }]);
    const frames = runtime.stopTrace()!.frames;
    expect(frames[0]!.audio?.voices).toEqual([]);

    commands.length = 0;
    runtime.restoreFromTrace(frames[0]!);
    expect(audioCommands(commands)).toEqual([{ type: "stopSound", voiceId: "bt:guard:sound" }]);
    commands.length = 0;
    runtime.tick();
    runtime.tick();
    expect(audioCommands(commands)).toEqual(uninterrupted);
    runtime.stop();
  });
});

describe("P19 Rotate To Face crowd yaw", () => {
  beforeAll(async () => {
    await initNavigation();
  });

  it("keeps the faced yaw on a stationary crowd agent", async () => {
    const bytes = await generateNavMesh({
      positions: [
        -10, 0, -10,
        10, 0, -10,
        10, 0, 10,
        -10, 0, 10,
      ],
      indices: [0, 3, 2, 0, 2, 1],
    });
    const scene = hostScene();
    scene.actors[0]!.components.push({
      id: "nav",
      classId: "NavAgentComponent",
      properties: { radius: 0.5, height: 2, maxSpeed: 3.5 },
    });
    const runtime = createInProcessRuntime({
      seed: 1,
      maxActors: 4,
      seedDemoActors: false,
      playScene: scene,
      behaviourTrees: {
        "tree-1": leafTree("face", "bt.task.rotateToFace", {
          target: { x: 1, y: 0, z: 0 },
        }),
      },
    });
    await runtime.loadNavMesh(bytes);
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
    expect(euler[1]).toBeCloseTo(90, 4);
    runtime.stop();
  });
});

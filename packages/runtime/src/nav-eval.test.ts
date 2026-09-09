import { beforeAll, describe, expect, it } from "vitest";
import {
  readActorSlot,
  snapshotFloatCount,
  type CommandMessage,
} from "@babylonslate/bridge";
import {
  createActor,
  createDefaultSceneSettings,
  type SerializedScene,
} from "@babylonslate/core";
import {
  createNavigationBackend,
  generateNavMesh,
  initNavigation,
  mergeNavBakeMeshes,
  recastWalkableQuadFromXy,
  solidBlockerMesh,
} from "@babylonslate/navigation";
import { createInProcessRuntime } from "./driver";

function groundPrism(): { positions: number[]; indices: number[] } {
  const half = 10;
  return {
    positions: [
      -half, 0, -half,
      half, 0, -half,
      half, 0, half,
      -half, 0, half,
    ],
    indices: [0, 3, 2, 0, 2, 1],
  };
}

function corridorMesh(): { positions: number[]; indices: number[] } {
  const half = 12;
  return mergeNavBakeMeshes([
    {
      positions: [
        -half, 0, -half,
        half, 0, -half,
        half, 0, half,
        -half, 0, half,
      ],
      indices: [0, 3, 2, 0, 2, 1],
    },
    solidBlockerMesh({
      kind: "box",
      pose: { x: 0, y: 1, z: -6 },
      size: { x: 2, y: 2, z: 8 },
    }),
    solidBlockerMesh({
      kind: "box",
      pose: { x: 0, y: 1, z: 6 },
      size: { x: 2, y: 2, z: 8 },
    }),
  ]);
}

const recastFine = {
  cellSize: 0.25,
  cellHeight: 0.25,
  maxEdgeLen: 2,
  maxSimplificationError: 0.3,
  minRegionArea: 2,
  mergeRegionArea: 4,
  walkableRadius: 0.3,
};

function patrolScene(): SerializedScene {
  return {
    name: "Nav",
    viewportMode: "3d",
    settings: createDefaultSceneSettings(),
    folders: [],
    actors: [
      createActor("ground", "Ground", {
        components: [{ id: "mesh", classId: "MeshComponent", properties: { meshKind: "ground" } }],
      }),
      createActor("agent", "Agent", {
        transform: {
          position: [-4, 0, -4],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
        components: [
          {
            id: "nav",
            classId: "NavAgentComponent",
            properties: { radius: 0.5, height: 2, maxSpeed: 3.5 },
          },
        ],
      }),
    ],
  };
}

function physicalAgentScene(options: {
  y: number;
  gravityScale?: number;
  moveTo?: boolean;
}): SerializedScene {
  return {
    name: "Physical navigation",
    viewportMode: "3d",
    settings: createDefaultSceneSettings(),
    folders: [],
    actors: [
      createActor("floor", "Floor", {
        transform: { position: [0, -0.5, 0], rotation: [0, 0, 0, 1], scale: [20, 1, 20] },
        components: [{ id: "floor-body", classId: "BlockingVolumeComponent", properties: {} }],
      }),
      createActor("parent", "Parent", {
        transform: { position: [2, 0, 1], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      }),
      createActor("agent", "Agent", {
        parentId: "parent",
        transform: { position: [-6, options.y, -5], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        components: [
          { id: "nav", classId: "NavAgentComponent", properties: { radius: 0.5, height: 2, maxSpeed: 3.5 } },
          { id: "body", classId: "RigidBodyComponent", properties: { motionType: "dynamic", gravityScale: options.gravityScale ?? 1 } },
          {
            id: "collider",
            classId: "ColliderComponent",
            properties: { shape: { kind: "sphere", radius: 0.5 }, friction: 0 },
            transform: { position: [0, 0.5, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
          },
          ...(options.moveTo ? [{ id: "bt", classId: "BehaviourTreeComponent", properties: { treeGuid: "move-tree" } }] : []),
        ],
      }),
    ],
  };
}

const physicalMoveTree = {
  name: "Move",
  rootId: "move",
  blackboardGuid: null,
  nodes: [{
    id: "move", kind: "task" as const, classId: "BTTask_MoveTo",
    children: [], decorators: [], services: [],
    // References may point at a pivot above the walkable surface.
    properties: { destination: { x: 4, y: 1.5, z: 4 }, acceptRadius: 0.75 },
  }],
};

describe("runtime navmesh import and crowd", () => {
  let bytes: Uint8Array;

  beforeAll(async () => {
    await initNavigation();
    bytes = await generateNavMesh(groundPrism());
  });

  it("an idle NavAgent preserves dynamic gravity and the physics world pose", async () => {
    const runtime = createInProcessRuntime({
      seedDemoActors: false, playScene: physicalAgentScene({ y: 2 }),
      preferSoftwarePhysics: true,
    });
    try {
      await runtime.loadNavMesh(bytes);
      runtime.start();
      runtime.realizePlayWorld();
      runtime.tick();
      const actor = runtime.getWorld().findActor("agent")!;
      const body = runtime.getPhysicsSync()!.getBackend().getBodyTransform("body:agent")!;
      expect(actor.transform.position.y).toBeGreaterThan(1.9);
      expect(actor.transform.position.y).toBeLessThan(2);
      expect(body.position).toEqual({
        x: actor.transform.position.x + 2,
        y: actor.transform.position.y,
        z: actor.transform.position.z + 1,
      });
      for (let i = 0; i < 120; i += 1) runtime.tick();
      expect(actor.transform.position.y).toBeCloseTo(0, 1);
    } finally {
      runtime.stop();
    }
  });

  it("NavAgent leaves an authored zero-gravity body floating", async () => {
    const runtime = createInProcessRuntime({
      seedDemoActors: false, playScene: physicalAgentScene({ y: 2, gravityScale: 0 }),
      preferSoftwarePhysics: true,
    });
    try {
      await runtime.loadNavMesh(bytes);
      runtime.start();
      runtime.realizePlayWorld();
      for (let i = 0; i < 30; i += 1) runtime.tick();
      expect(runtime.getWorld().findActor("agent")!.transform.position.y).toBe(2);
    } finally {
      runtime.stop();
    }
  });

  it.each(["software", "havok"] as const)("%s: an airborne BT owner falls then navigates with its collider and parent offset", async (backend) => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seedDemoActors: false, playScene: physicalAgentScene({ y: 6, moveTo: true }),
      preferSoftwarePhysics: backend === "software",
      behaviourTrees: { "move-tree": physicalMoveTree },
      onCommand: (command) => commands.push(command),
    });
    try {
      await runtime.loadPhysics();
      await runtime.loadNavMesh(bytes);
      runtime.start();
      runtime.realizePlayWorld();
      for (let i = 0; i < 30; i += 1) runtime.tick();
      const actor = runtime.getWorld().findActor("agent")!;
      expect(actor.transform.position.y).toBeLessThan(5.5);
      expect(actor.transform.position.y).toBeGreaterThan(3);
      expect(commands.filter((command) => command.type === "btState").at(-1)).toMatchObject({ status: "running" });
      for (let i = 0; i < 330; i += 1) runtime.tick();
      const body = runtime.getPhysicsSync()!.getBackend().getBodyTransform("body:agent")!;
      expect(Math.hypot(body.position.x - 4, body.position.z - 4)).toBeLessThan(1);
      expect(body.position.y).toBeCloseTo(0, 1);
      expect(body.position.x).toBeCloseTo(actor.transform.position.x + 2, 5);
      expect(body.position.y).toBeCloseTo(actor.transform.position.y, 5);
      expect(body.position.z).toBeCloseTo(actor.transform.position.z + 1, 5);
      expect(commands.filter((command) => command.type === "btState").at(-1)).toMatchObject({ status: "success" });
    } finally {
      runtime.stop();
    }
  });

  it("stopping dynamic navigation stops horizontal steering while an upward impulse still falls", async () => {
    const runtime = createInProcessRuntime({
      seedDemoActors: false, playScene: physicalAgentScene({ y: 0 }),
      preferSoftwarePhysics: true,
    });
    try {
      await runtime.loadNavMesh(bytes);
      runtime.start();
      runtime.realizePlayWorld();
      expect(runtime.setNavAgentTarget("agent", { x: 4, y: 0, z: 4 })).toBe(true);
      for (let i = 0; i < 60; i += 1) runtime.tick();
      const actor = runtime.getWorld().findActor("agent")!;
      expect(actor.transform.position.x).toBeGreaterThan(-5.5);
      runtime.stopNavAgent("agent");
      const stoppedX = actor.transform.position.x;
      runtime.getPhysicsSync()!.addImpulse("agent", { x: 0, y: 5, z: 0 });
      for (let i = 0; i < 15; i += 1) runtime.tick();
      expect(actor.transform.position.y).toBeGreaterThan(0.5);
      expect(actor.transform.position.x).toBeCloseTo(stoppedX, 2);
      for (let i = 0; i < 90; i += 1) runtime.tick();
      expect(actor.transform.position.y).toBeCloseTo(0, 1);
    } finally {
      runtime.stop();
    }
  });

  it("imports baked bytes without generating and copies the agent pose into the snapshot", async () => {
    const generated = createNavigationBackend();
    generated.importNavMesh(bytes);
    expect(generated.findPath({ x: -4, y: 0, z: -4 }, { x: 4, y: 0, z: 4 }).length).toBeGreaterThan(1);

    const runtime = createInProcessRuntime({
      seed: 1,
      maxActors: 8,
      seedDemoActors: false,
      playScene: patrolScene(),
    });
    await runtime.loadNavMesh(bytes);
    runtime.start();
    runtime.realizePlayWorld();
    expect(runtime.setNavAgentTarget("agent", { x: 4, y: 0, z: 4 })).toBe(true);
    for (let i = 0; i < 90; i += 1) runtime.tick();
    const buf = new Float32Array(snapshotFloatCount(8));
    expect(runtime.copySnapshot(buf)).toBe(true);
    const slot = readActorSlot(buf, 0);
    const agentSlot =
      slot.position.x !== 0 || slot.position.z !== 0
        ? slot
        : readActorSlot(buf, 1);
    expect(agentSlot.position.x).toBeGreaterThan(-4);
    runtime.stop();
  });

  it("Set NavAgent maxSpeed retunes the live crowd after the agent is registered", async () => {
    const walk = async (setMaxSpeed?: number) => {
      const runtime = createInProcessRuntime({
        seed: 1,
        maxActors: 8,
        seedDemoActors: false,
        playScene: {
          name: "Nav",
          viewportMode: "3d",
          settings: createDefaultSceneSettings(),
          folders: [],
          actors: [
            createActor("agent", "Agent", {
              classId: "Hero",
              transform: {
                position: [-4, 0, -4],
                rotation: [0, 0, 0, 1],
                scale: [1, 1, 1],
              },
              components: [
                {
                  id: "nav",
                  classId: "NavAgentComponent",
                  properties: { radius: 0.5, height: 2, maxSpeed: 0.5 },
                },
              ],
            }),
          ],
        },
      });
      if (setMaxSpeed !== undefined) {
        await runtime.loadScripts([
          {
            assetGuid: "hero-script",
            classId: "Hero",
            parentClassId: "Actor",
            source: [
              "export function onTick(ctx) {",
              "  if (ctx.tickIndex !== 1) return;",
              '  const c = ctx.getComponentById(ctx.self, "nav");',
              `  ctx.setVariableOn(c, "maxSpeed", ${setMaxSpeed});`,
              "}",
            ].join("\n"),
            anchors: [],
            entryPoints: [
              { name: "onTick", event: "onTick", isAsync: false },
            ],
          },
        ]);
      }
      await runtime.loadNavMesh(bytes);
      runtime.start();
      runtime.realizePlayWorld();
      expect(runtime.setNavAgentTarget("agent", { x: 4, y: 0, z: 4 })).toBe(true);
      for (let i = 0; i < 60; i += 1) runtime.tick();
      const x = runtime.getWorld().findActor("agent")?.transform.position.x ?? -4;
      runtime.stop();
      return x;
    };
    expect(await walk(8)).toBeGreaterThan((await walk()) + 0.5);
  });

  it("Call Move To on Begin Play registers the crowd agent and walks", async () => {
    const runtime = createInProcessRuntime({
      seed: 1,
      maxActors: 8,
      seedDemoActors: false,
      playScene: {
        name: "Nav",
        viewportMode: "3d",
        settings: createDefaultSceneSettings(),
        folders: [],
        actors: [
          createActor("agent", "Agent", {
            classId: "Hero",
            transform: {
              position: [-4, 0, -4],
              rotation: [0, 0, 0, 1],
              scale: [1, 1, 1],
            },
            components: [
              {
                id: "nav",
                classId: "NavAgentComponent",
                properties: { radius: 0.5, height: 2, maxSpeed: 3.5 },
              },
            ],
          }),
        ],
      },
    });
    await runtime.loadScripts([
      {
        assetGuid: "hero-script",
        classId: "Hero",
        parentClassId: "Actor",
        source: [
          "export function onBeginPlay(ctx) {",
          '  const c = ctx.getComponentById(ctx.self, "nav");',
          '  ctx.callComponentFunction(c, "moveTo", {',
          "    destination: { x: 4, y: 0, z: 4 },",
          "  });",
          "}",
        ].join("\n"),
        anchors: [],
        entryPoints: [
          { name: "onBeginPlay", event: "onBeginPlay", isAsync: false },
        ],
      },
    ]);
    await runtime.loadNavMesh(bytes);
    runtime.start();
    runtime.realizePlayWorld();
    for (let i = 0; i < 90; i += 1) runtime.tick();
    expect(
      runtime.getWorld().findActor("agent")?.transform.position.x ?? -4,
    ).toBeGreaterThan(-3.5);
    runtime.stop();
  });

  it("Call Stop Movement holds the crowd agent after Move To", async () => {
    const runtime = createInProcessRuntime({
      seed: 1,
      maxActors: 8,
      seedDemoActors: false,
      playScene: {
        name: "Nav",
        viewportMode: "3d",
        settings: createDefaultSceneSettings(),
        folders: [],
        actors: [
          createActor("agent", "Agent", {
            classId: "Hero",
            transform: {
              position: [-4, 0, -4],
              rotation: [0, 0, 0, 1],
              scale: [1, 1, 1],
            },
            components: [
              {
                id: "nav",
                classId: "NavAgentComponent",
                properties: { radius: 0.5, height: 2, maxSpeed: 3.5 },
              },
            ],
          }),
        ],
      },
    });
    await runtime.loadScripts([
      {
        assetGuid: "hero-script",
        classId: "Hero",
        parentClassId: "Actor",
        source: [
          "export function onBeginPlay(ctx) {",
          '  const c = ctx.getComponentById(ctx.self, "nav");',
          '  ctx.callComponentFunction(c, "moveTo", {',
          "    destination: { x: 4, y: 0, z: 4 },",
          "  });",
          "}",
          "export function onTick(ctx) {",
          "  if (ctx.tickIndex !== 12) return;",
          '  const c = ctx.getComponentById(ctx.self, "nav");',
          '  ctx.callComponentFunction(c, "stopMovement", {});',
          "}",
        ].join("\n"),
        anchors: [],
        entryPoints: [
          { name: "onBeginPlay", event: "onBeginPlay", isAsync: false },
          { name: "onTick", event: "onTick", isAsync: false },
        ],
      },
    ]);
    await runtime.loadNavMesh(bytes);
    runtime.start();
    runtime.realizePlayWorld();
    for (let i = 0; i < 12; i += 1) runtime.tick();
    const stoppedAt =
      runtime.getWorld().findActor("agent")?.transform.position.x ?? -4;
    expect(stoppedAt).toBeGreaterThan(-4);
    for (let i = 0; i < 60; i += 1) runtime.tick();
    const later =
      runtime.getWorld().findActor("agent")?.transform.position.x ?? -4;
    expect(later).toBeLessThan(stoppedAt + 0.35);
    runtime.stop();
  });

  it("ticks BT MoveTo through the crowd until the destination", async () => {
    const tree = {
      name: "Patrol",
      rootId: "move",
      blackboardGuid: null,
      nodes: [
        {
          id: "move",
          kind: "task" as const,
          classId: "BTTask_MoveTo",
          children: [],
          decorators: [],
          services: [],
          properties: { destination: { x: 4, y: 0, z: 4 }, acceptRadius: 1.5 },
        },
      ],
    };
    const runtime = createInProcessRuntime({
      seed: 1,
      maxActors: 8,
      seedDemoActors: false,
      playScene: {
        name: "Nav",
        viewportMode: "3d",
        settings: createDefaultSceneSettings(),
        folders: [],
        actors: [
          createActor("guard", "Guard", {
            transform: {
              position: [-4, 0, -4],
              rotation: [0, 0, 0, 1],
              scale: [1, 1, 1],
            },
            components: [
              {
                id: "nav",
                classId: "NavAgentComponent",
                properties: { radius: 0.5, height: 2, maxSpeed: 3.5 },
              },
              {
                id: "bt",
                classId: "BehaviourTreeComponent",
                properties: { treeGuid: "tree-1" },
              },
            ],
          }),
        ],
      },
      behaviourTrees: { "tree-1": tree },
    });
    await runtime.loadNavMesh(bytes);
    runtime.start();
    runtime.realizePlayWorld();
    for (let i = 0; i < 180; i += 1) runtime.tick();
    const buf = new Float32Array(snapshotFloatCount(8));
    runtime.copySnapshot(buf);
    const slot = readActorSlot(buf, 0);
    expect(slot.position.x).toBeGreaterThan(-3);
    runtime.stop();
  });

  it("registers dynamic blockers onto a tile-cache mesh", async () => {
    const tileBytes = await generateNavMesh({
      ...groundPrism(),
      settings: { supportDynamicObstacles: true },
    });
    const runtime = createInProcessRuntime({
      seed: 1,
      maxActors: 8,
      seedDemoActors: false,
      playScene: {
        name: "Nav",
        viewportMode: "3d",
        settings: createDefaultSceneSettings(),
        folders: [],
        actors: [
          createActor("agent", "Agent", {
            transform: {
              position: [-4, 0, 0],
              rotation: [0, 0, 0, 1],
              scale: [1, 1, 1],
            },
            components: [
              {
                id: "nav",
                classId: "NavAgentComponent",
                properties: { radius: 0.5, height: 2, maxSpeed: 3.5 },
              },
            ],
          }),
          createActor("door", "Door", {
            transform: {
              position: [0, 1, 0],
              rotation: [0, 0, 0, 1],
              scale: [2, 2, 8],
            },
            components: [
              {
                id: "block",
                classId: "NavMeshBlockerComponent",
                properties: {
                  dynamic: true,
                  kind: "box",
                  area: "unwalkable",
                },
              },
            ],
          }),
        ],
      },
    });
    await runtime.loadNavMesh(tileBytes);
    runtime.start();
    runtime.realizePlayWorld();
    const path = runtime.findNavPath({ x: -4, y: 0, z: 0 }, { x: 4, y: 0, z: 0 });
    expect(path.length).toBeGreaterThan(1);
    expect(
      path.some((point) => Math.abs(point.x) < 1 && Math.abs(point.z) < 1),
    ).toBe(false);
    runtime.stop();
  });

  it("registers 2D dynamic blockers onto a remapped tile-cache mesh", async () => {
    const floor = recastWalkableQuadFromXy({
      minX: -10,
      minY: -10,
      maxX: 10,
      maxY: 10,
    });
    const tileBytes = await generateNavMesh({
      ...floor,
      settings: { supportDynamicObstacles: true },
    });
    const runtime = createInProcessRuntime({
      seed: 1,
      maxActors: 8,
      seedDemoActors: false,
      playScene: {
        name: "Nav2d",
        viewportMode: "2d",
        settings: createDefaultSceneSettings("2d"),
        folders: [],
        actors: [
          createActor("agent", "Agent", {
            transform: {
              position: [-4, 0, 0],
              rotation: [0, 0, 0, 1],
              scale: [1, 1, 1],
            },
            components: [
              {
                id: "nav",
                classId: "NavAgentComponent",
                properties: { radius: 0.5, height: 2, maxSpeed: 3.5 },
              },
            ],
          }),
          createActor("door", "Door", {
            transform: {
              position: [0, 0, 0],
              rotation: [0, 0, 0, 1],
              scale: [2, 8, 1],
            },
            components: [
              {
                id: "block",
                classId: "NavMeshBlockerComponent",
                properties: {
                  dynamic: true,
                  kind: "box",
                  area: "unwalkable",
                },
              },
            ],
          }),
        ],
      },
    });
    await runtime.loadNavMesh(tileBytes);
    runtime.start();
    runtime.realizePlayWorld();
    const path = runtime.findNavPath({ x: -4, y: 0, z: 0 }, { x: 4, y: 0, z: 0 });
    expect(path.length).toBeGreaterThan(1);
    expect(
      path.some((point) => Math.abs(point.x) < 1 && Math.abs(point.y) < 1),
    ).toBe(false);
    runtime.stop();
  });

  it("stamps cost volumes so findNavPath detours the corridor", async () => {
    const bytes = await generateNavMesh({
      ...corridorMesh(),
      settings: recastFine,
    });
    const runtime = createInProcessRuntime({
      seed: 1,
      maxActors: 8,
      seedDemoActors: false,
      playScene: {
        name: "NavCost",
        viewportMode: "3d",
        settings: createDefaultSceneSettings(),
        folders: [],
        actors: [
          createActor("mud", "Mud", {
            transform: {
              position: [0, 1, 0],
              rotation: [0, 0, 0, 1],
              scale: [4, 2, 3],
            },
            components: [
              {
                id: "block",
                classId: "NavMeshBlockerComponent",
                properties: {
                  dynamic: false,
                  kind: "box",
                  area: "cost",
                  cost: 10,
                },
              },
            ],
          }),
        ],
      },
    });
    await runtime.loadNavMesh(bytes);
    runtime.start();
    runtime.realizePlayWorld();
    const path = runtime.findNavPath({ x: -8, y: 0, z: 0 }, { x: 8, y: 0, z: 0 });
    expect(path.length).toBeGreaterThan(1);
    expect(path.some((point) => Math.abs(point.z) > 6)).toBe(true);
    runtime.stop();
  });
});

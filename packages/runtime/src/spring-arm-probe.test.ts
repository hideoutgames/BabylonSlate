import { afterEach, describe, expect, it } from "vitest";
import { createActor, createDefaultSceneSettings, createMeshComponent, type SerializedComponent } from "@haptic/core";
import type { CommandMessage } from "@haptic/bridge";
import { createInProcessRuntime } from "./driver";
import { ClassRegistry, World, type ActorComponent } from "@haptic/object-model";
import { SoftwarePhysicsBackend, type LineTraceOptions } from "@haptic/physics";
import { SpringArmProbeSync } from "./spring-arm-probe";
import { springArmSocketOffset } from "./spring-arm-socket";

type ProbeCommand = Extract<CommandMessage, { type: "springArmProbe" }>;
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

function addBox(backend: SoftwarePhysicsBackend, id: string, actorId: string, z: number, isTrigger = false): void {
  backend.createBody({ id, actorId, motionType: "static", mass: 0, linearDamping: 0, angularDamping: 0, gravityScale: 0,
    transform: { position: { x: 0, y: 0, z }, rotation: IDENTITY } });
  backend.createCollider({ id, bodyId: id, shape: { kind: "box", halfExtents: { x: 2, y: 2, z: 0.1 } },
    friction: 0.5, restitution: 0, isTrigger, layer: 1, mask: 0xffffffff });
}

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
});

/** A hero at the origin whose Spring Arm extends 4 units along -Z, with its own collider at the pivot. */
function probeRig(variables: Record<string, unknown>) {
  const world = new World({ seed: 1, dt: 1 / 60, classRegistry: new ClassRegistry() });
  const backend = new SoftwarePhysicsBackend("3d", { x: 0, y: -9.81, z: 0 });
  // The hero's own body surrounds the pivot: the probe must not stop on it.
  backend.createBody({ id: "hero-body", actorId: "hero", motionType: "static", mass: 0, linearDamping: 0, angularDamping: 0, gravityScale: 0,
    transform: { position: { x: 0, y: 0, z: 0 }, rotation: IDENTITY } });
  backend.createCollider({ id: "hero-body", bodyId: "hero-body", shape: { kind: "sphere", radius: 0.5 },
    friction: 0.5, restitution: 0, isTrigger: false, layer: 1, mask: 0xffffffff });
  const commands: ProbeCommand[] = [];
  const queries: Array<LineTraceOptions & { channel?: string }> = [];
  const probes = new SpringArmProbeSync({
    world,
    physics: () => ({
      shapeSweep: (shape, start, end, options) => {
        queries.push(options ?? {});
        // Channels are PhysicsWorldSync's job; the backend answers the rest of the query.
        const query = { ...options };
        delete query.channel;
        return backend.shapeSweep(shape, start, end, query);
      },
    }),
    eligible: () => true,
    slot: () => 3,
    emit: (command) => { if (command.type === "springArmProbe") commands.push(command); },
  });
  const actor = world.createActor({ classId: "Actor", guid: "hero" });
  const arm: ActorComponent = world.createComponent({ classId: "SpringArmComponent", variables: { armLength: 4, ...variables } });
  actor.attachComponent(arm);
  world.spawnActorNow(actor);
  probes.assign(arm);
  cleanups.push(() => { probes.dispose(); backend.dispose(); });
  return { backend, probes, arm, commands, queries };
}

describe("SpringArmProbeSync", () => {
  it("leaves an arm at full length while its Camera Probe is off (the default)", () => {
    const { backend, probes, arm, commands, queries } = probeRig({});
    addBox(backend, "wall", "wall", -2);
    probes.step(1 / 60, 1);
    expect(commands).toEqual([]);
    expect(queries).toEqual([]);
    expect(springArmSocketOffset(arm)).toEqual([0, 0, -4]);
  });

  it("pulls the arm in front of a wall at once, ignoring its own actor and triggers", () => {
    const { backend, probes, arm, commands, queries } = probeRig({ cameraProbe: true, probeSize: 0.15 });
    // The wall's near face is at z = -1.9; a 0.15 sphere touches it after 1.75.
    addBox(backend, "wall", "wall", -2);
    // A trigger nearer the pivot must not stop the probe.
    addBox(backend, "volume", "volume", -1, true);
    probes.step(1 / 60, 1);
    expect(queries).toEqual([expect.objectContaining({ channel: "Static", includeTriggers: false, ignoreActorIds: ["hero"] })]);
    expect(commands).toHaveLength(1);
    const [entry] = commands[0]!.arms;
    expect(entry).toMatchObject({ slotId: 3, componentId: arm.guid });
    expect(entry!.length).toBeCloseTo(1.75, 2);
    expect(springArmSocketOffset(arm)![2]).toBeCloseTo(-1.75, 2);
  });

  it("eases back out at Probe Return Speed once the way clears, then stops sending", () => {
    const { backend, probes, commands } = probeRig({ cameraProbe: true, probeSize: 0.15, probeReturnSpeed: 2 });
    addBox(backend, "wall", "wall", -2);
    probes.step(0.05, 1);
    const blocked = commands.at(-1)!.arms[0]!.length!;
    backend.destroyBody("wall");
    probes.step(0.05, 2);
    expect(commands.at(-1)!.arms[0]!.length).toBeCloseTo(blocked + (4 - blocked) * (1 - Math.exp(-0.1)), 6);
    for (let frame = 3; frame < 400; frame++) probes.step(0.05, frame);
    expect(commands.at(-1)!.arms[0]!.length).toBe(4);
    const sent = commands.length;
    probes.step(0.05, 400);
    expect(commands).toHaveLength(sent);
  });

  it("returns the arm to Arm Length when its probe is switched off in Play", () => {
    const { backend, probes, arm, commands } = probeRig({ cameraProbe: true });
    addBox(backend, "wall", "wall", -2);
    probes.step(1 / 60, 1);
    arm.setVariable("cameraProbe", false);
    probes.step(1 / 60, 2);
    expect(commands.at(-1)!.arms).toEqual([{ slotId: 3, componentId: arm.guid, length: null }]);
    expect(springArmSocketOffset(arm)).toEqual([0, 0, -4]);
  });
});

describe("Spring Arm Camera Probe in Play", () => {
  function component(id: string, classId: string, properties: Record<string, unknown>, position: [number, number, number] = [0, 0, 0], parentId?: string): SerializedComponent {
    return { id, classId, properties, transform: { position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, ...(parentId ? { parentId } : {}) };
  }

  const wallShape = { kind: "box", halfExtents: { x: 2, y: 2, z: 0.1 } };
  const walls: Array<[string, SerializedComponent[]]> = [
    ["a static Collider", [
      component("wall-body", "RigidBodyComponent", { motionType: "static" }),
      component("wall-collider", "ColliderComponent", { shape: wallShape }),
    ]],
    // As the Feature Test's Camera Probe Wall: a 1.5 m box mesh with simple collision, scaled to 0.2 m thick.
    ["a box Mesh with simple collision", [{
      ...createMeshComponent("wall-mesh", "box", "simple"),
      transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [4 / 1.5, 4 / 1.5, 0.2 / 1.5] },
    }]],
  ];

  it.each(walls)("shortens the arm the renderer draws in front of %s, past a dynamic body", (_wall, wallComponents) => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({ seed: 1, preferSoftwarePhysics: true,
      playScene: { name: "Probe", viewportMode: "3d", settings: createDefaultSceneSettings(), folders: [], actors: [
        createActor("hero", "Hero", { components: [
          component("arm", "SpringArmComponent", { armLength: 4, cameraProbe: true, probeSize: 0.15 }),
          component("cam", "CameraComponent", {}, [0, 0, 0], "arm"),
        ] }),
        // The wall's near face is at z = -1.9: a 0.15 probe stops after 1.75.
        createActor("wall", "Wall", { transform: { position: [0, 0, -2], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, components: wallComponents }),
        // A floating dynamic crate nearer the pivot: the default Static channel passes through it.
        createActor("crate", "Crate", { transform: { position: [0, 0, -1], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, components: [
          component("crate-body", "RigidBodyComponent", { motionType: "dynamic", mass: 1, gravityScale: 0 }),
          component("crate-collider", "ColliderComponent", { shape: wallShape }),
        ] }),
      ] },
      onCommand: (command) => commands.push(command),
    });
    try {
      runtime.realizePlayWorld();
      runtime.start();
      runtime.tick();
      const armPart = commands.flatMap((command) => command.type === "assignMesh" ? command.parts ?? [] : [])
        .find((part) => part.meshKind === "springarm");
      const probe = commands.find((command): command is ProbeCommand => command.type === "springArmProbe");
      expect(armPart).toBeDefined();
      // The renderer finds the arm by the same component id its visual was assigned with.
      expect(probe?.arms).toEqual([{ slotId: expect.any(Number), componentId: armPart!.componentId, length: expect.any(Number) }]);
      expect(probe!.arms[0]!.length).toBeCloseTo(1.75, 2);
    } finally { runtime.stop(); }
  });
});

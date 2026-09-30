import { describe, expect, it } from "vitest";
import { createActor, createDefaultSceneSettings, type SerializedActor } from "@babylonslate/core";
import { createInProcessRuntime } from "./driver";
import type { CompiledScript } from "./script-host";

const events = ["onMovementStarted", "onMovementStopped", "onMovementJumped", "onMovementLeftGround", "onMovementLanded"];
const controlScript: CompiledScript = {
  assetGuid: "hero-script", classId: "Hero", parentClassId: "Actor", anchors: [],
  source: `
    export function control(ctx) {
      const component = ctx.getComponentById(ctx.self, "motor");
      const result = ctx.callComponentFunction(component, ctx.args.method, ctx.args.values || {});
      ctx.setVariable("result", result);
    }
    ${events.map((name) => `export function ${name}(ctx) {
      ctx.setVariable("events", [...(ctx.getVariable("events") || []), { name: "${name}", ...ctx.args }]);
    }`).join("\n")}
    export function unrelated(ctx) { ctx.setVariable("wrongComponentEvent", true); }
  `,
  entryPoints: [
    { name: "control", event: "control", isAsync: false },
    ...events.map((name) => ({ name, event: name, isAsync: false, componentId: "motor" })),
    { name: "unrelated", event: "onMovementStarted", isAsync: false, componentId: "different-motor" },
  ],
};

async function setup(kind: "3d" | "2d", properties: Record<string, unknown> = {}, floor = false) {
  const actors: SerializedActor[] = [createActor("hero", "Hero", {
    classId: "Hero", transform: { position: [0, floor ? 0.9 : 3, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    components: [{ id: "motor", classId: "MovementComponent", properties }],
  })];
  if (floor) actors.push(createActor("floor", "Floor", {
    transform: { position: [0, -0.5, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    components: [
      { id: "body", classId: "RigidBodyComponent", properties: { motionType: "static" } },
      { id: "collider", classId: "ColliderComponent", properties: { shape: kind === "3d"
        ? { kind: "box", halfExtents: { x: 100, y: 0.5, z: 100 } }
        : { kind: "box2d", halfExtents: { x: 100, y: 0.5 } } } },
    ],
  }));
  const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
    physicsWorld: kind, playScene: { name: "Movement", viewportMode: kind,
      settings: { ...createDefaultSceneSettings(), physicsWorld: kind }, actors, folders: [] } });
  await runtime.loadScripts([controlScript]);
  runtime.realizePlayWorld(); runtime.start();
  const actor = runtime.getWorld().findActor("hero")!;
  const motor = actor.components.find((component) => component.guid === "motor")!;
  const call = (method: string, values: Record<string, unknown> = {}) => runtime.invokeScriptEvent("Hero", "control", actor, { method, values });
  const tick = (count = 1) => { for (let i = 0; i < count; i++) runtime.tick(); };
  return { runtime, actor, motor, call, tick };
}

describe("Movement through the shared Play/player runtime", () => {
  it.each(["3d", "2d"] as const)("clamps combined input and brakes after release in %s, with component-bound transitions", async (kind) => {
    const { runtime, actor, motor, call, tick } = await setup(kind, { gravityScale: 0, acceleration: 600, braking: 600, airControl: 1 });
    try {
      call("setMovementInput", { direction: { x: 1, y: 20, z: 1 } });
      tick(60);
      expect(motor.getVariable("speed")).toBeCloseTo(5);
      expect(actor.transform.position.y).toBeCloseTo(3);
      if (kind === "3d") {
        expect(actor.transform.position.x).toBeCloseTo(5 / Math.sqrt(2));
        expect(actor.transform.position.z).toBeCloseTo(5 / Math.sqrt(2));
      } else {
        expect(actor.transform.position.x).toBeCloseTo(5);
        expect(actor.transform.position.z).toBe(0);
      }
      call("setMovementInput", { direction: { x: 0, y: 0, z: 0 } });
      tick(3);
      expect(motor.getVariable("speed")).toBe(0);
      expect((actor.getVariable("events") as Array<{ name: string }>).map((event) => event.name))
        .toEqual(["onMovementStarted", "onMovementStopped"]);
      expect(actor.getVariable("wrongComponentEvent")).toBeUndefined();
    } finally { runtime.stop(); }
  });

  it("converts stick strength, dead zone and heading without moving until the graph applies it", async () => {
    const { runtime, actor, call, tick } = await setup("3d", { gravityScale: 0, deadZone: 0.2, inputScale: 0.5, inputYaw: 30 });
    try {
      call("convertMovementInput", { input: { x: 0, y: 0.6 }, yaw: 60 });
      const result = actor.getVariable("result") as { direction: { x: number; y: number; z: number } };
      expect(result.direction.x).toBeCloseTo(0.25);
      expect(result.direction.y).toBe(0);
      expect(result.direction.z).toBeCloseTo(0);
      tick(2);
      expect(actor.transform.position.x).toBe(0);
      call("convertMovementInput", { input: { x: 0.1, y: 0.1 } });
      expect(actor.getVariable("result")).toEqual({ direction: { x: 0, y: 0, z: 0 } });
      actor.transform.rotation = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 };
      actor.components[0]!.setVariable("inputSpace", "actor");
      call("convertMovementInput", { input: { x: 0, y: 1 }, yaw: -30 });
      expect((actor.getVariable("result") as typeof result).direction.x).toBeCloseTo(0.5);
    } finally { runtime.stop(); }
  });

  it("consumes added input once, exposes velocity changes, and clears requests when disabled", async () => {
    const { runtime, actor, motor, call, tick } = await setup("3d", { gravityScale: 0, acceleration: 600, braking: 600, airControl: 1 });
    try {
      call("addMovementInput", { direction: { x: 1, y: 0, z: 0 } });
      tick();
      expect(actor.transform.position.x).toBeCloseTo(5 / 60);
      tick(2);
      expect(actor.transform.position.x).toBeCloseTo(5 / 60);
      motor.setVariable("airControl", 0);
      call("setMovementVelocity", { velocity: { x: 2, y: 3, z: 0 } });
      call("addMovementVelocity", { velocity: { x: 1, y: 0, z: 0 } });
      tick();
      expect(motor.getVariable("velocity")).toEqual({ x: expect.closeTo(3), y: expect.closeTo(3), z: 0 });
      expect(actor.transform.position.y).toBeCloseTo(3.05);
      call("setMovementInput", { direction: { x: 1, y: 0, z: 0 } });
      motor.setVariable("enabled", false);
      const position = { ...actor.transform.position };
      tick(2);
      expect(actor.transform.position).toEqual(position);
      motor.setVariable("enabled", true);
      motor.setVariable("airControl", 1);
      tick();
      expect(motor.getVariable("speed")).toBe(0);
    } finally { runtime.stop(); }
  });

  it.each(["3d", "2d"] as const)("jumps once, rejects a second airborne jump, and lands in %s", async (kind) => {
    const { runtime, actor, motor, call, tick } = await setup(kind, { jumpBufferTime: 0 }, true);
    try {
      tick(3);
      expect(motor.getVariable("isGrounded")).toBe(true);
      actor.setVariable("events", []);
      call("jumpMovement"); tick();
      expect(motor.getVariable("isInAir")).toBe(true);
      expect((motor.getVariable("velocity") as { y: number }).y).toBeGreaterThan(5);
      call("jumpMovement"); tick();
      tick(100);
      expect(actor.transform.position.y).toBeCloseTo(0.9, 1);
      expect(motor.getVariable("isGrounded")).toBe(true);
      expect((actor.getVariable("events") as Array<{ name: string }>).map((event) => event.name))
        .toEqual(["onMovementJumped", "onMovementLeftGround", "onMovementLanded"]);
    } finally { runtime.stop(); }
  });

  it("buffers a jump shortly before landing and stop clears a pending jump", async () => {
    const { runtime, actor, motor, call, tick } = await setup("3d", { jumpBufferTime: 0.2 }, true);
    try {
      // Start just above the ground, falling fast enough to land in one tick.
      actor.transform.position.y = 0.93;
      runtime.getPhysicsSync()!.teleportActor(actor, runtime.getWorld());
      call("setMovementVelocity", { velocity: { x: 0, y: -3, z: 0 } });
      call("jumpMovement"); tick(2);
      expect(motor.getVariable("isInAir")).toBe(true);
      expect((actor.getVariable("events") as Array<{ name: string }>).some((event) => event.name === "onMovementJumped")).toBe(true);
      call("jumpMovement"); call("stopMovementImmediately"); tick(100);
      expect((actor.getVariable("events") as Array<{ name: string }>).filter((event) => event.name === "onMovementJumped")).toHaveLength(1);
      expect(motor.getVariable("isGrounded")).toBe(true);
    } finally { runtime.stop(); }
  });

  it.each([0, 1])("leaving a ledge respects gravity scale %s and the fall cap, with a short coyote jump window", async (gravityScale) => {
    const { runtime, actor, motor, call, tick } = await setup("3d", { gravityScale, maxFallSpeed: 1, acceleration: 600, airControl: 1 }, true);
    try {
      const floor = runtime.getWorld().findActor("floor")!;
      floor.components.find((component) => component.classId === "ColliderComponent")!
        .setVariable("shape", { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 4 } });
      tick(3);
      expect(motor.getVariable("isGrounded")).toBe(true);
      call("setMovementInput", { direction: { x: 1, y: 0, z: 0 } });
      for (let i = 0; i < 30 && motor.getVariable("isGrounded"); i++) tick();
      expect(motor.getVariable("isInAir")).toBe(true);
      expect((motor.getVariable("velocity") as { y: number }).y).toBeGreaterThanOrEqual(-1);
      if (gravityScale === 0) expect(actor.transform.position.y).toBeCloseTo(0.9);
      call("jumpMovement"); tick();
      expect((motor.getVariable("velocity") as { y: number }).y).toBeGreaterThan(5);
      tick(12);
      call("jumpMovement"); tick();
      expect((actor.getVariable("events") as Array<{ name: string }>).filter((event) => event.name === "onMovementJumped")).toHaveLength(1);
    } finally { runtime.stop(); }
  });
});

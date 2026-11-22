import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SNAPSHOT_ACTOR_STRIDE,
  SNAPSHOT_HEADER_FLOATS,
  readSnapshotHeader,
  snapshotFloatCount,
  writeActorSlot,
  type CommandMessage,
} from "@haptic/bridge";
import { ClassRegistry, World, type Actor } from "@haptic/object-model";
import { RenderSlots } from "./render-slots";
import { RuntimeSubsystems } from "./runtime-subsystems";
import { SnapshotPublisher } from "./snapshot-publisher";

vi.mock("@haptic/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@haptic/bridge")>();
  return { ...actual, writeActorSlot: vi.fn(actual.writeActorSlot) };
});

const LAYER = "layer";

/** A World, its slot table and a publisher, driven only through the public World and slot APIs. */
class Session {
  readonly world = new World({ seed: 1, dt: 1 / 60, classRegistry: new ClassRegistry() });
  readonly slots: RenderSlots;
  publisher: SnapshotPublisher;
  readonly despawns: string[] = [];
  cameraGuid: string | null = null;
  private frame = 0;
  private components = 0;

  constructor(capacity: number) {
    this.slots = new RenderSlots(new RuntimeSubsystems(), {
      ensureCapacity: (required) => this.publisher.ensureCapacity(required),
      findActor: (guid) => this.world.findActor(guid),
    });
    this.publisher = this.createPublisher(capacity);
  }

  createPublisher(capacity: number): SnapshotPublisher {
    return new SnapshotPublisher(capacity, this.world, this.slots, {
      stopped: () => false,
      frameId: () => ++this.frame,
      lastScriptMs: () => 0,
      lastPhysicsMs: () => 0,
      canPublish: () => true,
      cameraActor: () => (this.cameraGuid ? this.world.findActor(this.cameraGuid) ?? null : null),
      // Without a camera actor the origin follows this centre, so every frame decides its own origin cell.
      layerCameraCentre: () => ({ x: -1500, y: 0 }),
      applyOverlayLayouts: () => {},
      retireDetachedStreams: () => {},
      removedActors: () => {},
      recorder: () => null,
      profilePublish: () => {},
      reportLog: () => {},
      reportError: (error) => { throw error; },
      emit: (command: CommandMessage) => { if (command.type === "despawn") this.despawns.push(`${command.slotId}:${command.actorGuid}`); },
    }, () => 0);
  }

  create(guid: string, parentId: string | null, x: number): Actor {
    return this.world.createActor({
      classId: "Actor",
      guid,
      variables: parentId ? { parentId } : {},
      transform: { position: { x, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
    });
  }

  attach(actor: Actor, classId: string): void {
    actor.attachComponent(this.world.createComponent({ classId, guid: `component-${this.components++}` }));
  }

  /** The published header fields a fresh publisher shares, the rows' bits and the slot table. */
  published() {
    const buf = new Float32Array(snapshotFloatCount(this.publisher.capacity));
    expect(this.publisher.copy(buf)).toBe(true);
    const header = readSnapshotHeader(buf);
    const end = SNAPSHOT_HEADER_FLOATS + header.actorCount * SNAPSHOT_ACTOR_STRIDE;
    return {
      actorCount: header.actorCount,
      origin: header.origin,
      rows: Array.from(new Uint32Array(buf.buffer, SNAPSHOT_HEADER_FLOATS * 4, end - SNAPSHOT_HEADER_FLOATS)),
      slots: Array.from(this.slots.entries(), ([slotId, owner]) => `${slotId}:${owner.guid}`),
    };
  }
}

type Op =
  | { kind: "spawn"; guid: number; parent: number | null; x: number; slot: boolean; queued: boolean }
  | { kind: "flush" }
  | { kind: "cancel"; actor: number }
  | { kind: "destroy"; actor: number; flush: boolean }
  | { kind: "reparent"; actor: number; parent: number | null }
  | { kind: "move"; actor: number; x: number }
  | { kind: "turn"; actor: number }
  | { kind: "stretch"; actor: number }
  | { kind: "visible"; actor: number; visible: boolean }
  | { kind: "attach"; actor: number; anchor: boolean }
  | { kind: "detachAll"; actor: number }
  | { kind: "layer"; actor: number; layer: boolean }
  | { kind: "allocate"; actor: number }
  | { kind: "release"; actor: number }
  | { kind: "camera"; actor: number | null }
  | { kind: "restart" }
  | { kind: "publish" };

const guidOf = (index: number) => `g${index}`;

/** Every actor object created for `guid`, newest last; ops address the newest. */
function newest(actors: Map<string, Actor[]>, index: number): Actor | undefined {
  return actors.get(guidOf(index))?.at(-1);
}

/**
 * Whether parenting `guid` to `parentGuid` closes a cycle through live or queued actors. Script writes and
 * loads refuse such links, so the runtime never publishes a cyclic hierarchy.
 */
function closesCycle(actors: Map<string, Actor[]>, guid: string, parentGuid: string | null): boolean {
  const seen = new Set<string>();
  for (let current = parentGuid; current !== null && !seen.has(current);) {
    if (current === guid) return true;
    seen.add(current);
    const holder = actors.get(current)?.at(-1);
    if (!holder || holder.destroyed) return false;
    const next = holder.getVariable("parentId");
    current = typeof next === "string" && next.length > 0 ? next : null;
  }
  return false;
}

function apply(session: Session, actors: Map<string, Actor[]>, op: Op): void {
  const world = session.world;
  const target = "actor" in op && op.actor !== null ? newest(actors, op.actor) : undefined;
  switch (op.kind) {
    case "spawn": {
      const guid = guidOf(op.guid);
      const parent = op.parent === null ? null : guidOf(op.parent);
      // A live or queued holder keeps its guid.
      if (newest(actors, op.guid)?.destroyed === false || closesCycle(actors, guid, parent)) return;
      const actor = session.create(guid, parent, op.x);
      actors.set(guid, [...(actors.get(guid) ?? []), actor]);
      if (op.slot) session.slots.allocate(actor);
      if (op.queued) world.spawnActor(actor);
      else world.spawnActorNow(actor);
      return;
    }
    case "flush":
      world.flushPending();
      return;
    case "cancel":
      if (target && world.isSpawnQueued(target)) world.destroyActorInstance(target);
      return;
    case "destroy":
      if (target?.world === world) {
        world.destroyActorInstance(target);
        if (op.flush) world.flushPending();
      }
      return;
    case "reparent": {
      const parent = op.parent === null ? null : guidOf(op.parent);
      if (target?.world === world && !closesCycle(actors, target.guid, parent)) target.setVariable("parentId", parent);
      return;
    }
    case "move":
      if (target?.world === world) target.transform.position.x = op.x;
      return;
    case "turn":
      if (target?.world === world) target.transform = { ...target.transform, rotation: { x: 0, y: Math.SQRT1_2 / 2, z: 0, w: Math.sqrt(1 - 0.125) } };
      return;
    case "stretch":
      if (target?.world === world) target.transform.scale.x = 3;
      return;
    case "visible":
      if (target?.world === world) target.setVariable("visible", op.visible);
      return;
    case "attach":
      if (target?.world === world) session.attach(target, op.anchor ? "2DAnchorComponent" : "MeshComponent");
      return;
    case "detachAll":
      // As the runtime ends components: the flag, then On Destroyed.
      if (target?.world === world) {
        for (const component of target.components) {
          component.destroyed = true;
          component.callOnDestroyed();
        }
      }
      return;
    case "layer":
      if (target?.world === world) target.sceneLayerId = op.layer ? LAYER : null;
      return;
    case "allocate":
      if (target && !target.destroyed && session.slots.actorSlot(target) === undefined) session.slots.allocate(target);
      return;
    case "release": {
      const slotId = target ? session.slots.actorSlot(target) : undefined;
      if (slotId !== undefined) session.slots.release(slotId);
      return;
    }
    case "camera":
      session.cameraGuid = op.actor === null ? null : guidOf(op.actor);
      return;
    case "restart":
      session.publisher.dispose();
      session.publisher = session.createPublisher(session.publisher.capacity);
      return;
    case "publish":
      session.publisher.publish();
      return;
  }
}

const GUIDS = 12;
const actorIndex = fc.integer({ min: 0, max: GUIDS - 1 });
const op: fc.Arbitrary<Op> = fc.oneof(
  { arbitrary: fc.record({ kind: fc.constant("spawn" as const), guid: actorIndex, parent: fc.option(actorIndex), x: fc.integer({ min: -1200, max: 1200 }), slot: fc.constantFrom(true, true, true, false), queued: fc.boolean() }), weight: 12 },
  { arbitrary: fc.constant({ kind: "flush" as const }), weight: 4 },
  { arbitrary: fc.record({ kind: fc.constant("cancel" as const), actor: actorIndex }), weight: 2 },
  { arbitrary: fc.record({ kind: fc.constant("destroy" as const), actor: actorIndex, flush: fc.boolean() }), weight: 10 },
  { arbitrary: fc.record({ kind: fc.constant("reparent" as const), actor: actorIndex, parent: fc.option(actorIndex) }), weight: 6 },
  { arbitrary: fc.record({ kind: fc.constant("move" as const), actor: actorIndex, x: fc.integer({ min: -1200, max: 1200 }) }), weight: 6 },
  { arbitrary: fc.record({ kind: fc.constant("turn" as const), actor: actorIndex }), weight: 2 },
  { arbitrary: fc.record({ kind: fc.constant("stretch" as const), actor: actorIndex }), weight: 2 },
  { arbitrary: fc.record({ kind: fc.constant("visible" as const), actor: actorIndex, visible: fc.boolean() }), weight: 2 },
  { arbitrary: fc.record({ kind: fc.constant("attach" as const), actor: actorIndex, anchor: fc.boolean() }), weight: 4 },
  { arbitrary: fc.record({ kind: fc.constant("detachAll" as const), actor: actorIndex }), weight: 2 },
  { arbitrary: fc.record({ kind: fc.constant("layer" as const), actor: actorIndex, layer: fc.boolean() }), weight: 2 },
  { arbitrary: fc.record({ kind: fc.constant("allocate" as const), actor: actorIndex }), weight: 2 },
  { arbitrary: fc.record({ kind: fc.constant("release" as const), actor: actorIndex }), weight: 2 },
  { arbitrary: fc.record({ kind: fc.constant("camera" as const), actor: fc.option(actorIndex) }), weight: 1 },
  { arbitrary: fc.constant({ kind: "restart" as const }), weight: 1 },
  { arbitrary: fc.constant({ kind: "publish" as const }), weight: 18 },
);

/**
 * Drive the same edits through a long-lived publisher and, as the reference, a fresh publisher for every
 * frame (which composes the whole World, writes every row and checks every slot), and compare each frame.
 */
function expectSameFrames(ops: readonly Op[]): void {
  // A small capacity also exercises buffer growth on the incremental side.
  const incremental = new Session(2);
  const reference = new Session(64);
  const actorsA = new Map<string, Actor[]>();
  const actorsB = new Map<string, Actor[]>();
  for (const [step, edit] of [...ops, { kind: "publish" as const }, { kind: "publish" as const }].entries()) {
    apply(incremental, actorsA, edit);
    if (edit.kind === "restart") continue;
    if (edit.kind !== "publish") {
      apply(reference, actorsB, edit);
      continue;
    }
    reference.publisher.dispose();
    reference.publisher = reference.createPublisher(64);
    apply(reference, actorsB, edit);
    expect({ step, ...incremental.published(), despawns: incremental.despawns })
      .toEqual({ step, ...reference.published(), despawns: reference.despawns });
  }
  incremental.publisher.dispose();
  reference.publisher.dispose();
}

afterEach(() => {
  vi.mocked(writeActorSlot).mockClear();
});

describe("incremental snapshot publishing", () => {
  it("publishes the frames and despawns a whole-World pass publishes, for every seeded edit sequence", () => {
    for (const seed of [11, 2026, 90210]) {
      // `size: "max"` lets sequences reach their full length, so most frames take the incremental path.
      fc.assert(fc.property(fc.array(op, { minLength: 1, maxLength: 120, size: "max" }), expectSameFrames), { seed, numRuns: 100 });
    }
  });

  it("matches a whole-World pass through edits that share one frame", () => {
    const spawn = (guid: number, parent: number | null = null, queued = false): Op =>
      ({ kind: "spawn", guid, parent, x: guid, slot: true, queued });
    expectSameFrames([
      spawn(0), spawn(1, 0), spawn(2, 1), spawn(3), { kind: "publish" }, { kind: "publish" },
      // A middle row leaves, then a frame without layout changes writes the other buffer.
      spawn(9), { kind: "publish" }, { kind: "destroy", actor: 3, flush: true }, { kind: "publish" },
      { kind: "move", actor: 0, x: 2 }, { kind: "publish" }, { kind: "publish" }, spawn(3), { kind: "publish" },
      // Spawn then destroy in one frame; destroy a parent with children; a child that spawned before its parent.
      spawn(4), { kind: "destroy", actor: 4, flush: true }, { kind: "destroy", actor: 0, flush: true }, { kind: "publish" },
      spawn(5, 6), spawn(6), { kind: "publish" },
      // Reparent across Scene Layers, then a successor reusing a departed guid.
      { kind: "layer", actor: 3, layer: true }, { kind: "reparent", actor: 1, parent: 3 }, { kind: "publish" },
      spawn(0, 3), { kind: "publish" },
      // A cancelled queued spawn, and one that commits.
      spawn(7, null, true), { kind: "publish" }, { kind: "cancel", actor: 7 }, { kind: "publish" },
      spawn(8, 3, true), { kind: "publish" }, { kind: "flush" }, { kind: "publish" },
      // An actor becomes anchor-only, then gains a visual again; a camera far away moves the origin.
      { kind: "attach", actor: 2, anchor: true }, { kind: "publish" }, { kind: "attach", actor: 2, anchor: false },
      { kind: "camera", actor: 6 }, { kind: "move", actor: 6, x: 5000 }, { kind: "publish" },
      // Publishing restarts on the same World (Play stop and start).
      { kind: "restart" }, { kind: "destroy", actor: 3, flush: true }, { kind: "publish" },
    ]);
  });
});

describe("incremental snapshot publishing cost", () => {
  /** 5,000 static root actors plus a 3-actor subtree and a reparent target, both buffers seeded. */
  function bigWorld() {
    const session = new Session(8192);
    // Whole-World passes read every actor's transform (composition) and components (row membership).
    const counts = { compositions: 0, visits: 0 };
    const spawn = (guid: string, parentId: string | null = null) => {
      const actor = session.create(guid, parentId, 0);
      let transform = actor.transform;
      const components = actor.components;
      Object.defineProperty(actor, "transform", {
        configurable: true,
        get: () => { counts.compositions += 1; return transform; },
        set: (value: Actor["transform"]) => { transform = value; },
      });
      Object.defineProperty(actor, "components", { configurable: true, get: () => { counts.visits += 1; return components; } });
      session.slots.allocate(actor);
      return session.world.spawnActorNow(actor);
    };
    for (let index = 0; index < 5000; index++) spawn(`static-${index}`);
    const subtree = spawn("subtree");
    spawn("subtree-child", "subtree");
    spawn("subtree-grandchild", "subtree-child");
    const target = spawn("target");
    session.publisher.publish();
    session.publisher.publish();
    const lookups = vi.spyOn(session.world, "findActor");
    /** Publish this frame and the next (which brings the other buffer up to date), and count both. */
    const measure = (edit: () => void) => {
      edit();
      counts.compositions = 0;
      counts.visits = 0;
      lookups.mockClear();
      vi.mocked(writeActorSlot).mockClear();
      session.publisher.publish();
      session.publisher.publish();
      return { ...counts, rowsWritten: vi.mocked(writeActorSlot).mock.calls.length, lookups: lookups.mock.calls.length };
    };
    return { session, spawn, subtree, target, measure };
  }

  it("spends work on a spawn, destroy, reparent or component attach, not on the World", () => {
    const { session, spawn, subtree, target, measure } = bigWorld();
    // One row write per buffer for each changed actor.
    expect(measure(() => spawn("fresh"))).toEqual({ compositions: 1, visits: 1, rowsWritten: 2, lookups: 1 });
    expect(measure(() => {
      session.world.destroyActor("static-2500");
      session.world.flushPending();
    })).toEqual({ compositions: 0, visits: 0, rowsWritten: 0, lookups: 2 });
    expect(measure(() => subtree.setVariable("parentId", target.guid)))
      .toEqual({ compositions: 3, visits: 0, rowsWritten: 6, lookups: 3 });
    expect(measure(() => session.attach(session.world.findActor("static-100")!, "MeshComponent")))
      .toEqual({ compositions: 0, visits: 1, rowsWritten: 2, lookups: 0 });
    session.publisher.dispose();
  });

  it("moves each row at most once when a frame removes and inserts many rows", () => {
    const { session, spawn } = bigWorld();
    const moved = vi.spyOn(Float32Array.prototype, "copyWithin");
    try {
      for (let index = 0; index < 5000; index += 2) session.world.destroyActor(`static-${index}`);
      session.world.flushPending();
      for (let index = 0; index < 2000; index++) spawn(`streamed-${index}`);
      session.publisher.publish();
      const rows = moved.mock.calls.reduce((total, [, start, end]) => total + (end! - start) / SNAPSHOT_ACTOR_STRIDE, 0);
      expect(rows).toBeLessThanOrEqual(5004);
      expect(session.published().actorCount).toBe(2500 + 4 + 2000);
    } finally {
      moved.mockRestore();
      session.publisher.dispose();
    }
  });
});

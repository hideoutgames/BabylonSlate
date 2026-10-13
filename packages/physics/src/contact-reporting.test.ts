import { describe, expect, it } from "vitest";
import { createPhysicsBackend, type PhysicsBackend, type PhysicsContactEvent } from "./index";

const identity = { x: 0, y: 0, z: 0, w: 1 };

function spawn(
  backend: PhysicsBackend,
  id: string,
  motionType: "static" | "dynamic",
  position: { x: number; y: number; z: number },
  shape: Parameters<PhysicsBackend["createCollider"]>[0]["shape"],
  options: { reportContacts?: boolean; isTrigger?: boolean } = {},
) {
  backend.createBody({
    id, actorId: `actor-${id}`, motionType, mass: motionType === "static" ? 0 : 1,
    linearDamping: 0, angularDamping: 0, gravityScale: 0,
    transform: { position, rotation: identity },
    ...(options.reportContacts === undefined ? {} : { reportContacts: options.reportContacts }),
  });
  backend.createCollider({
    id: `${id}-collider`, bodyId: id, shape, friction: 0.5, restitution: 0,
    isTrigger: options.isTrigger ?? false, layer: 1, mask: 0xffffffff,
  });
}

/** A ball held against a floor by a constant downward speed, so it stays awake and in contact. */
async function ballOnFloor(floor: boolean | undefined, ball: boolean | undefined) {
  const backend = await createPhysicsBackend({ kind: "3d", gravity: { x: 0, y: 0, z: 0 }, allowSoftwareFallback: false });
  spawn(backend, "floor", "static", { x: 0, y: -0.5, z: 0 }, { kind: "box", halfExtents: { x: 5, y: 0.5, z: 5 } }, { reportContacts: floor });
  spawn(backend, "ball", "dynamic", { x: 0, y: 0.24, z: 0 }, { kind: "sphere", radius: 0.25 }, { reportContacts: ball });
  return backend;
}

function pressAndCountHits(backend: PhysicsBackend, steps: number): number {
  let hits = 0;
  for (let step = 0; step < steps; step++) {
    backend.setBodyLinearVelocity("ball", { y: -1 });
    backend.step(1 / 60);
    hits += backend.pollContacts().filter((event) => event.kind === "hit").length;
  }
  return hits;
}

describe("Havok contact reporting", () => {
  it.each([
    { floor: true, ball: true, reported: true },
    { floor: undefined, ball: undefined, reported: true },
    { floor: false, ball: true, reported: true },
    { floor: true, ball: false, reported: true },
    { floor: false, ball: false, reported: false },
  ])("reports a hit when either body reports (floor $floor, ball $ball)", async ({ floor, ball, reported }) => {
    const backend = await ballOnFloor(floor, ball);
    try {
      const hits = pressAndCountHits(backend, 30);
      if (reported) expect(hits).toBeGreaterThan(0);
      else expect(hits).toBe(0);
    } finally { backend.dispose(); }
  });

  it("follows setContactReporting for the actor's bodies while a contact stays open", async () => {
    const backend = await ballOnFloor(true, true);
    try {
      expect(pressAndCountHits(backend, 20)).toBeGreaterThan(0);
      backend.setContactReporting!("actor-floor", false);
      backend.setContactReporting!("actor-ball", false);
      backend.pollContacts();
      expect(pressAndCountHits(backend, 20)).toBe(0);
      backend.setContactReporting!("actor-ball", true);
      expect(pressAndCountHits(backend, 20)).toBeGreaterThan(0);
      // An actor without bodies is not an error.
      expect(() => backend.setContactReporting!("nobody", false)).not.toThrow();
    } finally { backend.dispose(); }
  });

  it("changes a body's reporting only after its open trigger overlap ends", async () => {
    const backend = await createPhysicsBackend({ kind: "3d", gravity: { x: 0, y: 0, z: 0 }, allowSoftwareFallback: false });
    try {
      spawn(backend, "zone", "static", { x: 0, y: 0, z: 0 }, { kind: "box", halfExtents: { x: 1, y: 1, z: 1 } }, { isTrigger: true });
      spawn(backend, "wall", "static", { x: 4, y: 0, z: 0 }, { kind: "box", halfExtents: { x: 0.5, y: 2, z: 2 } }, { reportContacts: false });
      spawn(backend, "mover", "dynamic", { x: -3, y: 0, z: 0 }, { kind: "sphere", radius: 0.25 });
      const overlaps: string[] = [];
      let hits = 0;
      for (let step = 0; step < 300; step++) {
        // The mover crosses the zone from step ~52 to ~128; muting it in the middle must not end that overlap.
        if (step === 100) backend.setContactReporting!("actor-mover", false);
        backend.setBodyLinearVelocity("mover", { x: 2 });
        backend.step(1 / 60);
        for (const event of backend.pollContacts()) {
          if (event.kind === "hit") hits++;
          else overlaps.push(`${step >= 120 ? "late" : "early"} ${event.kind}`);
        }
      }
      // One begin on the way in, one end only at the real exit, and no hits once the muting took effect at the wall.
      expect(overlaps).toEqual(["early overlapBegin", "late overlapEnd"]);
      expect(hits).toBe(0);
    } finally { backend.dispose(); }
  });

  it("keeps overlap begin and end events when no body reports contacts", async () => {
    const backend = await createPhysicsBackend({ kind: "3d", gravity: { x: 0, y: 0, z: 0 }, allowSoftwareFallback: false });
    try {
      spawn(backend, "zone", "static", { x: 0, y: 0, z: 0 }, { kind: "box", halfExtents: { x: 1, y: 1, z: 1 } },
        { reportContacts: false, isTrigger: true });
      spawn(backend, "mover", "dynamic", { x: -3, y: 0, z: 0 }, { kind: "sphere", radius: 0.25 }, { reportContacts: false });
      backend.setBodyLinearVelocity("mover", { x: 2 });
      const seen: PhysicsContactEvent["kind"][] = [];
      for (let step = 0; step < 300; step++) {
        backend.step(1 / 60);
        for (const event of backend.pollContacts()) seen.push(event.kind);
      }
      expect(seen).toEqual(["overlapBegin", "overlapEnd"]);
    } finally { backend.dispose(); }
  });
});

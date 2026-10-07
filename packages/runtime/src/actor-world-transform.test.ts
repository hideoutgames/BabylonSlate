import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  composeAffineTransform,
  multiplyAffineTransforms,
  type AffineTransform,
  type Quat,
  type Transform,
} from "@babylonslate/core";
import { ClassRegistry, World, type Actor } from "@babylonslate/object-model";
import {
  actorWorldTransform,
  composeActorWorldTransforms,
  composeParentChildTransform,
  firstSpawnedActorIndex,
  multiplyQuaternion,
  relativeTransform,
  WorldTransformComposer,
} from "./actor-world-transform";

type Node = { parent: number; transform: Transform };

const S = Math.SQRT1_2;
const quarterTurns: Quat[] = [
  { x: S, y: 0, z: 0, w: S },
  { x: 0, y: S, z: 0, w: S },
  { x: 0, y: 0, z: S, w: S },
];

function transform(
  position: [number, number, number],
  rotation: Quat,
  scale: [number, number, number],
): Transform {
  return {
    position: { x: position[0], y: position[1], z: position[2] },
    rotation,
    scale: { x: scale[0], y: scale[1], z: scale[2] },
  };
}

function spawnHierarchy(nodes: readonly Node[]): Actor[] {
  const world = new World({ seed: 1, dt: 1 / 60, classRegistry: new ClassRegistry() });
  return nodes.map((node, index) => {
    const actor = world.createActor({
      classId: "Actor",
      guid: `actor-${index}`,
      transform: structuredClone(node.transform),
      variables: node.parent >= 0 ? { parentId: `actor-${node.parent}` } : {},
    });
    world.spawnActorNow(actor);
    return actor;
  });
}

/** Authored world matrices: each local matrix times its parent's world matrix. */
function authoredWorlds(nodes: readonly Node[]): AffineTransform[] {
  const worlds: AffineTransform[] = [];
  nodes.forEach((node, index) => {
    const local = composeAffineTransform(node.transform);
    worlds[index] = node.parent >= 0 ? multiplyAffineTransforms(local, worlds[node.parent]!) : local;
  });
  return worlds;
}

function expectMatrixClose(actual: AffineTransform, expected: AffineTransform, rows = [0, 1, 2, 3]): void {
  for (const row of rows) {
    for (let column = 0; column < 3; column++) {
      const index = row * 3 + column;
      const tolerance = 1e-9 * Math.max(1, Math.abs(expected[index]!));
      expect(Math.abs(actual[index]! - expected[index]!)).toBeLessThan(tolerance);
    }
  }
}

const sign = fc.constantFrom(-1, 1);
const signedScale = fc.tuple(fc.double({ min: 0.25, max: 3, noNaN: true }), sign).map(([value, s]) => value * s);
const position = fc.double({ min: -10, max: 10, noNaN: true });
const axisAlignedRotation = fc
  .array(fc.constantFrom(...quarterTurns), { maxLength: 3 })
  .map((turns) => turns.reduce(multiplyQuaternion, { x: 0, y: 0, z: 0, w: 1 }));
const component = fc.double({ min: -1, max: 1, noNaN: true });
const anyRotation = fc
  .tuple(component, component, component, component)
  .filter(([x, y, z, w]) => Math.hypot(x, y, z, w) > 0.1)
  .map(([x, y, z, w]) => {
    const length = Math.hypot(x, y, z, w);
    return { x: x / length, y: y / length, z: z / length, w: w / length };
  });

function hierarchy(rotation: fc.Arbitrary<Quat>): fc.Arbitrary<Node[]> {
  return fc
    .array(
      fc.record({
        parent: fc.nat(),
        transform: fc
          .tuple(fc.tuple(position, position, position), rotation, fc.tuple(signedScale, signedScale, signedScale))
          .map(([p, r, s]) => transform(p, r, s)),
      }),
      { minLength: 2, maxLength: 6 },
    )
    // Each actor attaches to an earlier one (or none), so hierarchies are acyclic.
    .map((nodes) => nodes.map((node, index) => ({ ...node, parent: index === 0 ? -1 : (node.parent % (index + 1)) - 1 })));
}

describe("actor world transforms match the authored matrices", () => {
  it("permutes nonuniform parent scale onto a quarter-turned child", () => {
    // Parent scale (2, 1, 1); the child is turned 90 degrees about Z.
    const actors = spawnHierarchy([
      { parent: -1, transform: transform([0, 0, 0], { x: 0, y: 0, z: 0, w: 1 }, [2, 1, 1]) },
      { parent: 0, transform: transform([0, 0, 0], { x: 0, y: 0, z: S, w: S }, [1, 1, 1]) },
    ]);
    const index = firstSpawnedActorIndex(actors);
    const world = composeActorWorldTransforms((guid) => index.get(guid), [actors[1]!]).get("actor-1")!;
    expect(world.rotation).toEqual({ x: 0, y: 0, z: S, w: S });
    expect(world.scale.x).toBeCloseTo(1, 12);
    expect(world.scale.y).toBeCloseTo(2, 12);
    expect(world.scale.z).toBeCloseTo(1, 12);
    // Local X lands on world +Y with length 1; local Y on world -X with length 2.
    expectMatrixClose(composeAffineTransform(world), Float64Array.of(0, 1, 0, -2, 0, 0, 0, 0, 1, 0, 0, 0));
  });

  it("keeps descendants of a sheared actor exact and reports each sheared actor", () => {
    // Parent scale (2, 1, 1), a child turned 45 degrees about Z, and a grandchild at local (1, 0, 0).
    const actors = spawnHierarchy([
      { parent: -1, transform: transform([0, 0, 0], { x: 0, y: 0, z: 0, w: 1 }, [2, 1, 1]) },
      { parent: 0, transform: transform([0, 0, 0], { x: 0, y: 0, z: Math.sin(Math.PI / 8), w: Math.cos(Math.PI / 8) }, [1, 1, 1]) },
      { parent: 1, transform: transform([1, 0, 0], { x: 0, y: 0, z: 0, w: 1 }, [1, 1, 1]) },
    ]);
    const sheared: string[] = [];
    const index = firstSpawnedActorIndex(actors);
    const worlds = composeActorWorldTransforms((guid) => index.get(guid), actors, (actor) => sheared.push(actor.guid));
    const grandchild = worlds.get("actor-2")!.position;
    expect(grandchild.x).toBeCloseTo(1.414214, 6);
    expect(grandchild.y).toBeCloseTo(0.707107, 6);
    expect(grandchild.z).toBeCloseTo(0, 12);
    expect(sheared).toEqual(["actor-1", "actor-2"]);
    const chained = actorWorldTransform(actors[2]!, index)!.position;
    expect(chained.x).toBeCloseTo(1.414214, 6);
    expect(chained.y).toBeCloseTo(0.707107, 6);
  });

  it("composes axis-aligned hierarchies with signed nonuniform scale exactly", () => {
    fc.assert(
      fc.property(hierarchy(axisAlignedRotation), (nodes) => {
        const actors = spawnHierarchy(nodes);
        const expected = authoredWorlds(nodes);
        const index = firstSpawnedActorIndex(actors);
        const sheared: Actor[] = [];
        const worlds = composeActorWorldTransforms((guid) => index.get(guid), actors, (actor) => sheared.push(actor));
        expect(sheared).toEqual([]);
        actors.forEach((actor, i) => {
          expectMatrixClose(composeAffineTransform(worlds.get(actor.guid)!), expected[i]!);
          expectMatrixClose(composeAffineTransform(actorWorldTransform(actor, index)!), expected[i]!);
        });
      }),
      { numRuns: 200 },
    );
  });

  it("keeps every position exact through oblique hierarchies", () => {
    fc.assert(
      fc.property(hierarchy(anyRotation), (nodes) => {
        const actors = spawnHierarchy(nodes);
        const expected = authoredWorlds(nodes);
        const index = firstSpawnedActorIndex(actors);
        const worlds = composeActorWorldTransforms((guid) => index.get(guid), actors);
        actors.forEach((actor, i) => {
          expectMatrixClose(composeAffineTransform(worlds.get(actor.guid)!), expected[i]!, [3]);
          expectMatrixClose(composeAffineTransform(actorWorldTransform(actor, index)!), expected[i]!, [3]);
        });
      }),
      { numRuns: 200 },
    );
  });
});

describe("WorldTransformComposer", () => {
  /** Fresh composition of the live world, with the actors it reports sheared. */
  function freshPoses(world: World): { poses: Map<string, Transform>; sheared: string[] } {
    const sheared: string[] = [];
    const poses = composeActorWorldTransforms((guid) => world.findActor(guid), world.getActors(), (actor) => sheared.push(actor.guid));
    return { poses, sheared };
  }

  function composeLive(composer: WorldTransformComposer, world: World) {
    const sheared: string[] = [];
    const poses = composer.compose((guid) => world.findActor(guid), world.getActors(), (actor) => sheared.push(actor.guid));
    return { poses, sheared };
  }

  // Reusing a composer every publish replaces per-actor allocation (about
  // eight objects per actor per frame) with in-place writes; no timing is asserted.
  it("rewrites the same pose objects in place and matches a fresh composition exactly", () => {
    // Each actor's transform before and after an edit, so shear can appear or vanish between passes.
    const edited = hierarchy(anyRotation).chain((nodes) =>
      fc.tuple(fc.constant(nodes), fc.array(fc.tuple(fc.tuple(position, position, position), anyRotation,
        fc.tuple(signedScale, signedScale, signedScale)).map(([p, r, s]) => transform(p, r, s)),
      { minLength: nodes.length, maxLength: nodes.length })));
    fc.assert(
      fc.property(edited, ([nodes, next]) => {
        const actors = spawnHierarchy(nodes);
        const world = actors[0]!.world as World;
        const composer = new WorldTransformComposer();
        const first = composeLive(composer, world);
        // toEqual compares numbers with Object.is, so poses must be bit-identical.
        expect(first).toEqual(freshPoses(world));
        const objects = new Map(first.poses);

        const again = composeLive(composer, world);
        expect(again).toEqual(freshPoses(world));
        for (const [guid, pose] of again.poses) expect(pose).toBe(objects.get(guid));

        actors.forEach((actor, index) => { actor.transform = structuredClone(next[index]!); });
        const moved = composeLive(composer, world);
        expect(moved).toEqual(freshPoses(world));
        for (const [guid, pose] of moved.poses) expect(pose).toBe(objects.get(guid));
      }),
      { numRuns: 200 },
    );
  });

  it("releases poses of removed actors and composes a returning guid afresh", () => {
    const actors = spawnHierarchy([
      { parent: -1, transform: transform([1, 2, 3], { x: 0, y: 0, z: 0, w: 1 }, [2, 1, 1]) },
      { parent: 0, transform: transform([1, 0, 0], { x: 0, y: 0, z: Math.sin(Math.PI / 8), w: Math.cos(Math.PI / 8) }, [1, 1, 1]) },
      { parent: 1, transform: transform([0, 1, 0], { x: 0, y: 0, z: 0, w: 1 }, [1, 1, 1]) },
    ]);
    const world = actors[0]!.world as World;
    const composer = new WorldTransformComposer();
    expect([...composeLive(composer, world).poses.keys()].sort()).toEqual(["actor-0", "actor-1", "actor-2"]);

    world.destroyActor("actor-1");
    world.destroyActor("actor-2");
    world.flushPending();
    const remaining = composeLive(composer, world);
    expect([...remaining.poses.keys()]).toEqual(["actor-0"]);
    expect(remaining).toEqual(freshPoses(world));

    // A new actor reusing a released guid (now unrotated, so unsheared) composes from scratch.
    world.spawnActorNow(world.createActor({
      classId: "Actor",
      guid: "actor-1",
      transform: transform([0, 0, 4], { x: 0, y: 0, z: 0, w: 1 }, [1, 1, 1]),
      variables: { parentId: "actor-0" },
    }));
    const returned = composeLive(composer, world);
    expect(returned).toEqual(freshPoses(world));
    expect(returned.sheared).toEqual([]);
  });
});

describe("relativeTransform", () => {
  it("inverts a mirrored parent with an oblique child", () => {
    const parent = transform([1, 2, 3], { x: 0, y: S, z: 0, w: S }, [-2, 2, 2]);
    const local = transform([0.5, -1, 2], { x: 0, y: 0, z: Math.sin(Math.PI / 8), w: Math.cos(Math.PI / 8) }, [1, 3, -1]);
    const world = composeParentChildTransform(parent, local);
    const back = relativeTransform(parent, world, local)!;
    expectMatrixClose(composeAffineTransform(back), composeAffineTransform(local));
    expect(back.scale.x).toBeCloseTo(1, 12);
    expect(back.scale.y).toBeCloseTo(3, 12);
    expect(back.scale.z).toBeCloseTo(-1, 12);
  });

  it("inverts axis-aligned children of nonuniform parents", () => {
    const pose = fc
      .tuple(fc.tuple(position, position, position), fc.tuple(signedScale, signedScale, signedScale))
      .chain(([p, s]) => axisAlignedRotation.map((r) => transform(p, r, s)));
    fc.assert(
      fc.property(pose, pose, (parent, local) => {
        const back = relativeTransform(parent, composeParentChildTransform(parent, local), local)!;
        expectMatrixClose(composeAffineTransform(back), composeAffineTransform(local));
        for (const axis of ["x", "y", "z"] as const) expect(back.scale[axis]).toBeCloseTo(local.scale[axis], 9);
      }),
      { numRuns: 200 },
    );
  });
});

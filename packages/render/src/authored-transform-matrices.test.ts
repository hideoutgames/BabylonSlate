import { Vector3 } from "@babylonjs/core";
import {
  composeAffineTransform,
  multiplyAffineTransforms,
  shearedActorIds,
  type AffineTransform,
  type SerializedActor,
  type SerializedTransform,
} from "@babylonslate/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { authoredActorMatrices } from "./authored-transform-matrices";

function actor(id: string, parentId: string | null, transform: SerializedTransform): SerializedActor {
  return { id, name: id, classId: "Actor", parentId, transform, visible: true, locked: false, components: [], folderId: null };
}

/** The runtime's pure-TS composition of authored actors, root first. */
function runtimeWorlds(actors: readonly SerializedActor[]): Map<string, AffineTransform> {
  const worlds = new Map<string, AffineTransform>();
  for (const entry of actors) {
    const [px, py, pz] = entry.transform.position;
    const [rx, ry, rz, rw] = entry.transform.rotation;
    const [sx, sy, sz] = entry.transform.scale;
    const local = composeAffineTransform({
      position: { x: px, y: py, z: pz }, rotation: { x: rx, y: ry, z: rz, w: rw }, scale: { x: sx, y: sy, z: sz },
    });
    const parent = entry.parentId ? worlds.get(entry.parentId) : undefined;
    worlds.set(entry.id, parent ? multiplyAffineTransforms(local, parent) : local);
  }
  return worlds;
}

const scale = fc.tuple(fc.double({ min: 0.25, max: 3, noNaN: true }), fc.constantFrom(-1, 1)).map(([value, sign]) => value * sign);
const component = fc.double({ min: -1, max: 1, noNaN: true });
const rotation = fc.tuple(component, component, component, component)
  .filter(([x, y, z, w]) => Math.hypot(x, y, z, w) > 0.1)
  .map(([x, y, z, w]): [number, number, number, number] => {
    const length = Math.hypot(x, y, z, w);
    return [x / length, y / length, z / length, w / length];
  });
const coordinate = fc.double({ min: -10, max: 10, noNaN: true });
const hierarchy = fc.array(fc.record({
  parent: fc.nat(),
  transform: fc.record({
    position: fc.tuple(coordinate, coordinate, coordinate),
    rotation,
    scale: fc.tuple(scale, scale, scale),
  }),
}), { minLength: 2, maxLength: 6 }).map((nodes) => nodes.map((node, index) => {
  const parent = index === 0 ? -1 : (node.parent % (index + 1)) - 1;
  return actor(`actor-${index}`, parent >= 0 ? `actor-${parent}` : null, node.transform);
}));

describe("authored actor matrices", () => {
  it("place a grandchild of a 45 degree child under nonuniform scale at the matrix position", () => {
    const turn: [number, number, number, number] = [0, 0, Math.sin(Math.PI / 8), Math.cos(Math.PI / 8)];
    const actors = [
      actor("parent", null, { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [2, 1, 1] }),
      actor("child", "parent", { position: [0, 0, 0], rotation: turn, scale: [1, 1, 1] }),
      actor("grandchild", "child", { position: [1, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }),
    ];
    const translation = authoredActorMatrices(actors)(actors[2]!).getTranslation();
    expect(translation.x).toBeCloseTo(1.414214, 6);
    expect(translation.y).toBeCloseTo(0.707107, 6);
    expect(translation.z).toBeCloseTo(0, 12);
    expect(shearedActorIds(actors)).toEqual(["child", "grandchild"]);
  });

  it("match the runtime's matrix composition and shear detection", () => {
    fc.assert(fc.property(hierarchy, (actors) => {
      const authored = authoredActorMatrices(actors);
      const runtime = runtimeWorlds(actors);
      const sheared: string[] = [];
      for (const entry of actors) {
        const m = authored(entry).m;
        const expected = runtime.get(entry.id)!;
        for (let row = 0; row < 4; row++) {
          for (let column = 0; column < 3; column++) {
            const value = expected[row * 3 + column]!;
            expect(Math.abs(m[row * 4 + column]! - value)).toBeLessThan(1e-9 * Math.max(1, Math.abs(value)));
          }
        }
        const axes = [0, 4, 8].map((offset) => new Vector3(m[offset]!, m[offset + 1]!, m[offset + 2]!));
        const oblique = [[0, 1], [0, 2], [1, 2]].some(([a, b]) =>
          Math.abs(Vector3.Dot(axes[a!]!, axes[b!]!)) > 1e-6 * axes[a!]!.length() * axes[b!]!.length());
        if (entry.parentId && oblique) sheared.push(entry.id);
      }
      expect(shearedActorIds(actors)).toEqual(sheared);
    }), { numRuns: 200 });
  });
});

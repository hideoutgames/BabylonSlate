import { describe, expect, it } from "vitest";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core";
import { parseFoliageProperties } from "@haptic/core";
import { FoliageEraseSession } from "./foliage-erase";

type Dab = { point: Vector3; radius: number };

/** The brush's earlier per-dab erase: re-parse the previous result and keep what lies beyond the radius. `null` once nothing is left. */
function eraseBySweeping(properties: unknown, world: Matrix, dabs: Dab[]): Array<unknown> {
  const results: unknown[] = [];
  let current = properties;
  for (const { point, radius } of dabs) {
    const data = parseFoliageProperties(current);
    const batches = data.batches.map((batch) => ({ ...batch, transforms: batch.transforms.filter((transform) =>
      Vector3.Distance(Vector3.TransformCoordinates(Vector3.FromArray(transform.position), world), point) > radius) })).filter((batch) => batch.transforms.length);
    if (!batches.length) { results.push(null); break; }
    current = { ...data, batches };
    results.push(current);
  }
  return results;
}

const transform = (x: number, y: number, z: number) => ({ position: [x, y, z], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
let seed = 3;
const random = () => (seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 0x100000000;

/** A stored component with the debris parsing discards: unnamed models, non-array transforms, partial and invalid transforms. */
function stored(positions: (random: () => number) => Array<[number, number, number]>) {
  return { groupId: "trees", batches: [
    { modelGuid: "oak", materialGuid: "bark", transforms: positions(random).map(([x, y, z]) => transform(x, y, z)) },
    { modelGuid: "   ", transforms: [transform(0, 0, 0)] },
    { modelGuid: "pine", materialGuid: null, transforms: [...positions(random).map(([x, y, z]) => transform(x, y, z)), { position: [1, 2] }, { rotation: [NaN, 0, 0, "w"], scale: [2, 2, 2] }, null] },
    { modelGuid: "fern", transforms: "none" },
    { modelGuid: "elm", transforms: [transform(40, 0, 40), transform(41, 0, 40)] },
  ] };
}

describe("foliage erase session", () => {
  it.each([
    ["a rotated, scaled and moved component", Matrix.Compose(new Vector3(1.5, 0.7, 2), Quaternion.RotationYawPitchRoll(0.6, 0.2, -0.4), new Vector3(3, -1, 4)),
      (r: () => number) => Array.from({ length: 300 }, (): [number, number, number] => [r() * 14 - 7, r() * 2, r() * 14 - 7]),
      () => ({ point: new Vector3(random() * 20 - 8, random() * 4 - 2, random() * 20 - 6), radius: 0.8 + random() * 2.5 })],
    // Lattice positions, points and radii make many instances lie exactly at the radius, which is erased.
    ["a lattice with instances exactly at the radius", Matrix.Identity(),
      (r: () => number) => Array.from({ length: 169 }, (_, i): [number, number, number] => [-6 + i % 13, 0, -6 + Math.floor(i / 13)]).filter(() => r() < 0.9),
      () => ({ point: new Vector3(Math.floor(random() * 13) - 6, 0, Math.floor(random() * 13) - 6), radius: 1 + Math.floor(random() * 3) })],
  ])("equals re-parsing and filtering the component for every dab, on %s", (_name, world, positions, nextDab) => {
    const properties = stored(positions);
    const dabs = Array.from({ length: 60 }, nextDab);
    const expected = eraseBySweeping(properties, world, dabs);
    const session = new FoliageEraseSession(properties, world);
    expect(session.empty).toBe(false);
    let erasedSome = false;
    for (let i = 0; i < expected.length; i++) {
      session.erase(dabs[i]!.point, dabs[i]!.radius);
      if (expected[i] === null) { expect(session.empty).toBe(true); break; }
      expect(session.empty).toBe(false);
      expect(session.snapshot()).toEqual(expected[i]);
      erasedSome ||= session.snapshot().batches.some((batch, b) => batch.transforms.length < parseFoliageProperties(properties).batches[b]!.transforms.length);
    }
    expect(erasedSome).toBe(true);
  });

  it("drops a batch when its last instance goes, empties with the last instance, and leaves the stored component unmodified", () => {
    const properties = stored(() => [[0, 0, 0], [1, 0, 0]]);
    const copy = structuredClone(properties);
    const session = new FoliageEraseSession(properties, Matrix.Identity());
    session.erase(new Vector3(40.5, 0, 40), 1);
    expect(session.empty).toBe(false);
    expect(session.snapshot().batches.map((batch) => batch.modelGuid)).toEqual(["oak", "pine"]);
    session.erase(new Vector3(0.5, 0, 0), 1);
    expect(session.empty).toBe(true);
    expect(session.snapshot().batches).toEqual([]);
    expect(properties).toEqual(copy);
  });
});

import { expect, it } from "vitest";
import { selectMirrorsToRender, type MirrorCandidate } from "./mirror-selection";

type Named = MirrorCandidate & { name: string };

/** A mirror in a vertical plane z = `z`, reflective side toward −Z, `width` × 2 metres, centred at (x, 1, z). */
function wall(name: string, x: number, z: number, width = 2, options: Partial<MirrorCandidate> = {}): Named {
  return {
    name, cx: x, cy: 1, cz: z, nx: 0, ny: 0, nz: -1, ux: width / 2, uy: 0, uz: 0, vx: 0, vy: 1, vz: 0,
    visible: true, drawn: true, order: 0, distance: 0, ...options,
  };
}

const eye = { x: 0, y: 1, z: 0 };
const names = (candidates: Named[]) => candidates.map((candidate) => candidate.name);

function select(candidates: Named[], budget = 2): Named[] {
  const out: Named[] = [];
  selectMirrorsToRender(eye, candidates, budget, out);
  return out;
}

it("draws only mirrors in view whose reflective side faces the eye", () => {
  const behind = wall("behind the eye", 0, -3);
  const facingAway = wall("facing away", 0, 3, 2, { nz: 1 });
  const offScreen = wall("off screen", 0, 4, 2, { visible: false });
  const edgeOn = wall("eye on its plane", 0, 0, 2);
  const front = wall("in front", 0, 6);
  expect(names(select([behind, facingAway, offScreen, edgeOn, front], 5))).toEqual(["in front"]);
});

it("keeps the two nearest by the closest point of each rectangle, so a wide mirror beats a nearer centre", () => {
  // The wide mirror's centre is 10 m away along x, but its edge passes 4 m in front of the eye.
  const wide = wall("wide", 10, 4, 22, { order: 3 });
  const small = wall("small", 0, 5, 2, { order: 1 });
  const far = wall("far", 0, 9, 2, { order: 0 });
  const selected = select([far, small, wide]);
  expect(names(selected)).toEqual(["wide", "small"]);
  expect(selected[0]!.distance).toBeCloseTo(4, 9);
  expect(selected[1]!.distance).toBeCloseTo(5, 9);
});

it("gives a mirror without an image the next slot before nearer ones that already drew", () => {
  const near = wall("near", 0, 3, 2, { order: 0 });
  const middle = wall("middle", 1, 4, 2, { order: 1 });
  const fresh = wall("fresh", -1, 8, 2, { drawn: false, order: 2 });
  expect(names(select([near, middle, fresh]))).toEqual(["fresh", "near"]);
  fresh.drawn = true;
  expect(names(select([near, middle, fresh]))).toEqual(["near", "middle"]);
});

it("breaks distance ties by registration order, whatever the list order", () => {
  const younger = wall("younger", 2, 5, 2, { order: 7 });
  const older = wall("older", -2, 5, 2, { order: 2 });
  expect(names(select([younger, older], 1))).toEqual(["older"]);
  expect(names(select([older, younger], 1))).toEqual(["older"]);
});

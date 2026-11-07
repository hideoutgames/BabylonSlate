import { quatToPlanarAngle } from "./collider-bake";
import type { ColliderDesc } from "./types";

/**
 * A 2D collider's outline as a 2D light's shadow caster sees it, in its body's frame (the collider's local pose
 * applied, sizes already scaled): flat XY pairs, `closed` for a solid shape (box, circle, capsule, polygon, looped
 * chain), open for a one-sided chain.
 */
export type Occluder2DShape = { closed: boolean; points: number[] };

/** Segments a circle or capsule end is drawn with. */
const ROUND_SEGMENTS = 16;

/**
 * The outlines of `colliders` that cast 2D shadows: every solid 2D shape that is not a trigger. 3D shapes cast none.
 */
export function occluder2DShapes(colliders: Iterable<ColliderDesc>): Occluder2DShape[] {
  const shapes: Occluder2DShape[] = [];
  for (const collider of colliders) {
    if (collider.isTrigger) continue;
    const local = localOutline(collider.shape);
    if (!local) continue;
    const angle = collider.rotation ? quatToPlanarAngle(collider.rotation) : 0;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const tx = collider.translation?.x ?? 0, ty = collider.translation?.y ?? 0;
    const points = new Array<number>(local.points.length);
    for (let index = 0; index < local.points.length; index += 2) {
      const x = local.points[index]!, y = local.points[index + 1]!;
      points[index] = tx + x * cos - y * sin;
      points[index + 1] = ty + x * sin + y * cos;
    }
    shapes.push({ closed: local.closed, points });
  }
  return shapes;
}

function localOutline(shape: ColliderDesc["shape"]): Occluder2DShape | null {
  switch (shape.kind) {
    case "box2d": {
      const { x, y } = shape.halfExtents;
      return { closed: true, points: [-x, -y, x, -y, x, y, -x, y] };
    }
    case "circle": {
      const points: number[] = [];
      for (let index = 0; index < ROUND_SEGMENTS; index++) {
        const angle = (index / ROUND_SEGMENTS) * Math.PI * 2;
        points.push(Math.cos(angle) * shape.radius, Math.sin(angle) * shape.radius);
      }
      return { closed: true, points };
    }
    case "capsule2d": {
      // Along Y, as the 2D backend's capsule: two half circles joined by straight sides.
      const points: number[] = [];
      const half = ROUND_SEGMENTS / 2;
      for (let index = 0; index <= half; index++) {
        const angle = (index / half) * Math.PI;
        points.push(Math.cos(angle) * shape.radius, shape.halfHeight + Math.sin(angle) * shape.radius);
      }
      for (let index = 0; index <= half; index++) {
        const angle = Math.PI + (index / half) * Math.PI;
        points.push(Math.cos(angle) * shape.radius, -shape.halfHeight + Math.sin(angle) * shape.radius);
      }
      return { closed: true, points };
    }
    case "polygon":
      return shape.points.length >= 3 ? { closed: true, points: shape.points.flatMap((point) => [point.x, point.y]) } : null;
    case "chain":
      return shape.points.length >= 2 ? { closed: shape.loop === true, points: shape.points.flatMap((point) => [point.x, point.y]) } : null;
    default:
      return null;
  }
}

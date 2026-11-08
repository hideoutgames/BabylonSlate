import {
  parseSplineProperties,
  sampleSplineArcPath,
  sampleSplinePath,
  splineArcPath,
  SPLINE_DISTANCE_SUBDIVISIONS,
  type SerializedTransform,
  type SplineArcPath,
  type SplinePoint,
} from "@haptic/core";
import { World, type ActorComponent } from "@haptic/object-model";
import { rotateVector } from "./actor-world-transform";
import { runtimeEditWorldTransform } from "./runtime-transform-edit";

type SplineBody = ReturnType<typeof parseSplineProperties>;

/**
 * Each component's parsed spline, the variables revision it was parsed at and its serialized form, the world pose
 * the path was built for (position, rotation, scale) and the path.
 */
const paths = new WeakMap<ActorComponent, {
  revision: number;
  body: SplineBody;
  bodyKey: string;
  pose: SerializedTransform;
  path: SplineArcPath;
}>();

/** Equal as elements of a JSON array: numbers by value (-0 equals 0, and every non-finite number is null). */
function sameJsonElement(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return a === b || (!Number.isFinite(a) && !Number.isFinite(b));
  return (JSON.stringify(a) ?? "null") === (JSON.stringify(b) ?? "null");
}

function sameJsonArray(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (!sameJsonElement(a[index], b[index])) return false;
  return true;
}

/** Equal as their JSON: the same position, rotation and scale numbers. */
function samePose(a: SerializedTransform, b: SerializedTransform): boolean {
  return sameJsonArray(a.position, b.position) && sameJsonArray(a.rotation, b.rotation) && sameJsonArray(a.scale, b.scale);
}

/**
 * A Spline component's curve in world space, measured by arc length. Rebuilt
 * only when its points, curvature, loop or world pose change, so a Tick that
 * travels the path every frame reuses it. The points are parsed again only
 * after a write to the component's variables, and the pose is compared
 * number by number, as their JSON would compare.
 */
function splineWorldPath(component: ActorComponent): SplineArcPath | null {
  const world = component.owner?.world;
  if (!(world instanceof World) || component.destroyed) return null;
  let pose;
  try {
    pose = runtimeEditWorldTransform(world, component);
  } catch {
    return null;
  }
  const revision = component.variablesRevision;
  const cached = paths.get(component);
  let body: SplineBody, bodyKey: string;
  if (cached?.revision === revision) ({ body, bodyKey } = cached);
  else {
    body = parseSplineProperties({
      points: component.getVariable("points"),
      curvature: component.getVariable("curvature"),
      closed: component.getVariable("closed"),
    });
    bodyKey = JSON.stringify(body);
  }
  if (cached && cached.bodyKey === bodyKey && samePose(cached.pose, pose)) {
    cached.revision = revision;
    return cached.path;
  }
  const [px, py, pz] = pose.position;
  const [x, y, z, w] = pose.rotation;
  const [sx, sy, sz] = pose.scale;
  const toWorld = (point: SplinePoint): SplinePoint => {
    const turned = rotateVector({ x, y, z, w }, { x: point[0] * sx, y: point[1] * sy, z: point[2] * sz });
    return [px + turned.x, py + turned.y, pz + turned.z];
  };
  const samples = sampleSplinePath(body, { subdivisions: SPLINE_DISTANCE_SUBDIVISIONS });
  const path = splineArcPath(samples.map((sample) => toWorld(sample.position)), body.closed);
  paths.set(component, { revision, body, bodyKey, pose, path });
  return path;
}

const vec3 = ([x, y, z]: SplinePoint) => ({ x, y, z });

/** Spline component functions; null when `name` is not one of them. */
export function splineComponentFunction(
  component: ActorComponent,
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> | null {
  if (name === "getSplineLength") return { length: splineWorldPath(component)?.length ?? 0 };
  if (name !== "getSplineLocationAtDistance") return null;
  const path = splineWorldPath(component);
  if (!path) return { location: vec3([0, 0, 0]), direction: vec3([0, 0, 0]) };
  const sample = sampleSplineArcPath(path, Number(args.distance));
  return { location: vec3(sample.position), direction: vec3(sample.direction) };
}

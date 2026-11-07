import {
  parseSplineProperties,
  sampleSplineArcPath,
  sampleSplinePath,
  splineArcPath,
  SPLINE_DISTANCE_SUBDIVISIONS,
  type SplineArcPath,
  type SerializedTransform,
  type SplinePoint,
} from "@haptic/core";
import { World, type ActorComponent } from "@haptic/object-model";
import { rotateVector } from "./actor-world-transform";
import { runtimeEditWorldTransform } from "./runtime-transform-edit";

/** A path and what it was built from: the component's variables revision and its world pose's ten numbers. */
interface CachedSplinePath { revision: number; pose: Float64Array; path: SplineArcPath }
const paths = new WeakMap<ActorComponent, CachedSplinePath>();

/** Pose numbers match as the former JSON key matched them: equal, or both non-finite (JSON writes those as null). */
function samePoseNumber(cached: number, current: number): boolean {
  return cached === current || (!Number.isFinite(cached) && !Number.isFinite(current));
}

function samePose(cached: Float64Array, pose: SerializedTransform): boolean {
  const { position, rotation, scale } = pose;
  return samePoseNumber(cached[0]!, position[0]) && samePoseNumber(cached[1]!, position[1]) && samePoseNumber(cached[2]!, position[2]) &&
    samePoseNumber(cached[3]!, rotation[0]) && samePoseNumber(cached[4]!, rotation[1]) && samePoseNumber(cached[5]!, rotation[2]) &&
    samePoseNumber(cached[6]!, rotation[3]) &&
    samePoseNumber(cached[7]!, scale[0]) && samePoseNumber(cached[8]!, scale[1]) && samePoseNumber(cached[9]!, scale[2]);
}

/**
 * A Spline component's curve in world space, measured by arc length. Rebuilt
 * only when its variables (points, curvature, loop) or world pose change, so a
 * Tick that travels the path every frame reuses it without parsing its points
 * again. An unchanged variables revision proves no variable was written; a
 * component without one (NaN) always rebuilds.
 */
function splineWorldPath(component: ActorComponent): SplineArcPath | null {
  const world = component.owner?.world;
  if (!(world instanceof World) || component.destroyed) return null;
  let pose: SerializedTransform;
  try {
    pose = runtimeEditWorldTransform(world, component);
  } catch {
    return null;
  }
  const revision = component.variablesRevision;
  const cached = paths.get(component);
  if (cached && cached.revision === revision && samePose(cached.pose, pose)) return cached.path;
  const body = parseSplineProperties({
    points: component.getVariable("points"),
    curvature: component.getVariable("curvature"),
    closed: component.getVariable("closed"),
  });
  const [px, py, pz] = pose.position;
  const [x, y, z, w] = pose.rotation;
  const [sx, sy, sz] = pose.scale;
  const toWorld = (point: SplinePoint): SplinePoint => {
    const turned = rotateVector({ x, y, z, w }, { x: point[0] * sx, y: point[1] * sy, z: point[2] * sz });
    return [px + turned.x, py + turned.y, pz + turned.z];
  };
  const samples = sampleSplinePath(body, { subdivisions: SPLINE_DISTANCE_SUBDIVISIONS });
  const path = splineArcPath(samples.map((sample) => toWorld(sample.position)), body.closed);
  paths.set(component, { revision, pose: Float64Array.of(px, py, pz, x, y, z, w, sx, sy, sz), path });
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

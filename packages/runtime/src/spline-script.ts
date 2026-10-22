import {
  parseSplineProperties,
  sampleSplineArcPath,
  sampleSplinePath,
  splineArcPath,
  SPLINE_DISTANCE_SUBDIVISIONS,
  type SplineArcPath,
  type SplinePoint,
} from "@babylonslate/core";
import { World, type ActorComponent } from "@babylonslate/object-model";
import { rotateVector } from "./actor-world-transform";
import { runtimeEditWorldTransform } from "./runtime-transform-edit";

const paths = new WeakMap<ActorComponent, { key: string; path: SplineArcPath }>();

/**
 * A Spline component's curve in world space, measured by arc length. Rebuilt
 * only when its points, curvature, loop or world pose change, so a Tick that
 * travels the path every frame reuses it.
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
  const body = parseSplineProperties({
    points: component.getVariable("points"),
    curvature: component.getVariable("curvature"),
    closed: component.getVariable("closed"),
  });
  const key = JSON.stringify([body, pose]);
  const cached = paths.get(component);
  if (cached?.key === key) return cached.path;
  const [px, py, pz] = pose.position;
  const [x, y, z, w] = pose.rotation;
  const [sx, sy, sz] = pose.scale;
  const toWorld = (point: SplinePoint): SplinePoint => {
    const turned = rotateVector({ x, y, z, w }, { x: point[0] * sx, y: point[1] * sy, z: point[2] * sz });
    return [px + turned.x, py + turned.y, pz + turned.z];
  };
  const samples = sampleSplinePath(body, { subdivisions: SPLINE_DISTANCE_SUBDIVISIONS });
  const path = splineArcPath(samples.map((sample) => toWorld(sample.position)), body.closed);
  paths.set(component, { key, path });
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

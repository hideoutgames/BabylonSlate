import { Color3, Vector3, type Camera, type Scene, type UtilityLayerRenderer } from "@babylonjs/core";
import { parseSplineProperties, splineCentreline, type SplinePoint, type SplineProperties } from "@babylonslate/core";
import { createShapeHandles, type ShapeHandleTarget, type ShapeHandlesOptions, type ShapeHandlesHost } from "./shape-handles";
import { splineMeshBody, updateSplineMeshBody } from "./spline-mesh";

const FORWARD = new Vector3();
const FALLBACK_FORWARD = Vector3.Forward();

function cameraForward(camera: Camera): Vector3 {
  const m = camera.getWorldMatrix().m;
  return FORWARD.set(m[8]!, m[9]!, m[10]!).normalize();
}

export interface SplineHandle {
  id: string;
  kind: "point" | "insert";
  position: SplinePoint;
  index: number;
}

export function splineHandles(body: SplineProperties): SplineHandle[] {
  const line = splineCentreline(body), segments = body.closed ? body.points.length : body.points.length - 1;
  const steps = (line.length - 1) / segments;
  return body.points.flatMap((point, index): SplineHandle[] => {
    const handles: SplineHandle[] = [{ id: `point:${index}`, kind: "point", position: [...point], index }];
    if (index < segments && body.points.length < 128) {
      const middle = (index + 0.5) * steps, a = line[Math.floor(middle)]!, b = line[Math.ceil(middle)]!;
      handles.push({ id: `insert:${index}`, kind: "insert", index, position: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2] });
    }
    return handles;
  });
}

export function dragSplineHandle(body: SplineProperties, handle: SplineHandle, local: SplinePoint): { points: SplinePoint[] } {
  return { points: body.points.map((point, index) => [...(index === handle.index ? local : point)]) };
}

export function insertSplinePoint(body: SplineProperties, index: number, local: SplinePoint): { points: SplinePoint[] } | null {
  if (body.points.length >= 128) return null;
  return { points: [...body.points.slice(0, index + 1).map((point): SplinePoint => [...point]), [...local], ...body.points.slice(index + 1).map((point): SplinePoint => [...point])] };
}

export function removeSplinePoint(body: SplineProperties, index: number): { points: SplinePoint[] } | null {
  if (body.points.length <= (body.closed ? 3 : 2)) return null;
  return { points: body.points.filter((_, i) => i !== index).map((point) => [...point]) };
}

/**
 * XYZ points move in the camera-facing plane; orbiting provides the remaining axis.
 * A clicked or dragged point stays selected for the translate gizmo.
 */
export function createSplineHandles(layer: UtilityLayerRenderer, scene: Scene, options: ShapeHandlesOptions = {}): ShapeHandlesHost<ShapeHandleTarget> {
  return createShapeHandles<SplineProperties, SplineHandle, ShapeHandleTarget>(layer, scene, {
    name: "spline",
    parse: parseSplineProperties,
    read: splineMeshBody,
    update: updateSplineMeshBody,
    handles: splineHandles,
    outline: (body) => [splineCentreline(body)],
    drag: dragSplineHandle,
    insert: (body, handle, local) => {
      const properties = insertSplinePoint(body, handle.index, local);
      const index = handle.index + 1;
      return properties ? { properties, handle: { id: `point:${index}`, kind: "point", position: local, index } } : null;
    },
    remove: (body, handle) => removeSplinePoint(body, handle.index),
    constraint: (_handle, _world, camera) => ({ dragPlaneNormal: camera ? cameraForward(camera) : FALLBACK_FORWARD }),
    color: () => new Color3(0.95, 0.97, 1),
    selectable: (handle) => handle.kind === "point",
  }, options);
}

import type { ActorComponent } from "@babylonslate/object-model";
import { prepareColliderShape, type ColliderShape, type Vec3 } from "@babylonslate/physics";
import type { Transform } from "@babylonslate/core";
import { dynamicRuntimeGeometry } from "./dynamic-runtime-mesh";
import { sameDescriptor, transformDescriptor } from "./physics-preparation";

/** Include component ancestry so runtime reparenting/parent edits invalidate collision. */
export function dynamicMeshCollisionDescriptor(component: ActorComponent): unknown[] {
  const values: unknown[] = [component.getVariable("enableCollision")];
  if (values[0] !== true) return values;
  values.push(dynamicRuntimeGeometry(component)?.collisionRevision);
  for (const entry of componentChain(component)) values.push(entry, ...transformDescriptor(entry.transform));
  return values;
}

function componentChain(component: ActorComponent): ActorComponent[] {
  const chain: ActorComponent[] = [];
  let current: ActorComponent | undefined = component;
  while (current && chain.length < 128 && !chain.includes(current)) {
    chain.push(current);
    const parentId = current.parentId;
    current = parentId ? component.owner?.components.find((entry) => !entry.destroyed && (entry.guid === parentId || entry.sourceId === parentId)) : undefined;
  }
  return chain;
}

/** No shape preparation until explicitly enabled. Cache by collision revision and local transforms. */
export class DynamicMeshCollisionCache {
  private readonly states = new WeakMap<ActorComponent, { descriptor: unknown[]; shape: ColliderShape | null }>();

  prepare(component: ActorComponent, actorScale: Vec3): ColliderShape | null {
    const geometry = dynamicRuntimeGeometry(component);
    if (component.getVariable("enableCollision") !== true || !geometry?.indices.length) return null;
    const descriptor = [...dynamicMeshCollisionDescriptor(component), actorScale.x, actorScale.y, actorScale.z];
    const previous = this.states.get(component);
    if (previous && sameDescriptor(previous.descriptor, descriptor)) return previous.shape;
    const chain = componentChain(component);
    const vertices: Vec3[] = new Array(geometry.positions.length / 3);
    for (let i = 0; i < vertices.length; i++) {
      const point = { x: geometry.positions[i * 3]!, y: geometry.positions[i * 3 + 1]!, z: geometry.positions[i * 3 + 2]! };
      for (const entry of chain) transformPoint(point, entry.transform);
      point.x *= actorScale.x; point.y *= actorScale.y; point.z *= actorScale.z;
      vertices[i] = point;
    }
    // Collapsed triangles have no collision surface. Excluding them keeps a legal
    // render deformation from rejecting the entire native collider transaction.
    const indices: number[] = [];
    for (let i = 0; i < geometry.indices.length; i += 3) {
      const ai = geometry.indices[i]!, bi = geometry.indices[i + 1]!, ci = geometry.indices[i + 2]!;
      const a = vertices[ai]!, b = vertices[bi]!, c = vertices[ci]!;
      const ax = b.x - a.x, ay = b.y - a.y, az = b.z - a.z;
      const bx = c.x - a.x, by = c.y - a.y, bz = c.z - a.z;
      if (Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx) >= 1e-12) indices.push(ai, bi, ci);
    }
    const shape = indices.length ? prepareColliderShape({ kind: "mesh", vertices, indices }) : null;
    this.states.set(component, { descriptor, shape });
    return shape;
  }
}

function transformPoint(point: Vec3, transform: Transform): void {
  const x = point.x * transform.scale.x, y = point.y * transform.scale.y, z = point.z * transform.scale.z;
  const q = transform.rotation;
  const ix = q.w * x + q.y * z - q.z * y, iy = q.w * y + q.z * x - q.x * z, iz = q.w * z + q.x * y - q.y * x;
  const iw = -q.x * x - q.y * y - q.z * z;
  point.x = transform.position.x + ix * q.w - iw * q.x - iy * q.z + iz * q.y;
  point.y = transform.position.y + iy * q.w - iw * q.y - iz * q.x + ix * q.z;
  point.z = transform.position.z + iz * q.w - iw * q.z - ix * q.y + iy * q.x;
}

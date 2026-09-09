import { Matrix, Quaternion, Ray, Vector3 } from "@babylonjs/core";
import {
  convexHullMesh, extractGltfCollisionMesh, resolveMeshCollisions,
  spriteClipFrameAt, spriteCollisionToBox2d, DEFAULT_SPRITE_COLLISION,
  tilemapCollisionChains,
} from "@babylonslate/assets";
import { identitySerializedTransform, type SerializedScene, type SerializedTransform } from "@babylonslate/core";
import { parseColliderProperties, scaleColliderShape, type ColliderShape } from "@babylonslate/physics";
import type { MeshAssetContext } from "./mesh-assets";

const EPS = 1e-8;
export type DropBounds = { min: Vector3; max: Vector3 };
type TriangleShape = { kind: "mesh"; vertices: Vector3[]; indices: readonly number[]; convex: boolean };
type QueryShape = Exclude<ColliderShape, { kind: "convex" | "mesh" }> | TriangleShape;
export type DropSurface = { actorId: string; shape: QueryShape; world: Matrix; inverse: Matrix };

function transformMatrix(transform: SerializedTransform): Matrix {
  return Matrix.Compose(new Vector3(...transform.scale), new Quaternion(...transform.rotation), new Vector3(...transform.position));
}

/** Build once per Drop request; optional collision debug meshes are irrelevant. */
export function collisionSurfaces(sceneData: SerializedScene, actorWorlds: ReadonlyMap<string, Matrix>, assets?: MeshAssetContext): DropSurface[] {
  const surfaces: DropSurface[] = [];
  const worldKind = sceneData.settings.physicsWorld;
  const complexMeshes = new Map<string, ReturnType<typeof extractGltfCollisionMesh>>();
  const add = (actorId: string, shape: ColliderShape, world: Matrix) => {
    if (Math.abs(world.determinant()) < EPS) return;
    const scale = new Vector3(), rotation = new Quaternion(), position = new Vector3();
    if (!world.decompose(scale, rotation, position)) return;
    // Physics bakes dimensions (sphere=max axis, capsule/cylinder=max XZ),
    // rather than allowing inverse TRS to turn round shapes into ellipsoids.
    const baked = scaleColliderShape(shape, scale);
    const pose = Matrix.Compose(Vector3.One(), rotation, position);
    const triangles = baked.kind === "convex" ? convexHullMesh(baked.points) : baked.kind === "mesh" ? baked : null;
    const prepared: QueryShape = triangles
      ? { kind: "mesh", vertices: triangles.vertices.map((v) => new Vector3(v.x, v.y, v.z)), indices: triangles.indices, convex: baked.kind === "convex" }
      : baked as QueryShape;
    surfaces.push({ actorId, shape: prepared, world: pose, inverse: Matrix.Invert(pose) });
  };
  for (const actor of sceneData.actors) {
    const actorWorld = actorWorlds.get(actor.id)!;
    const spriteComponent = actor.components.find((component) => component.classId === "SpriteComponent");
    const spriteGuid = spriteComponent?.properties.assetGuid;
    const sprite = typeof spriteGuid === "string" ? assets?.spritePayloads?.get(spriteGuid) : undefined;
    const spriteFrame = sprite ? spriteClipFrameAt(sprite, typeof spriteComponent?.properties.clipName === "string" ? spriteComponent.properties.clipName : "", 0) : null;
    const spriteCollision = worldKind === "2d" && sprite && spriteFrame
      ? spriteCollisionToBox2d({ collision: spriteFrame.collision ?? DEFAULT_SPRITE_COLLISION,
        pivot: spriteFrame.pivot, pixelWidth: spriteFrame.width ?? 100, pixelHeight: spriteFrame.height ?? 100,
        pixelsPerUnit: sprite.pixelsPerUnit || assets?.pixelsPerUnit || 100 }) : null;
    const components = new Map(actor.components.map((component) => [component.id, component]));
    const componentWorlds = new Map<string, Matrix>();
    const visiting = new Set<string>();
    const componentWorldFor = (id: string): Matrix => {
      const known = componentWorlds.get(id);
      if (known) return known;
      const component = components.get(id);
      if (!component || visiting.has(id)) return actorWorld;
      visiting.add(id);
      const parent = component.parentId ? componentWorldFor(component.parentId) : actorWorld;
      const world = transformMatrix(component.transform ?? identitySerializedTransform()).multiply(parent);
      visiting.delete(id);
      componentWorlds.set(id, world);
      return world;
    };
    for (const component of actor.components) {
      const world = componentWorldFor(component.id);
      const properties = component.properties;
      if (component.classId === "ColliderComponent") {
        const collider = parseColliderProperties(properties, worldKind);
        if (collider.isTrigger) continue;
        if (collider.shape.kind === "box2d" && spriteCollision) {
          const local = component.transform ?? identitySerializedTransform();
          const shifted = transformMatrix({ ...local, position: [local.position[0] + spriteCollision.translation.x,
            local.position[1] + spriteCollision.translation.y, local.position[2]] });
          const parent = component.parentId ? componentWorldFor(component.parentId) : actorWorld;
          add(actor.id, { kind: "box2d", halfExtents: spriteCollision.halfExtents }, shifted.multiply(parent));
        } else add(actor.id, collider.shape, world);
      } else if (component.classId === "BlockingVolumeComponent") {
        add(actor.id, worldKind === "2d"
          ? { kind: "box2d", halfExtents: { x: 0.5, y: 0.5 } }
          : { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } }, world);
      } else if (component.classId === "MeshComponent" && worldKind === "3d" && properties.meshKind !== "pivot") {
        const guid = typeof properties.assetGuid === "string" ? properties.assetGuid.trim() : "";
        const modelPayload = assets?.modelPayloads?.get(guid);
        if (properties.collisionMode === "complex" && guid && !complexMeshes.has(guid)) {
          const bytes = assets?.modelBytes?.get(guid);
          complexMeshes.set(guid, bytes ? extractGltfCollisionMesh(bytes, modelPayload?.importScale ?? 1) : null);
        }
        for (const collision of resolveMeshCollisions(properties, { modelPayload, complexMesh: complexMeshes.get(guid) })) {
          add(actor.id, collision.shape as ColliderShape, transformMatrix(collision).multiply(world));
        }
      } else if (worldKind === "2d" && component.classId === "TilemapComponent") {
        const guid = typeof properties.assetGuid === "string" ? properties.assetGuid : "";
        const map = assets?.tilemaps?.get(guid);
        if (map && assets?.tilesets) {
          const ppu = assets.pixelsPerUnit || 100;
          for (const chain of tilemapCollisionChains(map, assets.tilesets, map.tileWidth / ppu, map.tileHeight / ppu)) {
            add(actor.id, { kind: "chain", points: chain.points, loop: chain.loop }, world);
          }
        }
      }
    }
  }
  return surfaces;
}

export function collisionBounds(surfaces: readonly DropSurface[]): DropBounds | null {
  let bounds: DropBounds | null = null;
  for (const surface of surfaces) {
    const shape = surface.shape;
    let points: Vector3[];
    if (shape.kind === "mesh") points = shape.vertices;
    else if (shape.kind === "polygon" || shape.kind === "chain") points = shape.points.map((p) => new Vector3(p.x, p.y, 0));
    else {
      let x: number, y: number, z: number;
      if (shape.kind === "box" || shape.kind === "box2d") {
        x = shape.halfExtents.x; y = shape.halfExtents.y; z = shape.kind === "box" ? shape.halfExtents.z : 0;
      } else {
        x = shape.radius;
        y = shape.kind === "capsule" || shape.kind === "capsule2d" ? shape.halfHeight + shape.radius
          : shape.kind === "cylinder" ? shape.height / 2 : shape.radius;
        z = shape.kind === "circle" || shape.kind === "capsule2d" ? 0 : x;
      }
      points = [-x, x].flatMap((px) => [-y, y].flatMap((py) => [-z, z].map((pz) => new Vector3(px, py, pz))));
    }
    for (const point of points) {
      const transformed = Vector3.TransformCoordinates(point, surface.world);
      if (!bounds) bounds = { min: transformed.clone(), max: transformed.clone() };
      else Vector3.CheckExtends(transformed, bounds.min, bounds.max);
    }
  }
  return bounds;
}

export function surfaceHit(surface: DropSurface, worldOrigin: Vector3): number | null {
  const origin = Vector3.TransformCoordinates(worldOrigin, surface.inverse);
  // Unnormalized local direction preserves the world-distance parameter t.
  const direction = Vector3.TransformNormal(Vector3.Down(), surface.inverse);
  return shapeHit(surface.shape, origin, direction);
}

function nearest(values: readonly number[]): number | null {
  let best = Infinity;
  for (const value of values) if (value >= -EPS && value < best) best = value;
  return Number.isFinite(best) ? Math.max(0, best) : null;
}

function quadratic(a: number, b: number, c: number): number[] {
  if (Math.abs(a) < EPS) return Math.abs(b) < EPS ? [] : [-c / b];
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return [];
  const root = Math.sqrt(discriminant);
  return [(-b - root) / (2 * a), (-b + root) / (2 * a)];
}

function sphereHits(origin: Vector3, direction: Vector3, radius: number, y = 0, twoD = false): number[] {
  const o = origin.subtract(new Vector3(0, y, 0));
  const d = direction.clone();
  if (twoD) { o.z = 0; d.z = 0; }
  if (o.lengthSquared() <= radius * radius) return [0];
  return quadratic(d.lengthSquared(), 2 * Vector3.Dot(o, d), o.lengthSquared() - radius * radius);
}

function boxHit(origin: Vector3, direction: Vector3, extents: { x: number; y: number; z?: number }): number | null {
  let enter = -Infinity, leave = Infinity;
  const axes = extents.z === undefined ? ["x", "y"] as const : ["x", "y", "z"] as const;
  for (const axis of axes) {
    const size = Math.abs(extents[axis]!);
    if (Math.abs(direction[axis]) < EPS) {
      if (Math.abs(origin[axis]) > size) return null;
      continue;
    }
    const a = (-size - origin[axis]) / direction[axis];
    const b = (size - origin[axis]) / direction[axis];
    enter = Math.max(enter, Math.min(a, b)); leave = Math.min(leave, Math.max(a, b));
    if (enter > leave) return null;
  }
  return leave < -EPS ? null : Math.max(0, enter);
}

function cylinderHits(origin: Vector3, direction: Vector3, radius: number, halfHeight: number): number[] {
  if (origin.x ** 2 + origin.z ** 2 <= radius ** 2 && Math.abs(origin.y) <= halfHeight) return [0];
  const values = quadratic(direction.x ** 2 + direction.z ** 2,
    2 * (origin.x * direction.x + origin.z * direction.z), origin.x ** 2 + origin.z ** 2 - radius ** 2)
    .filter((t) => Math.abs(origin.y + direction.y * t) <= halfHeight);
  if (Math.abs(direction.y) > EPS) {
    for (const y of [-halfHeight, halfHeight]) {
      const t = (y - origin.y) / direction.y;
      if ((origin.x + direction.x * t) ** 2 + (origin.z + direction.z * t) ** 2 <= radius ** 2 + EPS) values.push(t);
    }
  }
  return values;
}

function shapeHit(shape: QueryShape, origin: Vector3, direction: Vector3): number | null {
  switch (shape.kind) {
    case "box": case "box2d": return boxHit(origin, direction, shape.halfExtents);
    case "sphere": case "circle": return nearest(sphereHits(origin, direction, shape.radius, 0, shape.kind === "circle"));
    case "cylinder": return nearest(cylinderHits(origin, direction, shape.radius, shape.height / 2));
    case "capsule": return nearest([...cylinderHits(origin, direction, shape.radius, shape.halfHeight),
      ...sphereHits(origin, direction, shape.radius, shape.halfHeight), ...sphereHits(origin, direction, shape.radius, -shape.halfHeight)]);
    case "capsule2d": {
      const center = boxHit(origin, direction, { x: shape.radius, y: shape.halfHeight });
      return nearest([...(center === null ? [] : [center]), ...sphereHits(origin, direction, shape.radius, shape.halfHeight, true),
        ...sphereHits(origin, direction, shape.radius, -shape.halfHeight, true)]);
    }
    case "mesh": {
      if (shape.convex && shape.indices.length > 0) {
        let inside = true;
        for (let index = 0; index + 2 < shape.indices.length; index += 3) {
          const a = shape.vertices[shape.indices[index]!]!, b = shape.vertices[shape.indices[index + 1]!]!, c = shape.vertices[shape.indices[index + 2]!]!;
          if (Vector3.Dot(Vector3.Cross(b.subtract(a), c.subtract(a)), origin.subtract(a)) > EPS) { inside = false; break; }
        }
        if (inside) return 0;
      }
      const ray = new Ray(origin, direction, 10_000);
      let closest: number | null = null;
      for (let index = 0; index + 2 < shape.indices.length; index += 3) {
        const a = shape.vertices[shape.indices[index]!], b = shape.vertices[shape.indices[index + 1]!], c = shape.vertices[shape.indices[index + 2]!];
        if (!a || !b || !c) continue;
        const hit = ray.intersectsTriangle(a, b, c);
        if (hit && hit.distance >= -EPS && (closest === null || hit.distance < closest)) closest = Math.max(0, hit.distance);
      }
      return closest;
    }
    case "polygon": case "chain": {
      const values: number[] = [];
      const count = shape.kind === "polygon" || shape.loop ? shape.points.length : shape.points.length - 1;
      for (let index = 0; index < count; index++) {
        const a = shape.points[index]!, b = shape.points[(index + 1) % shape.points.length]!;
        const sx = b.x - a.x, sy = b.y - a.y;
        const determinant = direction.x * sy - direction.y * sx;
        if (Math.abs(determinant) < EPS) continue;
        const qx = a.x - origin.x, qy = a.y - origin.y;
        const t = (qx * sy - qy * sx) / determinant;
        const u = (qx * direction.y - qy * direction.x) / determinant;
        if (u >= -EPS && u <= 1 + EPS) values.push(t);
      }
      return nearest(values);
    }
  }
}

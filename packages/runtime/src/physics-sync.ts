import type { PhysicsBackend, PhysicsTransform, Vec3 } from "@babylonslate/physics";
import {
  parseColliderProperties,
  parseRigidBodyProperties,
} from "@babylonslate/physics";
import type { Actor, World } from "@babylonslate/object-model";
import {
  tilemapChunkChains,
  type TilemapPayload,
  type TilesetPayload,
} from "@babylonslate/assets";

function agentDebugLog(
  hypothesisId: string,
  location: string,
  message: string,
  data: Record<string, unknown>,
): void {
  if (typeof process === "undefined" || !process.getBuiltinModule) return;
  const fs = process.getBuiltinModule("fs") as typeof import("node:fs");
  fs.appendFileSync(
    "/opt/cursor/logs/debug.log",
    `${JSON.stringify({ hypothesisId, location, message, data, timestamp: Date.now() })}\n`,
  );
}

/**
 * Keeps `@babylonslate/physics` bodies in sync with World actors that carry
 * RigidBodyComponent / ColliderComponent.
 */
export class PhysicsWorldSync {
  private readonly backend: PhysicsBackend;
  private readonly bodyByActor = new Map<string, string>();
  private readonly characterByActor = new Map<string, string>();
  private synced = false;
  private actors: readonly Actor[] = [];
  private tilemaps = new Map<string, TilemapPayload>();
  private tilesets = new Map<string, TilesetPayload>();
  private pixelsPerUnit = 100;

  constructor(backend: PhysicsBackend) {
    this.backend = backend;
  }

  getBackend(): PhysicsBackend {
    return this.backend;
  }

  setTileContent(options: {
    tilemaps: ReadonlyMap<string, TilemapPayload> | Readonly<Record<string, TilemapPayload>>;
    tilesets: ReadonlyMap<string, TilesetPayload> | Readonly<Record<string, TilesetPayload>>;
    pixelsPerUnit?: number;
  }): void {
    this.tilemaps = toMap(options.tilemaps);
    this.tilesets = toMap(options.tilesets);
    if (options.pixelsPerUnit && options.pixelsPerUnit > 0) {
      this.pixelsPerUnit = options.pixelsPerUnit;
    }
  }

  dispose(): void {
    this.backend.dispose();
    this.bodyByActor.clear();
    this.characterByActor.clear();
  }

  /** Ensure every physics-bearing actor has backend bodies (idempotent). */
  syncFromWorld(world: World): void {
    this.actors = world.getActors();
    const live = new Set<string>();
    for (const actor of this.actors) {
      if (actor.destroyed) continue;
      const rigid = actor.components.find(
        (c) => c.classId === "RigidBodyComponent" && !c.destroyed,
      );
      const tilemap = actor.components.find(
        (c) => c.classId === "TilemapComponent" && !c.destroyed,
      );
      if (!rigid && !tilemap) continue;
      live.add(actor.guid);
      if (!this.bodyByActor.has(actor.guid)) {
        this.createForActor(actor);
      } else {
        const bodyId = this.bodyByActor.get(actor.guid)!;
        const props = parseRigidBodyProperties(
          rigid ? mapToRecord(rigid.variables) : { motionType: "static" },
        );
        if (props.motionType !== "dynamic") {
          this.backend.setBodyTransform(bodyId, actorWorldPhysicsTransform(actor, this.actors));
        }
      }
    }
    for (const [actorId, bodyId] of [...this.bodyByActor]) {
      if (live.has(actorId)) continue;
      this.backend.destroyBody(bodyId);
      this.bodyByActor.delete(actorId);
      this.characterByActor.delete(actorId);
    }
    this.synced = true;
  }

  step(dt: number, world: World): void {
    if (!this.synced) this.syncFromWorld(world);
    else this.syncFromWorld(world);
    this.backend.step(dt);
    for (const [actorId, bodyId] of this.bodyByActor) {
      const actor = world.getActors().find((a) => a.guid === actorId);
      if (!actor || actor.destroyed) continue;
      const transform = this.backend.getBodyTransform(bodyId);
      if (!transform) continue;
      const localTransform = actorLocalPhysicsTransform(transform, actor, this.actors);
      // #region agent log
      agentDebugLog("D", "physics-sync.ts:step", "copying backend pose into actor local transform", {
        actorGuid: actor.guid,
        parentId: actor.getVariable("parentId") ?? null,
        actorLocalBefore: actorTransform(actor),
        backendTransform: transform,
        localTransform,
      });
      // #endregion
      actor.transform.position.x = localTransform.position.x;
      actor.transform.position.y = localTransform.position.y;
      actor.transform.position.z = localTransform.position.z;
      actor.transform.rotation.x = localTransform.rotation.x;
      actor.transform.rotation.y = localTransform.rotation.y;
      actor.transform.rotation.z = localTransform.rotation.z;
      actor.transform.rotation.w = localTransform.rotation.w;
    }
  }

  lineTrace(start: Vec3, end: Vec3) {
    return this.backend.lineTrace(start, end);
  }

  sphereOverlap(center: Vec3, radius: number) {
    return this.backend.sphereOverlap(center, radius);
  }

  shapeSweep(
    shape: Parameters<PhysicsBackend["shapeSweep"]>[0],
    start: PhysicsTransform,
    end: PhysicsTransform,
  ) {
    return this.backend.shapeSweep(shape, start, end);
  }

  addImpulse(actorId: string, impulse: Vec3, strength?: number): void {
    const bodyId = this.bodyByActor.get(actorId);
    if (!bodyId) return;
    this.backend.addImpulse(bodyId, impulse, strength);
  }

  /**
   * Lazy character controller keyed by actor guid. Applies the resolved
   * transform to the actor immediately so the next kinematic sync keeps it.
   */
  moveCharacter(
    actor: Actor,
    translation: Vec3,
    dt: number,
    offset?: number,
  ): void {
    if (!this.bodyByActor.has(actor.guid)) {
      this.createForActor(actor);
    }
    const bodyId = this.bodyByActor.get(actor.guid);
    if (!bodyId) return;
    if (!this.characterByActor.has(actor.guid)) {
      const skin = offset != null && offset > 0 ? offset : 0.01;
      this.backend.createCharacterController({
        id: actor.guid,
        bodyId,
        offset: skin,
      });
      this.characterByActor.set(actor.guid, actor.guid);
    }
    const moved = this.backend.moveCharacter(actor.guid, translation, dt);
    if (!moved) return;
    const localTransform = actorLocalPhysicsTransform(moved, actor, this.actors);
    actor.transform.position.x = localTransform.position.x;
    actor.transform.position.y = localTransform.position.y;
    actor.transform.position.z = localTransform.position.z;
    actor.transform.rotation.x = localTransform.rotation.x;
    actor.transform.rotation.y = localTransform.rotation.y;
    actor.transform.rotation.z = localTransform.rotation.z;
    actor.transform.rotation.w = localTransform.rotation.w;
  }

  private createForActor(actor: Actor): void {
    const rigid = actor.components.find(
      (c) => c.classId === "RigidBodyComponent" && !c.destroyed,
    );
    const tilemap = actor.components.find(
      (c) => c.classId === "TilemapComponent" && !c.destroyed,
    );
    if (!rigid && !tilemap) return;
    const bodyId = `body:${actor.guid}`;
    const props = parseRigidBodyProperties(
      rigid ? mapToRecord(rigid.variables) : { motionType: "static", mass: 0, gravityScale: 0 },
    );
    // #region agent log
    agentDebugLog("D", "physics-sync.ts:createForActor", "creating body from actor transform", {
      actorGuid: actor.guid,
      parentId: actor.getVariable("parentId") ?? null,
      motionType: rigid ? props.motionType : "static",
      bodyTransform: actorWorldPhysicsTransform(actor, this.actors),
    });
    // #endregion
    this.backend.createBody({
      id: bodyId,
      actorId: actor.guid,
      motionType: rigid ? props.motionType : "static",
      mass: rigid ? props.mass : 0,
      linearDamping: props.linearDamping,
      angularDamping: props.angularDamping,
      gravityScale: rigid ? props.gravityScale : 0,
      transform: actorWorldPhysicsTransform(actor, this.actors),
    });
    this.bodyByActor.set(actor.guid, bodyId);

    for (const component of actor.components) {
      if (component.classId !== "ColliderComponent" || component.destroyed) {
        continue;
      }
      const collider = parseColliderProperties(
        mapToRecord(component.variables),
        this.backend.kind,
      );
      this.backend.createCollider({
        id: `collider:${component.guid}`,
        bodyId,
        shape: collider.shape,
        friction: collider.friction,
        restitution: collider.restitution,
        isTrigger: collider.isTrigger,
        layer: collider.layer,
        mask: collider.mask,
        translation: {
          x: component.transform.position.x,
          y: component.transform.position.y,
          z: component.transform.position.z,
        },
      });
    }

    if (tilemap) this.createTilemapColliders(actor, bodyId, tilemap);
  }

  private createTilemapColliders(
    actor: Actor,
    bodyId: string,
    component: Actor["components"][number],
  ): void {
    const guid =
      component.assetGuid ??
      (typeof component.getVariable("assetGuid") === "string"
        ? String(component.getVariable("assetGuid"))
        : null);
    if (!guid) return;
    const tilemap = this.tilemaps.get(guid);
    if (!tilemap?.tilesetGuid) return;
    const tileset = this.tilesets.get(tilemap.tilesetGuid);
    if (!tileset) return;
    const ppu = this.pixelsPerUnit > 0 ? this.pixelsPerUnit : 100;
    const worldTileWidth = tilemap.tileWidth / ppu;
    const worldTileHeight = tilemap.tileHeight / ppu;
    let index = 0;
    for (const layer of tilemap.layers) {
      if (!layer.collision) continue;
      for (const chunk of layer.chunks) {
        const chains = tilemapChunkChains({
          tiles: chunk.tiles,
          chunkSize: tilemap.chunkSize,
          chunkX: chunk.cx,
          chunkY: chunk.cy,
          tileset,
          worldTileWidth,
          worldTileHeight,
        });
        for (const chain of chains) {
          if (chain.points.length < 2) continue;
          this.backend.createCollider({
            id: `tilemap:${actor.guid}:${layer.id}:${chunk.cx}:${chunk.cy}:${index}`,
            bodyId,
            shape: { kind: "chain", points: chain.points, loop: chain.loop },
            friction: 0.5,
            restitution: 0,
            isTrigger: false,
            layer: 1,
            mask: 0xffffffff,
          });
          index += 1;
        }
      }
    }
  }
}

function actorTransform(actor: Actor): PhysicsTransform {
  return {
    position: {
      x: actor.transform.position.x,
      y: actor.transform.position.y,
      z: actor.transform.position.z,
    },
    rotation: {
      x: actor.transform.rotation.x,
      y: actor.transform.rotation.y,
      z: actor.transform.rotation.z,
      w: actor.transform.rotation.w,
    },
  };
}

type HierarchyTransform = PhysicsTransform & { scale: Vec3 };

function actorWorldPhysicsTransform(
  actor: Actor,
  actors: readonly Actor[],
): PhysicsTransform {
  const world = actorWorldTransform(actor, actors);
  return { position: world.position, rotation: world.rotation };
}

function actorWorldTransform(actor: Actor, actors: readonly Actor[]): HierarchyTransform {
  const byGuid = new Map(actors.map((entry) => [entry.guid, entry]));
  const chain: Actor[] = [];
  const visited = new Set<string>();
  let current: Actor | undefined = actor;
  while (current && !visited.has(current.guid)) {
    visited.add(current.guid);
    chain.push(current);
    const parentId = actorParentGuid(current);
    current = parentId ? byGuid.get(parentId) : undefined;
  }
  let world = hierarchyTransform(chain[chain.length - 1]!);
  for (let index = chain.length - 2; index >= 0; index -= 1) {
    world = composeHierarchyTransform(world, hierarchyTransform(chain[index]!));
  }
  return world;
}

function actorLocalPhysicsTransform(
  world: PhysicsTransform,
  actor: Actor,
  actors: readonly Actor[],
): PhysicsTransform {
  const parentId = actorParentGuid(actor);
  const parent = parentId ? actors.find((entry) => entry.guid === parentId) : undefined;
  if (!parent) return world;
  const parentWorld = actorWorldTransform(parent, actors);
  const inverseRotation = inverseQuaternion(parentWorld.rotation);
  const offset = rotateVector(inverseRotation, {
    x: world.position.x - parentWorld.position.x,
    y: world.position.y - parentWorld.position.y,
    z: world.position.z - parentWorld.position.z,
  });
  return {
    position: {
      x: divideScale(offset.x, parentWorld.scale.x),
      y: divideScale(offset.y, parentWorld.scale.y),
      z: divideScale(offset.z, parentWorld.scale.z),
    },
    rotation: multiplyQuaternion(inverseRotation, world.rotation),
  };
}

function hierarchyTransform(actor: Actor): HierarchyTransform {
  return {
    ...actorTransform(actor),
    scale: {
      x: actor.transform.scale.x,
      y: actor.transform.scale.y,
      z: actor.transform.scale.z,
    },
  };
}

function composeHierarchyTransform(
  parent: HierarchyTransform,
  local: HierarchyTransform,
): HierarchyTransform {
  const offset = rotateVector(parent.rotation, {
    x: local.position.x * parent.scale.x,
    y: local.position.y * parent.scale.y,
    z: local.position.z * parent.scale.z,
  });
  return {
    position: {
      x: parent.position.x + offset.x,
      y: parent.position.y + offset.y,
      z: parent.position.z + offset.z,
    },
    rotation: multiplyQuaternion(parent.rotation, local.rotation),
    scale: {
      x: parent.scale.x * local.scale.x,
      y: parent.scale.y * local.scale.y,
      z: parent.scale.z * local.scale.z,
    },
  };
}

function actorParentGuid(actor: Actor): string | null {
  const parentId = actor.getVariable("parentId");
  return typeof parentId === "string" && parentId.length > 0 ? parentId : null;
}

function multiplyQuaternion(
  a: PhysicsTransform["rotation"],
  b: PhysicsTransform["rotation"],
): PhysicsTransform["rotation"] {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

function inverseQuaternion(
  value: PhysicsTransform["rotation"],
): PhysicsTransform["rotation"] {
  const lengthSquared =
    value.x * value.x + value.y * value.y + value.z * value.z + value.w * value.w;
  if (lengthSquared === 0) return { x: 0, y: 0, z: 0, w: 1 };
  return {
    x: -value.x / lengthSquared,
    y: -value.y / lengthSquared,
    z: -value.z / lengthSquared,
    w: value.w / lengthSquared,
  };
}

function rotateVector(q: PhysicsTransform["rotation"], value: Vec3): Vec3 {
  const ix = q.w * value.x + q.y * value.z - q.z * value.y;
  const iy = q.w * value.y + q.z * value.x - q.x * value.z;
  const iz = q.w * value.z + q.x * value.y - q.y * value.x;
  const iw = -q.x * value.x - q.y * value.y - q.z * value.z;
  return {
    x: ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
    y: iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
    z: iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x,
  };
}

function divideScale(value: number, scale: number): number {
  return scale === 0 ? 0 : value / scale;
}

function mapToRecord(
  variables: ReadonlyMap<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of variables) out[key] = value;
  return out;
}

function toMap<T>(
  value: ReadonlyMap<string, T> | Readonly<Record<string, T>>,
): Map<string, T> {
  if (value instanceof Map) return new Map(value);
  return new Map(Object.entries(value));
}

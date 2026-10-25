import {
  decodeTileGid,
  spriteAnimationFrameAt,
  spriteClipFrameAt,
  spriteCollisionToBox2d,
  tilemapLayerChains,
  tilemapTilesetGuids,
  type SpriteAnimationPayload,
  type SpritePayload,
  type TilemapPayload,
  type TilesetPayload,
} from "@haptic/assets";
import type { CollisionFilter } from "@haptic/core";
import {
  bakeColliderLocal,
  type ColliderDesc,
  type parseColliderProperties,
  type Vec3,
} from "@haptic/physics";
import type { Actor, ActorComponent } from "@haptic/object-model";
import { componentColliderPhysicsId } from "./physics-collider-id";
import {
  componentAssetGuid,
  toMap,
  type DescriptorScratch,
  type PreparedColliderGeometry,
} from "./physics-preparation";

/** What `SpriteTileColliders` uses of the collider sets that own it. */
export interface SpriteTileCollidersHost {
  geometry(component: ActorComponent, id: string): PreparedColliderGeometry;
  ordinaryCollider(component: ActorComponent): ReturnType<typeof parseColliderProperties>;
  collisionFilter(own: CollisionFilter, presetRef: unknown): CollisionFilter;
}

/** The installed tilemaps and tilesets (`PhysicsWorldSync.setTileContent`). */
export type TileContent = {
  tilemaps:
    | ReadonlyMap<string, TilemapPayload>
    | Readonly<Record<string, TilemapPayload>>;
  tilesets:
    | ReadonlyMap<string, TilesetPayload>
    | Readonly<Record<string, TilesetPayload>>;
  pixelsPerUnit?: number;
};

/** The installed sprites and Sprite Animations (`PhysicsWorldSync.setSpriteContent`). */
export type SpriteContent = {
  sprites:
    | ReadonlyMap<string, SpritePayload>
    | Readonly<Record<string, SpritePayload>>;
  spriteAnimations:
    | ReadonlyMap<string, SpriteAnimationPayload>
    | Readonly<Record<string, SpriteAnimationPayload>>;
  pixelsPerUnit?: number;
};

/** The sprite clip an actor plays, whose current frame sizes its box colliders. */
export type SpriteClipPlayback = {
  assetGuid: string;
  clipName: string;
  normalisedTime: number;
};

/**
 * Installed sprites and tilemaps, and the 2D colliders they supply: sprite-frame
 * boxes and tilemap chains. Both scale by the installation's pixels per unit, so
 * a sprite installation that changes it also rebuilds tilemap chains.
 */
export class SpriteTileColliders {
  private readonly host: SpriteTileCollidersHost;
  private spriteInstallation = 0;
  private tileInstallation = 0;
  private tilemaps = new Map<string, TilemapPayload>();
  private tilesets = new Map<string, TilesetPayload>();
  private sprites = new Map<string, SpritePayload>();
  private spriteAnimations = new Map<string, SpriteAnimationPayload>();
  private spriteClipByActor = new WeakMap<Actor, SpriteClipPlayback>();
  /** Tilemap chains per component; a destroyed component's entry goes with it. */
  private tilemapCollidersByComponent = new WeakMap<
    ActorComponent,
    { assetGuid: string | null; colliders: readonly ColliderDesc[] }
  >();
  private pixelsPerUnit = 100;

  constructor(host: SpriteTileCollidersHost) {
    this.host = host;
  }

  setTileContent(options: TileContent): void {
    const tilemaps = ownedContentMap(options.tilemaps);
    const tilesets = ownedContentMap(options.tilesets);
    this.tileInstallation++;
    this.tilemaps = tilemaps;
    this.tilesets = tilesets;
    this.tilemapCollidersByComponent = new WeakMap();
    if (options.pixelsPerUnit && options.pixelsPerUnit > 0) {
      this.pixelsPerUnit = options.pixelsPerUnit;
    }
  }

  setSpriteContent(options: SpriteContent): void {
    const sprites = ownedContentMap(options.sprites);
    const spriteAnimations = ownedContentMap(options.spriteAnimations);
    this.spriteInstallation++;
    this.sprites = sprites;
    this.spriteAnimations = spriteAnimations;
    if (options.pixelsPerUnit && options.pixelsPerUnit > 0) {
      if (this.pixelsPerUnit !== options.pixelsPerUnit) {
        this.tileInstallation++;
        this.tilemapCollidersByComponent = new WeakMap();
      }
      this.pixelsPerUnit = options.pixelsPerUnit;
    }
  }

  setActorSpriteClip(actor: Actor, clip: SpriteClipPlayback | null): void {
    if (!clip) {
      this.spriteClipByActor.delete(actor);
      return;
    }
    this.spriteClipByActor.set(actor, { ...clip });
  }

  /** A retired body's actor plays no clip. */
  forgetSpriteClip(actor: Actor): void {
    this.spriteClipByActor.delete(actor);
  }

  /**
   * What `PhysicsWorldSync.dispose` releases: the installed content, prepared
   * chains and sprite clips. Pixels per unit and the installation counts stay.
   */
  clear(): void {
    this.tilemapCollidersByComponent = new WeakMap();
    this.spriteClipByActor = new WeakMap();
    this.tilemaps.clear();
    this.tilesets.clear();
    this.sprites.clear();
    this.spriteAnimations.clear();
  }

  /** The tile installation a TilemapComponent's collision descriptor covers. */
  pushTilemapDescriptor(descriptor: DescriptorScratch): void {
    descriptor.push(this.tileInstallation);
  }

  /** The installation and current frame a SpriteComponent's collision descriptor covers. */
  pushSpriteDescriptor(descriptor: DescriptorScratch, actor: Actor, component: ActorComponent): void {
    const playback = this.spritePlayback(actor);
    const frame = resolveSpriteCollisionFrame({
      sprite: this.sprites.get(componentAssetGuid(component) ?? ""),
      animation: playback
        ? this.spriteAnimations.get(playback.assetGuid)
        : undefined,
      playback,
    });
    descriptor.push(this.spriteInstallation);
    descriptor.push(this.pixelsPerUnit);
    descriptor.push(frame?.collision.x);
    descriptor.push(frame?.collision.y);
    descriptor.push(frame?.collision.width);
    descriptor.push(frame?.collision.height);
    descriptor.push(frame?.pivot.x);
    descriptor.push(frame?.pivot.y);
    descriptor.push(frame?.width);
    descriptor.push(frame?.height);
  }

  /** A TilemapComponent's chains, built once per component, tilemap asset and tile installation. */
  collectTilemap(
    actor: Actor,
    bodyId: string,
    scale: Vec3,
    colliders: Map<string, ColliderDesc>,
  ): void {
    const tilemap = actor.components.find(
      (component) =>
        component.classId === "TilemapComponent" &&
        !component.destroyed &&
        component.owner === actor,
    );
    if (tilemap) {
      const assetGuid = componentAssetGuid(tilemap);
      let prepared = this.tilemapCollidersByComponent.get(tilemap);
      if (prepared?.assetGuid !== assetGuid) {
        const collected = new Map<string, ColliderDesc>();
        this.collectTilemapColliders(actor, bodyId, tilemap, collected);
        prepared = { assetGuid, colliders: [...collected.values()] };
        this.tilemapCollidersByComponent.set(tilemap, prepared);
      }
      // Chains follow the component's local transform and the actor's scale,
      // as the tilemap's visual does.
      for (const collider of prepared.colliders) {
        const baked = this.host.geometry(tilemap, collider.id).prepare(collider.shape, tilemap.transform, scale);
        colliders.set(collider.id, { ...collider, bodyId, ...baked });
      }
    }
  }

  collectSpriteColliders(
    actor: Actor,
    bodyId: string,
    scale: Vec3,
    colliders: Map<string, ColliderDesc>,
  ): void {
    const sprite = actor.components.find(
      (component) =>
        component.classId === "SpriteComponent" &&
        !component.destroyed &&
        component.owner === actor,
    );
    if (!sprite) return;
    const spriteGuid =
      sprite.assetGuid ??
      (typeof sprite.getVariable("assetGuid") === "string"
        ? String(sprite.getVariable("assetGuid"))
        : "");
    const spritePayload = spriteGuid ? this.sprites.get(spriteGuid) : undefined;
    const playback = this.spritePlayback(actor);
    const frame = resolveSpriteCollisionFrame({
      sprite: spritePayload,
      animation: playback
        ? this.spriteAnimations.get(playback.assetGuid)
        : undefined,
      playback,
    });
    if (!frame) return;
    const ppu =
      (spritePayload?.pixelsPerUnit && spritePayload.pixelsPerUnit > 0
        ? spritePayload.pixelsPerUnit
        : this.pixelsPerUnit) || 100;
    const mapped = spriteCollisionToBox2d({
      collision: frame.collision,
      pivot: frame.pivot,
      pixelWidth: frame.width ?? 100,
      pixelHeight: frame.height ?? 100,
      pixelsPerUnit: ppu,
    });
    for (const component of actor.components) {
      if (
        component.classId !== "ColliderComponent" ||
        component.destroyed ||
        component.owner !== actor
      ) {
        continue;
      }
      const collider = this.host.ordinaryCollider(component);
      if (collider.shape.kind !== "box2d") continue;
      const colliderId = componentColliderPhysicsId(actor.guid, component.guid);
      const baked = bakeColliderLocal(
        { kind: "box2d", halfExtents: mapped.halfExtents },
        {
          position: {
            x: component.transform.position.x + mapped.translation.x,
            y: component.transform.position.y + mapped.translation.y,
            z: component.transform.position.z,
          },
          rotation: component.transform.rotation,
          scale: component.transform.scale,
        },
        scale,
      );
      colliders.set(colliderId, {
        id: colliderId,
        bodyId,
        shape: baked.shape,
        friction: collider.friction,
        restitution: collider.restitution,
        isTrigger: collider.isTrigger,
        ...this.host.collisionFilter(collider, component.getVariable("collisionPreset")),
        translation: baked.translation,
        rotation: baked.rotation,
      });
    }
  }

  private spritePlayback(actor: Actor) {
    return this.spriteClipByActor.get(actor);
  }

  private collectTilemapColliders(
    actor: Actor,
    bodyId: string,
    component: Actor["components"][number],
    colliders: Map<string, ColliderDesc>,
  ): void {
    const guid =
      component.assetGuid ??
      (typeof component.getVariable("assetGuid") === "string"
        ? String(component.getVariable("assetGuid"))
        : null);
    if (!guid) return;
    const tilemap = this.tilemaps.get(guid);
    if (!tilemap || tilemapTilesetGuids(tilemap).length === 0) return;
    const ppu = this.pixelsPerUnit > 0 ? this.pixelsPerUnit : 100;
    const worldTileWidth = tilemap.tileWidth / ppu;
    const worldTileHeight = tilemap.tileHeight / ppu;
    const resolveGid = (gid: number) => {
      return decodeTileGid(tilemap, gid, this.tilesets);
    };
    const fallback =
      this.tilesets.get(tilemapTilesetGuids(tilemap)[0] ?? "") ??
      this.tilesets.values().next().value;
    if (!fallback) return;
    let index = 0;
    for (const layer of tilemap.layers) {
      if (!layer.collision) continue;
      // One outline per layer: solid tiles merge across chunk borders, so no
      // chain edge sits at a border for a body to catch on.
      const chains = tilemapLayerChains({
        chunks: layer.chunks,
        chunkSize: tilemap.chunkSize,
        tileset: fallback,
        worldTileWidth,
        worldTileHeight,
        resolveGid,
      });
      for (const chain of chains) {
        if (chain.points.length < 2) continue;
        const id = `tilemap:${actor.guid}:${layer.id}:${index}`;
        colliders.set(id, {
          id,
          bodyId,
          // Tilemap-local; the caller bakes the component transform and scale.
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

function resolveSpriteCollisionFrame(options: {
  sprite: SpritePayload | undefined;
  animation: SpriteAnimationPayload | undefined;
  playback:
    { assetGuid: string; clipName: string; normalisedTime: number } | undefined;
}): {
  collision: { x: number; y: number; width: number; height: number };
  pivot: { x: number; y: number };
  width?: number;
  height?: number;
} | null {
  if (options.animation && options.playback) {
    const frame = spriteAnimationFrameAt(
      options.animation,
      options.playback.normalisedTime,
    );
    if (frame) {
      return {
        collision: frame.collision,
        pivot: frame.pivot,
        width: frame.width,
        height: frame.height,
      };
    }
  }
  if (!options.sprite) return null;
  if (options.playback?.clipName) {
    const clipFrame = spriteClipFrameAt(
      options.sprite,
      options.playback.clipName,
      options.playback.normalisedTime,
    );
    if (clipFrame) {
      return {
        collision: clipFrame.collision ?? { x: 0, y: 0, width: 1, height: 1 },
        pivot: clipFrame.pivot,
        width: clipFrame.width,
        height: clipFrame.height,
      };
    }
  }
  const fallback = options.sprite.frames[0];
  if (!fallback) return null;
  return {
    collision: fallback.collision ?? { x: 0, y: 0, width: 1, height: 1 },
    pivot: fallback.pivot,
    width: fallback.width,
    height: fallback.height,
  };
}

/** Installation owns immutable collision content; each call is a new source generation. */
function ownedContentMap<T>(
  value: ReadonlyMap<string, T> | Readonly<Record<string, T>>,
): Map<string, T> {
  return new Map(
    [...toMap(value)].map(([guid, content]) => [
      guid,
      structuredClone(content),
    ]),
  );
}

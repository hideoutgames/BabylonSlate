import {
  decodeTileGid, spriteCollisionToBox2d, tilemapLayerChains, tilemapPivot, tilemapTilesetGuids,
} from "@haptic/assets";
import type { SerializedActor, SerializedTransform } from "@haptic/core";
import { bakeColliderLocal, occluder2DShapes, parseColliderProperties, type ColliderDesc, type ColliderShape, type Occluder2DShape, type Vec3 } from "@haptic/physics";
import type { MeshAssetContext } from "./mesh-assets";

const local = (transform: SerializedTransform | undefined, offset = { x: 0, y: 0 }) => ({
  position: { x: (transform?.position[0] ?? 0) + offset.x, y: (transform?.position[1] ?? 0) + offset.y, z: transform?.position[2] ?? 0 },
  rotation: { x: transform?.rotation[0] ?? 0, y: transform?.rotation[1] ?? 0, z: transform?.rotation[2] ?? 0, w: transform?.rotation[3] ?? 1 },
  scale: { x: transform?.scale[0] ?? 1, y: transform?.scale[1] ?? 1, z: transform?.scale[2] ?? 1 },
});

function desc(id: string, baked: ReturnType<typeof bakeColliderLocal>): ColliderDesc {
  return { id, bodyId: "", friction: 0, restitution: 0, isTrigger: false, layer: 1, mask: 0, ...baked };
}

/**
 * The editor's 2D shadow casters of one actor in a 2D physics Scene, from its document, as Play's 2D world builds its
 * colliders (`PhysicsColliderSets`): each solid Collider's 2D shape (a box sized by the actor's Sprite collision box, as
 * the sprite's static image gives it), and each collision layer of its Tilemap as one merged outline. In the actor's
 * frame, its world scale baked in.
 */
export function authoredOccluders2D(actor: SerializedActor, assets: MeshAssetContext | undefined, actorScale: Vec3): Occluder2DShape[] {
  const colliders: ColliderDesc[] = [];
  const sprite = actor.components.find((component) => component.classId === "SpriteComponent");
  const spriteGuid = typeof sprite?.properties.assetGuid === "string" ? sprite.properties.assetGuid : "";
  const spritePayload = spriteGuid ? assets?.spritePayloads?.get(spriteGuid) : undefined;
  for (const component of actor.components) {
    if (component.classId === "ColliderComponent") {
      const collider = parseColliderProperties(component.properties, "2d");
      if (collider.isTrigger) continue;
      let shape: ColliderShape = collider.shape;
      let offset = { x: 0, y: 0 };
      if (shape.kind === "box2d" && spritePayload) {
        const mapped = spriteCollisionToBox2d({
          collision: spritePayload.collision, pivot: spritePayload.pivot,
          pixelWidth: spritePayload.width ?? 100, pixelHeight: spritePayload.height ?? 100,
          pixelsPerUnit: spritePayload.pixelsPerUnit > 0 ? spritePayload.pixelsPerUnit : assets?.pixelsPerUnit ?? 100,
        });
        shape = { kind: "box2d", halfExtents: mapped.halfExtents };
        offset = mapped.translation;
      }
      colliders.push(desc(component.id, bakeColliderLocal(shape, local(component.transform, offset), actorScale)));
    }
    if (component.classId === "TilemapComponent") {
      const guid = typeof component.properties.assetGuid === "string" ? component.properties.assetGuid : "";
      const tilemap = guid ? assets?.tilemaps?.get(guid) : undefined;
      const tilesets = assets?.tilesets;
      if (!tilemap || !tilesets || tilemapTilesetGuids(tilemap).length === 0) continue;
      const fallback = tilesets.get(tilemapTilesetGuids(tilemap)[0] ?? "") ?? tilesets.values().next().value;
      if (!fallback) continue;
      const ppu = assets?.pixelsPerUnit && assets.pixelsPerUnit > 0 ? assets.pixelsPerUnit : 100;
      for (const layer of tilemap.layers) {
        if (!layer.collision) continue;
        const chains = tilemapLayerChains({
          chunks: layer.chunks, chunkSize: tilemap.chunkSize, tileset: fallback,
          worldTileWidth: tilemap.tileWidth / ppu, worldTileHeight: tilemap.tileHeight / ppu,
          resolveGid: (gid) => decodeTileGid(tilemap, gid, tilesets), pivot: tilemapPivot(tilemap),
        });
        chains.forEach((chain, index) => {
          if (chain.points.length < 2) return;
          const shape: ColliderShape = { kind: "chain", points: chain.points, loop: chain.loop };
          colliders.push(desc(`${component.id}:${layer.id}:${index}`, bakeColliderLocal(shape, local(component.transform), actorScale)));
        });
      }
    }
  }
  return occluder2DShapes(colliders);
}

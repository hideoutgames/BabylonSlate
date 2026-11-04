import {
  tilemapCollisionChains,
  tilemapTilesetGuids,
  type TilemapPayload,
  type TilesetPayload,
} from "@haptic/assets";
import {
  composeAffineTransform,
  multiplyAffineTransforms,
  type AffineTransform,
  type SerializedActor,
  type SerializedComponent,
  type SerializedScene,
  type SerializedTransform,
} from "@haptic/core";
import type { XyChain } from "@haptic/navigation";

function localMatrix(transform: SerializedTransform): AffineTransform {
  const [px, py, pz] = transform.position;
  const [rx, ry, rz, rw] = transform.rotation;
  const [sx, sy, sz] = transform.scale;
  return composeAffineTransform({
    position: { x: px, y: py, z: pz },
    rotation: { x: rx, y: ry, z: rz, w: rw },
    scale: { x: sx, y: sy, z: sz },
  });
}

/**
 * 2D bake walls from the collision layers of every Tilemap actor in `scene`:
 * each actor's chains in world space, through its transform, its parent
 * actors' and its Tilemap component's (`local × parent`, as the viewport
 * places the chunk meshes). A Tilemap two actors draw bakes at both places;
 * its map-space chains are built once.
 */
export function navBakeTilemapChains(
  scene: Pick<SerializedScene, "actors">,
  tilemaps: ReadonlyMap<string, TilemapPayload>,
  tilesets: ReadonlyMap<string, TilesetPayload>,
  pixelsPerUnit: number,
): XyChain[] {
  const ppu = pixelsPerUnit > 0 ? pixelsPerUnit : 100;
  const actors = new Map(scene.actors.map((actor) => [actor.id, actor]));
  const worlds = new Map<string, AffineTransform | null>();
  const actorWorld = (actor: SerializedActor): AffineTransform | null => {
    const known = worlds.get(actor.id);
    if (known !== undefined) return known;
    // A parent cycle resolves to no transform.
    worlds.set(actor.id, null);
    const local = localMatrix(actor.transform);
    const parent = actor.parentId ? actors.get(actor.parentId) : undefined;
    const parentWorld = parent ? actorWorld(parent) : undefined;
    const world = parentWorld === null ? null : parentWorld ? multiplyAffineTransforms(local, parentWorld) : local;
    worlds.set(actor.id, world);
    return world;
  };
  const componentWorld = (actor: SerializedActor, component: SerializedComponent): AffineTransform | null => {
    const byId = new Map(actor.components.map((entry) => [entry.id, entry]));
    let world = actorWorld(actor);
    const chain: SerializedComponent[] = [];
    const seen = new Set<string>();
    for (let at: SerializedComponent | undefined = component; at && !seen.has(at.id); at = at.parentId ? byId.get(at.parentId) : undefined) {
      seen.add(at.id);
      chain.unshift(at);
    }
    for (const entry of chain) {
      if (!world || !entry.transform) continue;
      world = multiplyAffineTransforms(localMatrix(entry.transform), world);
    }
    return world;
  };
  const mapChains = new Map<string, XyChain[]>();
  const chains: XyChain[] = [];
  for (const actor of scene.actors) {
    for (const component of actor.components) {
      if (component.classId !== "TilemapComponent") continue;
      const guid = typeof component.properties.assetGuid === "string" ? component.properties.assetGuid : "";
      const map = tilemaps.get(guid);
      if (!map || tilemapTilesetGuids(map).length === 0) continue;
      let local = mapChains.get(guid);
      if (!local) {
        local = tilemapCollisionChains(map, tilesets, map.tileWidth / ppu, map.tileHeight / ppu);
        mapChains.set(guid, local);
      }
      const world = componentWorld(actor, component);
      if (!world) continue;
      for (const chain of local) {
        chains.push({
          loop: chain.loop,
          points: chain.points.map(({ x, y }) => ({
            x: x * world[0]! + y * world[3]! + world[9]!,
            y: x * world[1]! + y * world[4]! + world[10]!,
          })),
        });
      }
    }
  }
  return chains;
}

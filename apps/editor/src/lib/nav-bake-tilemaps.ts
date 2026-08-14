import {
  tilemapCollisionChains,
  type TilemapPayload,
  type TilesetPayload,
} from "@babylonslate/assets";
import type { XyChain } from "@babylonslate/navigation";

/** 2D bake walls from loaded tilemap collision layers. */
export function navBakeTilemapChains(
  tilemaps: ReadonlyMap<string, TilemapPayload>,
  tilesets: ReadonlyMap<string, TilesetPayload>,
  pixelsPerUnit: number,
): XyChain[] {
  const ppu = pixelsPerUnit > 0 ? pixelsPerUnit : 100;
  const chains: XyChain[] = [];
  for (const map of tilemaps.values()) {
    const tileset = map.tilesetGuid ? tilesets.get(map.tilesetGuid) : undefined;
    if (!tileset) continue;
    chains.push(
      ...tilemapCollisionChains(
        map,
        tileset,
        map.tileWidth / ppu,
        map.tileHeight / ppu,
      ),
    );
  }
  return chains;
}

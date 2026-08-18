import {
  tilemapCollisionChains,
  tilemapTilesetGuids,
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
    if (tilemapTilesetGuids(map).length === 0) continue;
    chains.push(
      ...tilemapCollisionChains(
        map,
        tilesets,
        map.tileWidth / ppu,
        map.tileHeight / ppu,
      ),
    );
  }
  return chains;
}

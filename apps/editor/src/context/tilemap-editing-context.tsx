import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { TilemapTerrainBrush } from "@haptic/assets";
import { TilesetPayloadLoader } from "./tilemap-tileset-payloads";
import { TilesetAtlasLoader } from "./tilemap-tileset-atlases";

export type TilemapTileSelection = { guid: string; localId: number } | null;

/**
 * What a Tilemap document's panels share and rarely changes: the loaders of
 * the referenced Tilesets and their atlases, the paint layer, and the
 * selection setters. Selecting a tile does not change it, so the Details panel
 * does not re-render on a Palette pick.
 */
export interface TilemapSessionContextValue {
  /** Selecting a tile also drops the terrain brush. */
  setSelectedTile: (tile: TilemapTileSelection) => void;
  setSelectedTerrain: (terrain: TilemapTerrainBrush | null) => void;
  /** Referenced Tileset payloads shared by the document's Details, Palette and Paint. */
  tilesetLoader: TilesetPayloadLoader;
  /** Atlas images decoded once for the document's Palette and Paint. */
  atlasLoader: TilesetAtlasLoader;
  /** The layer Paint writes and the Inspector edits; `null` until one is picked (the first layer). */
  layerId: string | null;
  setLayerId: (layerId: string) => void;
}

/** The brush the paint tools use: a tile, or a terrain (autotile) that overrides it. */
export interface TilemapSelectionContextValue {
  selectedTile: TilemapTileSelection;
  /** While set, the paint tools paint this terrain instead of `selectedTile`. */
  selectedTerrain: TilemapTerrainBrush | null;
}

const TilemapSessionContext = createContext<TilemapSessionContextValue | null>(null);
const TilemapSelectionContext = createContext<TilemapSelectionContextValue | null>(null);

export function TilemapEditingProvider({ children }: { children: ReactNode }) {
  const [selectedTile, setTile] = useState<TilemapTileSelection>(null);
  const [selectedTerrain, setSelectedTerrain] = useState<TilemapTerrainBrush | null>(null);
  const [layerId, setLayerId] = useState<string | null>(null);
  const [tilesetLoader] = useState(() => new TilesetPayloadLoader());
  const [atlasLoader] = useState(() => new TilesetAtlasLoader());
  useEffect(() => () => atlasLoader.dispose(), [atlasLoader]);
  const setSelectedTile = useCallback((tile: TilemapTileSelection) => {
    setTile(tile);
    setSelectedTerrain(null);
  }, []);
  const session = useMemo(
    () => ({ setSelectedTile, setSelectedTerrain, tilesetLoader, atlasLoader, layerId, setLayerId }),
    [atlasLoader, layerId, setSelectedTile, tilesetLoader],
  );
  const selection = useMemo(() => ({ selectedTile, selectedTerrain }), [selectedTerrain, selectedTile]);
  return (
    <TilemapSessionContext.Provider value={session}>
      <TilemapSelectionContext.Provider value={selection}>
        {children}
      </TilemapSelectionContext.Provider>
    </TilemapSessionContext.Provider>
  );
}

/* eslint-disable react-refresh/only-export-components -- context module */
export function useOptionalTilemapSession(): TilemapSessionContextValue | null {
  return useContext(TilemapSessionContext);
}

export function useOptionalTilemapSelection(): TilemapSelectionContextValue | null {
  return useContext(TilemapSelectionContext);
}
/* eslint-enable react-refresh/only-export-components */

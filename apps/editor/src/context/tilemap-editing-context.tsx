import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { TilemapTerrainBrush } from "@babylonslate/assets";
import { TilesetPayloadLoader } from "./tilemap-tileset-payloads";

export interface TilemapEditingContextValue {
  selectedTile: { guid: string; localId: number } | null;
  /** Selecting a tile also drops the terrain brush. */
  setSelectedTile: (tile: { guid: string; localId: number } | null) => void;
  /** While set, the paint tools paint this terrain instead of `selectedTile`. */
  selectedTerrain: TilemapTerrainBrush | null;
  setSelectedTerrain: (terrain: TilemapTerrainBrush | null) => void;
  /** Referenced Tileset payloads shared by the document's Details, Palette and Paint. */
  tilesetLoader: TilesetPayloadLoader;
}

const TilemapEditingContext = createContext<TilemapEditingContextValue | null>(
  null,
);

export function TilemapEditingProvider({ children }: { children: ReactNode }) {
  const [selectedTile, setTile] = useState<TilemapEditingContextValue["selectedTile"]>(null);
  const [selectedTerrain, setSelectedTerrain] = useState<TilemapTerrainBrush | null>(null);
  const [tilesetLoader] = useState(() => new TilesetPayloadLoader());
  const setSelectedTile = useCallback((tile: TilemapEditingContextValue["selectedTile"]) => {
    setTile(tile);
    setSelectedTerrain(null);
  }, []);
  const value = useMemo(
    () => ({ selectedTile, setSelectedTile, selectedTerrain, setSelectedTerrain, tilesetLoader }),
    [selectedTerrain, selectedTile, setSelectedTile, tilesetLoader],
  );
  return (
    <TilemapEditingContext.Provider value={value}>
      {children}
    </TilemapEditingContext.Provider>
  );
}

/* eslint-disable react-refresh/only-export-components -- context module */
export function useOptionalTilemapEditing(): TilemapEditingContextValue | null {
  return useContext(TilemapEditingContext);
}
/* eslint-enable react-refresh/only-export-components */

import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { TilesetPayloadLoader } from "./tilemap-tileset-payloads";

export interface TilemapEditingContextValue {
  selectedTile: { guid: string; localId: number } | null;
  setSelectedTile: (tile: { guid: string; localId: number } | null) => void;
  /** Referenced Tileset payloads shared by the document's Details, Palette and Paint. */
  tilesetLoader: TilesetPayloadLoader;
}

const TilemapEditingContext = createContext<TilemapEditingContextValue | null>(
  null,
);

export function TilemapEditingProvider({ children }: { children: ReactNode }) {
  const [selectedTile, setSelectedTile] = useState<TilemapEditingContextValue["selectedTile"]>(null);
  const [tilesetLoader] = useState(() => new TilesetPayloadLoader());
  const value = useMemo(
    () => ({ selectedTile, setSelectedTile, tilesetLoader }),
    [selectedTile, tilesetLoader],
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

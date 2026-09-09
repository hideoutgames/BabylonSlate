import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export interface TilesetEditingContextValue {
  selectedTileId: number;
  setSelectedTileId: (id: number) => void;
  selectedTileIds: number[];
  setSelectedTileIds: (ids: number[]) => void;
  paintCollision: boolean;
  setPaintCollision: (value: boolean) => void;
}

const TilesetEditingContext = createContext<TilesetEditingContextValue | null>(
  null,
);

export function TilesetEditingProvider({ children }: { children: ReactNode }) {
  const [selectedTileIds, setSelectedTileIds] = useState([1]);
  const [paintCollision, setPaintCollision] = useState(false);
  const value = useMemo(
    () => ({
      selectedTileId: selectedTileIds[0] ?? 1,
      setSelectedTileId: (id: number) => setSelectedTileIds([id]),
      selectedTileIds,
      setSelectedTileIds,
      paintCollision,
      setPaintCollision,
    }),
    [paintCollision, selectedTileIds],
  );
  return (
    <TilesetEditingContext.Provider value={value}>
      {children}
    </TilesetEditingContext.Provider>
  );
}

/* eslint-disable react-refresh/only-export-components -- context module */
export function useTilesetEditing(): TilesetEditingContextValue {
  const context = useContext(TilesetEditingContext);
  if (!context) {
    throw new Error(
      "useTilesetEditing must be used within TilesetEditingProvider",
    );
  }
  return context;
}

export function useOptionalTilesetEditing(): TilesetEditingContextValue | null {
  return useContext(TilesetEditingContext);
}
/* eslint-enable react-refresh/only-export-components */

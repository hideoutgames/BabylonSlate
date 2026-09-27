import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export interface TilemapEditingContextValue {
  selectedTile: { guid: string; localId: number } | null;
  setSelectedTile: (tile: { guid: string; localId: number } | null) => void;
}

const TilemapEditingContext = createContext<TilemapEditingContextValue | null>(
  null,
);

export function TilemapEditingProvider({ children }: { children: ReactNode }) {
  const [selectedTile, setSelectedTile] = useState<TilemapEditingContextValue["selectedTile"]>(null);
  const value = useMemo(
    () => ({ selectedTile, setSelectedTile }),
    [selectedTile],
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

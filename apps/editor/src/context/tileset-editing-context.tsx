import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { AtlasTileGridTool } from "@haptic/editor-kit";

export interface TilesetEditingContextValue {
  setSelectedTileId: (id: number) => void;
  selectedTileIds: number[];
  setSelectedTileIds: (ids: number[]) => void;
  paintCollision: boolean;
  setPaintCollision: (value: boolean) => void;
  /** The autotile the Autotiles window edits. */
  selectedAutotileId: string | null;
  setSelectedAutotileId: (id: string | null) => void;
  /** The Preview's tool, kept while the Preview panel remounts. */
  previewTool: AtlasTileGridTool;
  setPreviewTool: (tool: AtlasTileGridTool) => void;
}

const TilesetEditingContext = createContext<TilesetEditingContextValue | null>(
  null,
);

export function TilesetEditingProvider({ children }: { children: ReactNode }) {
  const [selectedTileIds, setSelectedTileIds] = useState([1]);
  const [paintCollision, setPaintCollision] = useState(false);
  const [selectedAutotileId, setSelectedAutotileId] = useState<string | null>(null);
  const [previewTool, setPreviewTool] = useState<AtlasTileGridTool>("move");
  const value = useMemo(
    () => ({
      setSelectedTileId: (id: number) => setSelectedTileIds([id]),
      selectedTileIds,
      setSelectedTileIds,
      paintCollision,
      setPaintCollision,
      selectedAutotileId,
      setSelectedAutotileId,
      previewTool,
      setPreviewTool,
    }),
    [paintCollision, previewTool, selectedAutotileId, selectedTileIds],
  );
  return (
    <TilesetEditingContext.Provider value={value}>
      {children}
    </TilesetEditingContext.Provider>
  );
}

/* eslint-disable react-refresh/only-export-components -- context module */
export function useOptionalTilesetEditing(): TilesetEditingContextValue | null {
  return useContext(TilesetEditingContext);
}
/* eslint-enable react-refresh/only-export-components */

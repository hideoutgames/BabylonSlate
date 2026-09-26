import { createContext, useContext, useState, type ReactNode } from "react";
import type { LandscapeBrush } from "@babylonslate/core";

type FoliageBrush = { radius: number; density: number; spacing: number; maxSlope: number; alignToNormal: boolean; randomYaw: boolean };
function useSceneToolsState() {
  const [landscapeTool, setLandscapeTool] = useState<LandscapeBrush["tool"] | "navigate">("navigate");
  const [landscapeBrush, setLandscapeBrush] = useState<LandscapeBrush>({ tool: "raise", radius: 4, strength: 0.25, falloff: 0.5, height: 0, layer: 0 });
  const [landscapeSelection, setLandscapeSelection] = useState<string | null>(null);
  const [foliageTool, setFoliageTool] = useState<"navigate" | "paint" | "erase">("navigate");
  const [foliageBrush, setFoliageBrush] = useState<FoliageBrush>({ radius: 4, density: 0.25, spacing: 0.5, maxSlope: 60, alignToNormal: true, randomYaw: true });
  const [groupId, setGroupId] = useState<string | null>(null);
  return { landscapeTool, setLandscapeTool, landscapeBrush, setLandscapeBrush, landscapeSelection, setLandscapeSelection,
    foliageTool, setFoliageTool, foliageBrush, setFoliageBrush, groupId, setGroupId };
}
const SceneToolsContext = createContext<ReturnType<typeof useSceneToolsState> | null>(null);
export function SceneToolsProvider({ children }: { children: ReactNode }) {
  return <SceneToolsContext.Provider value={useSceneToolsState()}>{children}</SceneToolsContext.Provider>;
}
// Context modules expose their provider and consumer together.
// eslint-disable-next-line react-refresh/only-export-components
export function useSceneTools() {
  const value = useContext(SceneToolsContext);
  if (!value) throw new Error("Scene tools require SceneToolsProvider");
  return value;
}

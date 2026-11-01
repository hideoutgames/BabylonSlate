import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { LandscapeBrush } from "@haptic/core";
import { TimelinePlayhead } from "../lib/timeline-playhead";

/**
 * The Timeline window while it shows a clip: the Outliner offers Add to
 * Timeline Clip, badges the clip's actors, and rows dropped on the window join
 * the clip.
 */
export interface TimelineDropTarget {
  containsClientPoint(clientX: number, clientY: number): boolean;
  clipName(): string;
  addActors(actorIds: readonly string[]): void;
}

const NO_KEYS: ReadonlySet<string> = new Set();
const NO_UNKEYED: ReadonlyMap<string, unknown> = new Map();

type FoliageBrush = { radius: number; density: number; spacing: number; maxSlope: number; alignToNormal: boolean; randomYaw: boolean };
function useSceneToolsState() {
  const [landscapeTool, setLandscapeTool] = useState<LandscapeBrush["tool"] | "navigate">("navigate");
  const [landscapeBrush, setLandscapeBrush] = useState<LandscapeBrush>({ tool: "raise", radius: 4, strength: 0.25, falloff: 0.5, height: 0, layer: 0 });
  const [landscapeSelection, setLandscapeSelection] = useState<string | null>(null);
  const [foliageTool, setFoliageTool] = useState<"navigate" | "paint" | "erase">("navigate");
  const [foliageBrush, setFoliageBrush] = useState<FoliageBrush>({ radius: 4, density: 0.25, spacing: 0.5, maxSlope: 60, alignToNormal: true, randomYaw: true });
  const [groupId, setGroupId] = useState<string | null>(null);
  // The clip the Timeline mode's Clips, Timeline and Inspector windows show.
  const [timelineClipId, setTimelineClipId] = useState<string | null>(null);
  const [timelinePlayhead] = useState(() => new TimelinePlayhead());
  // Selected keys (`keyRefId` of track id and key id) and the selected track list row.
  const [timelineKeySelection, setTimelineKeySelection] = useState<ReadonlySet<string>>(NO_KEYS);
  const [timelineRowId, setTimelineRowId] = useState<string | null>(null);
  const [timelineDropTarget, setTimelineDropTarget] = useState<TimelineDropTarget | null>(null);
  // Auto Key: a viewport edit of a tracked property keys it at the playhead.
  const [timelineAutoKey, setTimelineAutoKey] = useState(false);
  // Without Auto Key, such an edit is only previewed (track id to value) until it is keyed;
  // moving the playhead discards it.
  const [timelineUnkeyed, setTimelineUnkeyed] = useState<ReadonlyMap<string, unknown>>(NO_UNKEYED);
  useEffect(() => timelinePlayhead.subscribe(() => setTimelineUnkeyed((current) => (current.size ? NO_UNKEYED : current))), [timelinePlayhead]);
  return { landscapeTool, setLandscapeTool, landscapeBrush, setLandscapeBrush, landscapeSelection, setLandscapeSelection,
    foliageTool, setFoliageTool, foliageBrush, setFoliageBrush, groupId, setGroupId, timelineClipId, setTimelineClipId,
    timelinePlayhead, timelineKeySelection, setTimelineKeySelection, timelineRowId, setTimelineRowId, timelineDropTarget, setTimelineDropTarget,
    timelineAutoKey, setTimelineAutoKey, timelineUnkeyed, setTimelineUnkeyed };
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
/** Scene tools, or null outside a Scene or Scene Layer tab. */
// eslint-disable-next-line react-refresh/only-export-components
export function useOptionalSceneTools() {
  return useContext(SceneToolsContext);
}

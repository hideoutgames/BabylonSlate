import { createContext, useCallback, useContext, useMemo } from "react";
import type { SerializedScene, SerializedTimelineClip } from "@haptic/core";
import { useDocumentActions, useOpenDocument, useRegistryState } from "./document-context";
import { useDocumentWorkspace } from "./document-workspace-context";
import { useSceneTools } from "./scene-tools-context";
import { registryClassParentLookup } from "../lib/class-asset-lookup";
import { collectClassGraphsForPalette } from "../lib/logic-graph-document";
import type { TimelinePropertyContext } from "../lib/timeline-property-catalog";
import { withTimelineClip } from "../lib/timeline-track-edits";
import { useOpenDocumentsOfKinds } from "../lib/use-open-documents-of-kinds";
import { classIdForGraphPath } from "../services/script-compiler";

const CLASS_KINDS = ["graph"] as const;

/**
 * What the Timeline windows edit when it is not a Scene's or Scene Layer's own
 * clip: a 2D or 3D Timeline Clip asset, as a scene whose actors are its
 * proxies and whose one clip is the asset's. `proxies` says the rows are
 * proxies, added in the Proxies window rather than from the Outliner.
 */
export interface TimelineClipSource {
  scene: SerializedScene | null;
  clips: SerializedTimelineClip[];
  clip: SerializedTimelineClip | null;
  commitClip: (next: SerializedTimelineClip) => void;
  commitScene: (next: SerializedScene | null) => void;
  proxies?: boolean;
}

const TimelineClipSourceContext = createContext<TimelineClipSource | null>(null);
/** Overrides the Timeline windows' clip for the windows inside it. */
export const TimelineClipSourceProvider = TimelineClipSourceContext.Provider;

/** The Timeline windows' document, its selected clip, and the edits that replace the clip or the scene. */
export function useTimelineClip() {
  const source = useContext(TimelineClipSourceContext);
  const { documentId } = useDocumentWorkspace();
  const { applySceneChange } = useDocumentActions();
  const doc = useOpenDocument(documentId);
  const tools = useSceneTools();
  const scene = doc && (doc.ref.kind === "scene" || doc.ref.kind === "scene-layer") ? doc.content as SerializedScene : null;
  const clips = scene?.timelineClips ?? [];
  const clip = clips.find((entry) => entry.id === tools.timelineClipId) ?? null;
  const commitScene = useCallback((next: SerializedScene | null) => {
    if (next && next !== scene) void applySceneChange(documentId, next);
  }, [applySceneChange, documentId, scene]);
  const commitClip = useCallback((next: SerializedTimelineClip) => {
    if (scene) commitScene(withTimelineClip(scene, next));
  }, [commitScene, scene]);
  if (source) return { ...source, proxies: source.proxies === true, tools };
  return { scene, clips, clip, commitClip, commitScene, proxies: false, tools };
}

/** Class graphs and parents for Class variable tracks, kept current with open Class tabs. */
export function useTimelinePropertyContext(): Omit<TimelinePropertyContext, "classLabel"> & { classLabel: (classId: string) => string | undefined } {
  const { assetRegistry, registryEpoch } = useRegistryState();
  const classDocuments = useOpenDocumentsOfKinds(CLASS_KINDS);
  return useMemo(() => {
    void registryEpoch;
    const assets = assetRegistry?.list() ?? [];
    const names = new Map<string, string>();
    for (const asset of assets) if (asset.header.type === "Class" && asset.path) names.set(classIdForGraphPath(asset.path), asset.header.name);
    return {
      graphs: collectClassGraphsForPalette({ assets, openDocuments: classDocuments, classIdForPath: classIdForGraphPath }),
      parentOf: registryClassParentLookup(assetRegistry),
      classLabel: (classId: string) => names.get(classId),
    };
  }, [assetRegistry, classDocuments, registryEpoch]);
}

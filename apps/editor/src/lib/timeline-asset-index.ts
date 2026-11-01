import {
  TIMELINE_CLIP_ASSET_CLIP_ID,
  normalizeTimelineClipAsset,
  readTimelineClipSummaries,
  timelineClipAssetSummaries,
  timelineClipSummaries,
  type SerializedScene,
  type TimelineClipSummary,
} from "@haptic/core";

/**
 * Which Timeline Clips each Timeline Asset holds. A clip names its asset
 * (`timelineAsset`); the project's clips come from Scene and Scene Layer
 * headers and 2D or 3D Timeline Clip asset headers (`TIMELINE_CLIPS_META`),
 * and an open document's own clips, saved or not, take the place of its
 * header's. A clip asset's one clip is named after the asset.
 */
export interface ProjectTimelineClip {
  clip: TimelineClipSummary;
  documentPath: string;
  documentKind: TimelineClipDocumentKind;
  documentName: string;
  documentGuid: string;
}

export type TimelineClipDocumentKind = "scene" | "scene-layer" | "timeline-clip-2d" | "timeline-clip-3d";

const DOCUMENT_KIND_BY_TYPE: Record<string, TimelineClipDocumentKind> = {
  Scene: "scene", SceneLayer: "scene-layer", TimelineClip2D: "timeline-clip-2d", TimelineClip3D: "timeline-clip-3d",
};

/** A Scene or Scene Layer: its clips are scene clips, reached with Get rather than Create. */
export function isSceneClipDocument(kind: TimelineClipDocumentKind): kind is "scene" | "scene-layer" {
  return kind === "scene" || kind === "scene-layer";
}

type IndexedSceneAsset = {
  path: string;
  header: { type: string; guid: string; name: string; payload?: Record<string, unknown> };
};
type OpenSceneDocument = { ref: { kind: string; path: string }; content: unknown };

export function projectTimelineClips(
  assets: readonly IndexedSceneAsset[],
  openDocuments: Iterable<OpenSceneDocument>,
): ProjectTimelineClip[] {
  const open = new Map<string, readonly TimelineClipSummary[]>();
  for (const doc of openDocuments) {
    if (!doc.content) continue;
    if (doc.ref.kind === "scene" || doc.ref.kind === "scene-layer") {
      open.set(doc.ref.path, timelineClipSummaries((doc.content as SerializedScene).timelineClips));
    } else if (doc.ref.kind === "timeline-clip-2d" || doc.ref.kind === "timeline-clip-3d") {
      open.set(doc.ref.path, readTimelineClipSummaries(timelineClipAssetSummaries(normalizeTimelineClipAsset(doc.content), "")));
    }
  }
  return assets.flatMap((asset): ProjectTimelineClip[] => {
    const documentKind = DOCUMENT_KIND_BY_TYPE[asset.header.type];
    if (!documentKind) return [];
    const clips = open.get(asset.path) ?? readTimelineClipSummaries(asset.header.payload);
    const clipAsset = !isSceneClipDocument(documentKind);
    return clips.filter((clip) => !clipAsset || clip.id === TIMELINE_CLIP_ASSET_CLIP_ID).map((clip) => ({
      clip: clipAsset ? { ...clip, name: asset.header.name } : clip,
      documentPath: asset.path,
      documentKind,
      documentName: asset.header.name,
      documentGuid: asset.header.guid,
    }));
  });
}

/** The clips bound to one Timeline Asset, in project order. */
export function timelineAssetClips(clips: readonly ProjectTimelineClip[], assetGuid: string): ProjectTimelineClip[] {
  return clips.filter((entry) => entry.clip.timelineAsset === assetGuid);
}

/**
 * Why a clip named `clipName` cannot join a Timeline Asset: another clip it
 * holds already has that name. The clip itself (by document and id) is not a
 * clash.
 */
export function timelineBindBlocker(
  clips: readonly ProjectTimelineClip[],
  assetGuid: string,
  clip: { documentPath: string; clipId: string; clipName: string },
): string | undefined {
  const clash = timelineAssetClips(clips, assetGuid).find((entry) =>
    entry.clip.name === clip.clipName && !(entry.documentPath === clip.documentPath && entry.clip.id === clip.clipId));
  return clash ? `Already holds a clip named ${clip.clipName} (${clash.documentName}).` : undefined;
}

/** Each Timeline Asset's clips that share a name with another clip it holds. */
export function timelineClipNameCollisions(clips: readonly ProjectTimelineClip[]): ProjectTimelineClip[] {
  const byAssetAndName = new Map<string, ProjectTimelineClip[]>();
  for (const entry of clips) {
    if (!entry.clip.timelineAsset) continue;
    const key = `${entry.clip.timelineAsset}\u0000${entry.clip.name}`;
    byAssetAndName.set(key, [...(byAssetAndName.get(key) ?? []), entry]);
  }
  return [...byAssetAndName.values()].filter((group) => group.length > 1).flat();
}

/** The scene with one clip bound to `assetGuid`, or unbound when it is undefined. */
export function bindTimelineClip(scene: SerializedScene, clipId: string, assetGuid: string | undefined): SerializedScene {
  const clips = scene.timelineClips ?? [];
  const index = clips.findIndex((clip) => clip.id === clipId);
  if (index < 0 || clips[index]!.timelineAsset === assetGuid) return scene;
  const next = { ...clips[index]! };
  if (assetGuid) next.timelineAsset = assetGuid;
  else delete next.timelineAsset;
  return { ...scene, timelineClips: clips.map((clip, at) => (at === index ? next : clip)) };
}

import {
  readTimelineClipSummaries,
  timelineClipSummaries,
  type SerializedScene,
  type TimelineClipSummary,
} from "@haptic/core";

/**
 * Which Timeline Clips each Timeline Asset holds. A clip names its asset
 * (`timelineAsset`); the project's clips come from Scene and Scene Layer
 * headers (`TIMELINE_CLIPS_META`), and an open document's own clips, saved or
 * not, take the place of its header's.
 */
export interface ProjectTimelineClip {
  clip: TimelineClipSummary;
  documentPath: string;
  documentKind: "scene" | "scene-layer";
  documentName: string;
  documentGuid: string;
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
    if ((doc.ref.kind === "scene" || doc.ref.kind === "scene-layer") && doc.content) {
      open.set(doc.ref.path, timelineClipSummaries((doc.content as SerializedScene).timelineClips));
    }
  }
  return assets.flatMap((asset): ProjectTimelineClip[] => {
    const documentKind = asset.header.type === "Scene" ? "scene" : asset.header.type === "SceneLayer" ? "scene-layer" : null;
    if (!documentKind) return [];
    const clips = open.get(asset.path) ?? readTimelineClipSummaries(asset.header.payload);
    return clips.map((clip) => ({
      clip,
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

import {
  createTimelineClip,
  uniqueTimelineClipName,
  type SerializedScene,
  type SerializedTimelineClip,
} from "@haptic/core";

/** Clips panel edits on a Scene (or a Scene Layer tab's scene); each returns the next document. */

const clipsOf = (scene: SerializedScene): SerializedTimelineClip[] => scene.timelineClips ?? [];
const withClips = (scene: SerializedScene, timelineClips: SerializedTimelineClip[]): SerializedScene => {
  const next = { ...scene };
  if (timelineClips.length === 0) delete next.timelineClips;
  else next.timelineClips = timelineClips;
  return next;
};
const namesExcept = (scene: SerializedScene, id?: string) => clipsOf(scene).filter((clip) => clip.id !== id).map((clip) => clip.name);

/** A copy takes a new id and a free name, and drops its Timeline Asset binding. */
function copyClip(clip: SerializedTimelineClip, id: string, taken: readonly string[]): SerializedTimelineClip {
  const copy = { ...structuredClone(clip), id, name: uniqueTimelineClipName(clip.name, taken) };
  delete copy.timelineAsset;
  return copy;
}

export function createClip(scene: SerializedScene, id: string): SerializedScene {
  const clip = createTimelineClip(id, uniqueTimelineClipName("Timeline Clip", namesExcept(scene)));
  return withClips(scene, [...clipsOf(scene), clip]);
}

/** Null when `name` is blank or already the clip's name; a name another clip has gets a number. */
export function renameClip(scene: SerializedScene, id: string, name: string): SerializedScene | null {
  const clip = clipsOf(scene).find((entry) => entry.id === id);
  const trimmed = name.trim();
  if (!clip || !trimmed || trimmed === clip.name) return null;
  const unique = uniqueTimelineClipName(trimmed, namesExcept(scene, id));
  return withClips(scene, clipsOf(scene).map((entry) => (entry.id === id ? { ...entry, name: unique } : entry)));
}

/** The copy goes right after the original. */
export function duplicateClip(scene: SerializedScene, id: string, newId: string): SerializedScene | null {
  const clips = clipsOf(scene);
  const index = clips.findIndex((clip) => clip.id === id);
  if (index < 0) return null;
  const copy = copyClip(clips[index]!, newId, clips.map((clip) => clip.name));
  return withClips(scene, [...clips.slice(0, index + 1), copy, ...clips.slice(index + 1)]);
}

/** Pasted clips go at the end, each with an id from `newIds`. Tracks keep their actor ids. */
export function pasteClips(
  scene: SerializedScene,
  copied: readonly SerializedTimelineClip[],
  newIds: readonly string[],
): SerializedScene {
  const clips = [...clipsOf(scene)];
  copied.forEach((clip, index) => {
    clips.push(copyClip(clip, newIds[index]!, clips.map((entry) => entry.name)));
  });
  return withClips(scene, clips);
}

export function deleteClip(scene: SerializedScene, id: string): SerializedScene | null {
  const clips = clipsOf(scene);
  if (!clips.some((clip) => clip.id === id)) return null;
  return withClips(scene, clips.filter((clip) => clip.id !== id));
}

/** Object tracks whose actor the document does not have, as after pasting into another document. */
export function missingTrackActorIds(scene: SerializedScene, clip: SerializedTimelineClip): string[] {
  const actors = new Set(scene.actors.map((actor) => actor.id));
  return clip.objects.filter((object) => !actors.has(object.actorId)).map((object) => object.actorId);
}

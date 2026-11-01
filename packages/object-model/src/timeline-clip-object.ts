import { createTimelinePlayback, type SerializedTimelineClip, type TimelinePlaybackState } from "@haptic/core";
import { embeddedScriptParentOf } from "./ids";
import { EngineObject } from "./objects";

export const TIMELINE_CLIP_CLASS_ID = "TimelineClip";

/**
 * Class of one Scene or Scene Layer document's clip: extends `TimelineClip`
 * and declares one Event Dispatcher per Custom Event Track. The id never
 * changes with renames or binding.
 */
export function timelineClipClassId(documentGuid: string, clipId: string): string {
  return `${TIMELINE_CLIP_CLASS_ID}:${documentGuid}:${clipId}`;
}

export function isTimelineClipClassId(classId: string): boolean {
  return classId.startsWith(`${TIMELINE_CLIP_CLASS_ID}:`);
}

/** Parent of a class the engine makes for a document (a Scene, Scene Layer or clip); undefined for any other id. */
export function documentClassParentOf(classId: string): "Scene" | "SceneLayer" | "TimelineClip" | undefined {
  return embeddedScriptParentOf(classId) ?? (isTimelineClipClassId(classId) ? TIMELINE_CLIP_CLASS_ID : undefined);
}

/** Engine-declared Timeline Clip dispatchers; Custom Event Tracks cannot take these names. */
export const TIMELINE_CLIP_BUILT_IN_DISPATCHERS = ["On Finished", "On Looped"] as const;

/**
 * One Timeline Clip of one loaded Scene or Scene Layer copy (`Get <Name>
 * Timeline Clip`). The runtime owns it: it is created with its owner, ends with
 * it, and is never registered for collection. Each copy has its own playback.
 */
export class TimelineClipObject extends EngineObject {
  readonly clip: SerializedTimelineClip;
  /** The Scene or Scene Layer that placed the animated actors. */
  readonly owner: EngineObject;
  playback: TimelinePlaybackState;
  /** Auto Play has run (or the clip was played) since the owner loaded. */
  started = false;
  /** Values the animated properties had when Play started, for When Finished: Restore State. */
  restore: Map<string, () => void> | null = null;
  /** Counts playback changes, so a key's listener that moves the clip ends that step's firing. */
  generation = 0;

  constructor(clip: SerializedTimelineClip, owner: EngineObject, classId: string = TIMELINE_CLIP_CLASS_ID) {
    super({ classId, guid: `${owner.guid}:timeline-clip:${clip.id}` });
    this.clip = clip;
    this.owner = owner;
    this.playback = createTimelinePlayback(clip);
  }
}

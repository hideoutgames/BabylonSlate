import { createTimelinePlayback, type SerializedTimelineClip, type TimelinePlaybackState } from "@haptic/core";
import { EngineObject } from "./objects";

export const TIMELINE_CLIP_CLASS_ID = "TimelineClip";

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
  /** Values the animated properties had before the clip first played, for When Finished: Restore. */
  restore: Map<string, () => void> | null = null;

  constructor(clip: SerializedTimelineClip, owner: EngineObject) {
    super({ classId: TIMELINE_CLIP_CLASS_ID, guid: `${owner.guid}:timeline-clip:${clip.id}` });
    this.clip = clip;
    this.owner = owner;
    this.playback = createTimelinePlayback(clip);
  }
}

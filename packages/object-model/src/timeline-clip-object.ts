import { createTimelinePlayback, type SerializedTimelineClip, type TimelinePlaybackState, type Transform } from "@haptic/core";
import { embeddedScriptParentOf } from "./ids";
import { Actor, ActorComponent, EngineObject } from "./objects";
import { TIMELINE_CLASS_ID, isTimelineClassId } from "./timeline-object";

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

/** Parent of a class the engine makes for a document (a Scene, Scene Layer, clip or Timeline Asset); undefined for any other id. */
export function documentClassParentOf(classId: string): "Scene" | "SceneLayer" | "TimelineClip" | "Timeline" | undefined {
  if (isTimelineClipClassId(classId)) return TIMELINE_CLIP_CLASS_ID;
  if (isTimelineClassId(classId)) return TIMELINE_CLASS_ID;
  return embeddedScriptParentOf(classId);
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

  constructor(clip: SerializedTimelineClip, owner: EngineObject, classId: string = TIMELINE_CLIP_CLASS_ID, guid = `${owner.guid}:timeline-clip:${clip.id}`) {
    super({ classId, guid });
    this.clip = clip;
    this.owner = owner;
    this.playback = createTimelinePlayback(clip);
  }
}

/** A proxy's runtime stand-in: the object its tracks write to, and how. */
export interface TimelineProxyBinding {
  target: Actor | ActorComponent;
  /** Keys set the transform directly (world for an actor, parent-relative for a component); else they offset `base`. */
  absolute: boolean;
  /** The target's local transform when it was bound, which Relative keys offset. */
  base: Transform;
}

/**
 * One instance of a 2D or 3D Timeline Clip asset (`Create <Name> Timeline
 * Clip`): its own playback and proxy bindings over the asset's shared keys.
 * Unlike a scene clip it is collectable: it lives while a script reference
 * reaches it or while it plays. Its owner is its Timeline Asset's Timeline.
 */
export class TimelineClipInstance extends TimelineClipObject {
  /** The clip asset's guid. */
  readonly assetGuid: string;
  /** Each proxy's kind, by proxy id (the clip's object track actor ids). */
  readonly proxies: ReadonlyMap<string, { name: string; represents: "actor" | "component" }>;
  readonly bindings = new Map<string, TimelineProxyBinding>();
  /** Proxies already reported unbound to the Output Log. */
  readonly unboundWarned = new Set<string>();

  constructor(
    clip: SerializedTimelineClip,
    owner: EngineObject,
    classId: string,
    assetGuid: string,
    proxies: ReadonlyMap<string, { name: string; represents: "actor" | "component" }>,
    guid: string,
  ) {
    super(clip, owner, classId, guid);
    this.assetGuid = assetGuid;
    this.proxies = proxies;
  }
}

/** Whether `object` can stand in for a proxy that `represents` an actor or a component. */
export function timelineProxyAccepts(represents: "actor" | "component", object: unknown): object is Actor | ActorComponent {
  return represents === "actor" ? object instanceof Actor : object instanceof ActorComponent;
}

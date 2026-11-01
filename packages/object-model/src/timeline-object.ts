import { EngineObject } from "./objects";

export const TIMELINE_CLASS_ID = "Timeline";

/**
 * Class of one Timeline Asset's Timeline object: extends `Timeline`, with a
 * getter per scene clip the asset holds and the re-fired clip events.
 */
export function timelineClassId(assetGuid: string): string {
  return `${TIMELINE_CLASS_ID}:${assetGuid}`;
}

export function isTimelineClassId(classId: string): boolean {
  return classId.startsWith(`${TIMELINE_CLASS_ID}:`);
}

/** The Timeline Asset guid of a `Timeline:<guid>` class, else undefined. */
export function timelineAssetGuidOf(classId: string | undefined): string | undefined {
  return classId && isTimelineClassId(classId) ? classId.slice(TIMELINE_CLASS_ID.length + 1) || undefined : undefined;
}

/**
 * The dispatcher a Timeline re-fires a clip's event on: `On Door Open
 * (Intro)`, also `On Finished (Intro)` and `On Looped (Intro)`.
 */
export function timelineRefiredDispatcherName(event: string, clipName: string): string {
  return `${event} (${clipName})`;
}

/** Name of the input a re-fired event adds after the clip event's own inputs. */
export const TIMELINE_REFIRED_CLIP_INPUT = "Timeline Clip";

/**
 * The runtime object of one Timeline Asset: one per asset per session, valid
 * whether or not the scenes holding its clips are loaded. It finds those
 * clips and re-fires their events.
 */
export class TimelineObject extends EngineObject {
  readonly assetGuid: string;

  constructor(assetGuid: string) {
    super({ classId: timelineClassId(assetGuid), guid: `${assetGuid}:timeline` });
    this.assetGuid = assetGuid;
  }
}

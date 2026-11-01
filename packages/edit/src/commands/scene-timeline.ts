import type { SerializedScene, SerializedTimelineClip } from "@haptic/core";
import type { EditCommand } from "../command";
import { snapshotBytes } from "../snapshot-bytes";

/** The document with `clips`; an empty list removes the field, as documents without clips never have it. */
function withClips(doc: SerializedScene, clips: SerializedTimelineClip[]): SerializedScene {
  const next = { ...doc };
  if (clips.length === 0) delete next.timelineClips;
  else next.timelineClips = clips;
  return next;
}

export class AddTimelineClipCommand implements EditCommand<SerializedScene> {
  readonly type = "scene.addTimelineClip";
  readonly clip: SerializedTimelineClip;
  readonly index: number;
  #byteSize?: number;
  /** Retained snapshot cost, measured on first read and memoised. */
  get byteSize(): number {
    return (this.#byteSize ??= snapshotBytes(this.clip));
  }

  constructor(clip: SerializedTimelineClip, index = -1) {
    this.clip = clip;
    this.index = index;
  }

  apply(doc: SerializedScene): SerializedScene {
    const clips = [...(doc.timelineClips ?? [])];
    if (clips.some((clip) => clip.id === this.clip.id)) return doc;
    if (this.index >= 0 && this.index <= clips.length) clips.splice(this.index, 0, this.clip);
    else clips.push(this.clip);
    return withClips(doc, clips);
  }

  invert(): RemoveTimelineClipCommand {
    return new RemoveTimelineClipCommand(this.clip, this.index);
  }
}

export class RemoveTimelineClipCommand implements EditCommand<SerializedScene> {
  readonly type = "scene.removeTimelineClip";
  readonly clip: SerializedTimelineClip;
  readonly index: number;
  #byteSize?: number;
  /** Retained snapshot cost, measured on first read and memoised. */
  get byteSize(): number {
    return (this.#byteSize ??= snapshotBytes(this.clip));
  }

  constructor(clip: SerializedTimelineClip, index = -1) {
    this.clip = clip;
    this.index = index;
  }

  apply(doc: SerializedScene): SerializedScene {
    if (!doc.timelineClips?.some((clip) => clip.id === this.clip.id)) return doc;
    return withClips(doc, doc.timelineClips.filter((clip) => clip.id !== this.clip.id));
  }

  invert(): AddTimelineClipCommand {
    return new AddTimelineClipCommand(this.clip, this.index);
  }
}

/**
 * Replaces one clip (rename, settings, tracks and keys). `mergeKey` folds one
 * continuous gesture on the clip, such as a key drag, into one Undo step.
 */
export class SetTimelineClipCommand implements EditCommand<SerializedScene> {
  readonly type = "scene.setTimelineClip";
  readonly mergeKey: string | undefined;
  readonly clipId: string;
  readonly from: SerializedTimelineClip;
  readonly to: SerializedTimelineClip;
  #byteSize?: number;
  /** Retained snapshot cost, measured on first read and memoised. */
  get byteSize(): number {
    return (this.#byteSize ??= snapshotBytes({ from: this.from, to: this.to }));
  }

  constructor(clipId: string, from: SerializedTimelineClip, to: SerializedTimelineClip, mergeKey?: string) {
    this.clipId = clipId;
    this.from = from;
    this.to = to;
    this.mergeKey = mergeKey;
  }

  apply(doc: SerializedScene): SerializedScene {
    if (!doc.timelineClips?.some((clip) => clip.id === this.clipId)) return doc;
    return withClips(doc, doc.timelineClips.map((clip) => (clip.id === this.clipId ? this.to : clip)));
  }

  invert(): SetTimelineClipCommand {
    return new SetTimelineClipCommand(this.clipId, this.to, this.from, this.mergeKey);
  }
}

/** Clips order; `to` is the index after the clip leaves `from`. */
export class ReorderTimelineClipCommand implements EditCommand<SerializedScene> {
  readonly type = "scene.reorderTimelineClip";
  readonly clipId: string;
  readonly from: number;
  readonly to: number;
  #byteSize?: number;
  /** Retained snapshot cost, measured on first read and memoised. */
  get byteSize(): number {
    return (this.#byteSize ??= snapshotBytes({ clipId: this.clipId, from: this.from, to: this.to }));
  }

  constructor(clipId: string, from: number, to: number) {
    this.clipId = clipId;
    this.from = from;
    this.to = to;
  }

  apply(doc: SerializedScene): SerializedScene {
    const clips = [...(doc.timelineClips ?? [])];
    // Only the clip recorded at `from` moves, as in ReorderFolderCommand.
    if (clips.findIndex((clip) => clip.id === this.clipId) !== this.from) return doc;
    const [moved] = clips.splice(this.from, 1);
    clips.splice(Math.max(0, Math.min(this.to, clips.length)), 0, moved!);
    return withClips(doc, clips);
  }

  invert(): ReorderTimelineClipCommand {
    return new ReorderTimelineClipCommand(this.clipId, this.to, this.from);
  }
}

const clipOf = (value: unknown) => value as SerializedTimelineClip;

export function createAddTimelineClipCommandFromJson(payload: Record<string, unknown>): AddTimelineClipCommand {
  return new AddTimelineClipCommand(clipOf(payload.clip), Number(payload.index));
}

export function createRemoveTimelineClipCommandFromJson(payload: Record<string, unknown>): RemoveTimelineClipCommand {
  return new RemoveTimelineClipCommand(clipOf(payload.clip), Number(payload.index));
}

export function createSetTimelineClipCommandFromJson(payload: Record<string, unknown>): SetTimelineClipCommand {
  return new SetTimelineClipCommand(String(payload.clipId), clipOf(payload.from), clipOf(payload.to),
    typeof payload.mergeKey === "string" ? payload.mergeKey : undefined);
}

export function createReorderTimelineClipCommandFromJson(payload: Record<string, unknown>): ReorderTimelineClipCommand {
  return new ReorderTimelineClipCommand(String(payload.clipId), Number(payload.from), Number(payload.to));
}

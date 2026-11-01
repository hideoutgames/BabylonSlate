import {
  advanceTimelinePlayback,
  evaluateTimelineTrack,
  parseTimelineLoopMode,
  timelineStoredValue,
  type SerializedTimelineClip,
  type TimelineLoopMode,
  type TimelinePropertyTrack,
} from "@haptic/core";
import { Actor, ActorComponent, TimelineClipObject, type EngineObject } from "@haptic/object-model";
import { applyTweenTransform } from "./tween-transforms";

/** What Timeline playback needs from the running game. */
export interface TimelineRuntimeHost {
  /** The clips an owner's document authored: the main Scene's or a Scene Layer's. */
  clipsFor(owner: EngineObject): readonly SerializedTimelineClip[] | undefined;
  /** The live actor an owner placed under an authored actor id, per Scene or Scene Layer copy. */
  ownedActor(owner: EngineObject, actorId: string): Actor | null;
  findActor(guid: string): Actor | null | undefined;
  component(actor: Actor, componentId: string): ActorComponent | null;
  teleportActor(actor: Actor): void;
  refreshComponent(component: ActorComponent, property: string): void;
}

const CHANNEL = { location: "position", rotation: "rotation", scale: "scale" } as const;

/**
 * Plays the Timeline Clips of every loaded Scene and Scene Layer copy. Each
 * copy gets its own Timeline Clip objects when it loads; they end with it.
 * Playing clips advance once per tick, before actors tick, and write their
 * tracks' values to the animated actors through the same paths tweens use.
 */
export class TimelineRuntime {
  private readonly host: TimelineRuntimeHost;
  private readonly owners = new Map<EngineObject, Map<string, TimelineClipObject>>();

  constructor(host: TimelineRuntimeHost) {
    this.host = host;
  }

  /** Creates a Scene or Scene Layer copy's clip objects the first time they are needed. */
  private ensure(owner: EngineObject): Map<string, TimelineClipObject> | undefined {
    if (owner.destroyed) return undefined;
    let clips = this.owners.get(owner);
    if (!clips) {
      clips = new Map((this.host.clipsFor(owner) ?? []).map((clip) => [clip.id, new TimelineClipObject(clip, owner)]));
      this.owners.set(owner, clips);
    }
    return clips;
  }

  /** Ends the clips of a copy that unloaded; references to them read as empty. */
  remove(owner: EngineObject): void {
    const clips = this.owners.get(owner);
    if (!clips) return;
    for (const clip of clips.values()) clip.destroyed = true;
    this.owners.delete(owner);
  }

  reset(): void {
    for (const owner of [...this.owners.keys()]) this.remove(owner);
  }

  clip(owner: EngineObject | null | undefined, clipId: string): TimelineClipObject | null {
    if (!owner) return null;
    const clip = this.ensure(owner)?.get(clipId);
    return clip && !clip.destroyed ? clip : null;
  }

  /** Every clip of every loaded copy. */
  clips(): TimelineClipObject[] {
    return [...this.owners.values()].flatMap((clips) => [...clips.values()]);
  }

  /**
   * One tick for the live `owners`: Auto Play starts, playing clips move on and
   * apply their values. Copies that ended are dropped.
   */
  advance(dt: number, owners: Iterable<EngineObject>, canRun: (owner: EngineObject) => boolean): void {
    for (const owner of owners) this.ensure(owner);
    for (const [owner, clips] of [...this.owners]) {
      if (owner.destroyed) {
        this.remove(owner);
        continue;
      }
      if (!canRun(owner)) continue;
      for (const clip of clips.values()) {
        if (!clip.started && clip.clip.autoPlay) this.play(clip);
        if (!clip.playback.playing) continue;
        const result = advanceTimelinePlayback(clip.playback, clip.clip.length, dt);
        clip.playback = result.state;
        this.apply(clip);
        if (result.finished && clip.clip.whenFinished === "restore") this.restoreValues(clip);
      }
    }
  }

  /** Plays forwards, or in reverse, from where the clip is; a Once clip at the end it plays towards starts over. */
  play(clip: TimelineClipObject, reverse = false): void {
    if (clip.destroyed) return;
    this.captureRestore(clip);
    clip.started = true;
    const playback = clip.playback;
    const direction = reverse ? -1 : 1;
    const length = clip.clip.length;
    const atEnd = reverse ? playback.time <= 0 : playback.time >= length;
    const time = playback.loopMode === "once" && atEnd ? (reverse ? length : 0) : playback.time;
    clip.playback = { ...playback, time, direction, playing: true };
    this.apply(clip);
  }

  playFromStart(clip: TimelineClipObject): void {
    if (clip.destroyed) return;
    clip.playback = { ...clip.playback, time: 0 };
    this.play(clip);
  }

  pause(clip: TimelineClipObject): void {
    clip.playback = { ...clip.playback, playing: false };
  }

  /** Stops and returns to the start, or to the end while playing in reverse. */
  stop(clip: TimelineClipObject): void {
    if (clip.destroyed) return;
    clip.started = true;
    const time = clip.playback.direction < 0 ? clip.clip.length : 0;
    clip.playback = { ...clip.playback, playing: false, time };
    this.apply(clip);
  }

  setPosition(clip: TimelineClipObject, time: number): void {
    if (clip.destroyed || !Number.isFinite(time)) return;
    this.captureRestore(clip);
    clip.playback = { ...clip.playback, time: Math.min(clip.clip.length, Math.max(0, time)) };
    this.apply(clip);
  }

  /** Never below 0: Reverse plays backwards. */
  setPlayRate(clip: TimelineClipObject, rate: number): void {
    if (Number.isFinite(rate)) clip.playback = { ...clip.playback, rate: Math.max(0, rate) };
  }

  setLoopMode(clip: TimelineClipObject, loopMode: TimelineLoopMode): void {
    clip.playback = { ...clip.playback, loopMode };
  }

  /** Writes every unmuted track's value at the clip's time to its actor. */
  apply(clip: TimelineClipObject): void {
    if (clip.destroyed) return;
    for (const object of clip.clip.objects) {
      const actor = this.host.ownedActor(clip.owner, object.actorId);
      if (!actor || actor.destroyed) continue;
      for (const track of object.tracks) {
        if (track.muted) continue;
        const value = evaluateTimelineTrack(track, clip.playback.time);
        if (value !== undefined) this.write(actor, track, value);
      }
    }
  }

  private write(actor: Actor, track: TimelinePropertyTrack, value: unknown): void {
    const { target } = track;
    if (target.kind === "transform") {
      const channel = CHANNEL[target.property as keyof typeof CHANNEL];
      if (channel && applyTweenTransform(actor, channel, value, "local", (id) => this.host.findActor(id) ?? undefined)) this.host.teleportActor(actor);
      return;
    }
    if (target.kind === "visible") {
      actor.setVariable("visible", value === true);
      return;
    }
    if (target.kind === "variable") {
      actor.setVariable(target.property, timelineStoredValue(track, value, actor.getVariable(target.property), false));
      return;
    }
    const component = target.componentId ? this.host.component(actor, target.componentId) : null;
    if (!component) return;
    component.setVariable(target.property, timelineStoredValue(track, value, component.getVariable(target.property), true));
    this.host.refreshComponent(component, target.property);
  }

  /** The animated properties' values when Play starts, for When Finished: Restore State. */
  private captureRestore(clip: TimelineClipObject): void {
    if (clip.restore || clip.clip.whenFinished !== "restore") return;
    const restore = new Map<string, () => void>();
    for (const object of clip.clip.objects) {
      const actor = this.host.ownedActor(clip.owner, object.actorId);
      if (!actor) continue;
      for (const track of object.tracks) {
        const { target } = track;
        const key = `${object.actorId}:${target.kind}:${target.componentId ?? ""}:${target.property}`;
        if (restore.has(key)) continue;
        if (target.kind === "transform") {
          const channel = CHANNEL[target.property as keyof typeof CHANNEL];
          if (!channel) continue;
          const saved = structuredClone(actor.transform[channel]);
          restore.set(key, () => {
            if (actor.destroyed) return;
            Object.assign(actor.transform[channel], saved);
            this.host.teleportActor(actor);
          });
        } else if (target.kind === "component") {
          const component = target.componentId ? this.host.component(actor, target.componentId) : null;
          if (!component) continue;
          const saved = structuredClone(component.getVariable(target.property));
          restore.set(key, () => {
            if (component.destroyed) return;
            component.setVariable(target.property, structuredClone(saved));
            this.host.refreshComponent(component, target.property);
          });
        } else {
          const name = target.kind === "visible" ? "visible" : target.property;
          const saved = structuredClone(actor.getVariable(name));
          restore.set(key, () => {
            if (!actor.destroyed) actor.setVariable(name, structuredClone(saved));
          });
        }
      }
    }
    clip.restore = restore;
  }

  /** Puts the values from when Play started back; the next Play captures them again. */
  private restoreValues(clip: TimelineClipObject): void {
    for (const restore of clip.restore?.values() ?? []) restore();
    clip.restore = null;
  }
}

/** Runs a Timeline Clip control node (`timelineClip.*`). */
export function timelineClipControl(
  timelines: TimelineRuntime,
  clip: TimelineClipObject,
  action: string,
  args: Record<string, unknown>,
): void {
  switch (action) {
    case "play": timelines.play(clip); return;
    case "playFromStart": timelines.playFromStart(clip); return;
    case "reverse": timelines.play(clip, true); return;
    case "pause": timelines.pause(clip); return;
    case "stop": timelines.stop(clip); return;
    case "setPosition": timelines.setPosition(clip, Number(args.time)); return;
    case "setPlayRate": timelines.setPlayRate(clip, Number(args.playRate)); return;
    case "setLoopMode": {
      const loopMode = parseTimelineLoopMode(args.loopMode);
      if (loopMode) timelines.setLoopMode(clip, loopMode);
      return;
    }
  }
}

/** A Timeline Clip read (`timelineClip.get*`, `timelineClip.is*`). */
export function timelineClipState(clip: TimelineClipObject, field: string): number | boolean {
  switch (field) {
    case "position": return clip.playback.time;
    case "length": return clip.clip.length;
    case "playRate": return clip.playback.rate;
    case "playing": return clip.playback.playing;
    case "reversed": return clip.playback.direction < 0;
    default: return 0;
  }
}

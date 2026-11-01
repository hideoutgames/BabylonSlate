import {
  advanceTimelinePlayback,
  evaluateTimelineTrack,
  timelineStoredValue,
  type SerializedTimelineClip,
  type TimelinePropertyTrack,
} from "@haptic/core";
import { Actor, ActorComponent, TimelineClipObject, type EngineObject } from "@haptic/object-model";
import { applyTweenTransform } from "./tween-transforms";

/** What Timeline playback needs from the running game. */
export interface TimelineRuntimeHost {
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

  /** Creates the clip objects of a Scene or Scene Layer copy that just loaded. */
  register(owner: EngineObject, clips: readonly SerializedTimelineClip[] | undefined): void {
    if (!clips?.length) return;
    this.remove(owner);
    this.owners.set(owner, new Map(clips.map((clip) => [clip.id, new TimelineClipObject(clip, owner)])));
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
    const clip = this.owners.get(owner)?.get(clipId);
    return clip && !clip.destroyed ? clip : null;
  }

  /** Every clip of every loaded copy. */
  clips(): TimelineClipObject[] {
    return [...this.owners.values()].flatMap((clips) => [...clips.values()]);
  }

  /** One tick: Auto Play starts, playing clips move on and apply their values. */
  advance(dt: number, canRun: (owner: EngineObject) => boolean): void {
    for (const [owner, clips] of [...this.owners]) {
      if (owner.destroyed) {
        this.remove(owner);
        continue;
      }
      if (!canRun(owner)) continue;
      for (const clip of clips.values()) {
        if (!clip.started && clip.clip.autoPlay) this.play(clip);
        if (!clip.playback.playing) continue;
        const result = advanceTimelinePlayback(clip.playback, clip.clip, dt);
        clip.playback = result.state;
        this.apply(clip);
        if (result.finished && clip.clip.whenFinished === "restore") this.restoreValues(clip);
      }
    }
  }

  play(clip: TimelineClipObject, reverse = false): void {
    if (clip.destroyed) return;
    this.captureRestore(clip);
    clip.started = true;
    const playback = clip.playback;
    const direction = reverse ? -1 : 1;
    // Playing Once again from its end starts over.
    const atEnd = reverse ? playback.time <= 0 : playback.time >= clip.clip.length;
    const time = clip.clip.loopMode === "once" && atEnd ? (reverse ? clip.clip.length : 0) : playback.time;
    clip.playback = { ...playback, time, direction, playing: true };
    this.apply(clip);
  }

  pause(clip: TimelineClipObject): void {
    clip.playback = { ...clip.playback, playing: false };
  }

  /** Stops and returns to the start. */
  stop(clip: TimelineClipObject): void {
    clip.started = true;
    clip.playback = { ...clip.playback, playing: false, time: 0, direction: 1 };
    this.apply(clip);
  }

  setTime(clip: TimelineClipObject, time: number): void {
    if (!Number.isFinite(time)) return;
    this.captureRestore(clip);
    clip.playback = { ...clip.playback, time: Math.min(clip.clip.length, Math.max(0, time)) };
    this.apply(clip);
  }

  setPlayRate(clip: TimelineClipObject, rate: number): void {
    if (Number.isFinite(rate)) clip.playback = { ...clip.playback, rate: Math.max(0, rate) };
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

  /** The animated properties' values before the clip first plays, for When Finished: Restore. */
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

  private restoreValues(clip: TimelineClipObject): void {
    for (const restore of clip.restore?.values() ?? []) restore();
  }
}

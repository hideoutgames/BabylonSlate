import {
  TIMELINE_CLIP_ASSET_CLIP_ID,
  advanceTimelinePlayback,
  evaluateTimelineTrack,
  multiplyQuats,
  quatRotateVector,
  rotatorToQuat,
  timelineClipOfAsset,
  timelineEventKeysInSweeps,
  parseTimelineLoopMode,
  timelineStoredValue,
  type SerializedTimelineClip,
  type TimelineClipAssetCatalogEntry,
  type TimelineLoopMode,
  type TimelineSweep,
  type TimelinePropertyTrack,
} from "@haptic/core";
import {
  Actor,
  ActorComponent,
  TimelineClipInstance,
  TimelineClipObject,
  TimelineObject,
  timelineClipClassId,
  timelineProxyAccepts,
  timelineRefiredDispatcherName,
  type EngineObject,
  type TimelineProxyBinding,
} from "@haptic/object-model";
import { defaultValueForMember, jsIdent } from "@haptic/scripting";
import { copyTransform } from "./actor-world-transform";
import { applyTweenTransform } from "./tween-transforms";

/** What Timeline playback needs from the running game. */
export interface TimelineRuntimeHost {
  /** The clips an owner's document authored (the main Scene's or a Scene Layer's), and that document's guid. */
  clipsFor(owner: EngineObject): { documentGuid: string; clips: readonly SerializedTimelineClip[] } | undefined;
  /** Registers a clip class (`TimelineClip:<document>:<clip>`, parent `TimelineClip`) before its object exists. */
  ensureClipClass(classId: string): void;
  /** Registers a Timeline Asset's class (`Timeline:<guid>`, parent `Timeline`) before its object exists. */
  ensureTimelineClass(classId: string): void;
  /** Runs the listeners bound to `owner`'s dispatcher `name` (its runtime identifier). */
  fireDispatcher(owner: EngineObject, name: string, values: readonly unknown[]): void;
  /** A clip or Timeline object ended: its bindings and latent work go. */
  release(object: EngineObject): void;
  /** The live actor an owner placed under an authored actor id, per Scene or Scene Layer copy. */
  ownedActor(owner: EngineObject, actorId: string): Actor | null;
  findActor(guid: string): Actor | null | undefined;
  component(actor: Actor, componentId: string): ActorComponent | null;
  teleportActor(actor: Actor): void;
  refreshComponent(component: ActorComponent, property: string): void;
  /** A 2D or 3D Timeline Clip asset the game packed, for Create. */
  clipAsset(guid: string): TimelineClipAssetCatalogEntry | undefined;
  /** Puts a clip asset instance under reference-based lifetime. */
  register(object: EngineObject): void;
  /** An Output Log warning. */
  warn(message: string): void;
}

/** What one object track writes to: an actor, or a Component proxy's component, and the proxy's binding. */
type TrackTarget = { object: Actor | ActorComponent; binding?: TimelineProxyBinding };

const CHANNEL = { location: "position", rotation: "rotation", scale: "scale" } as const;

/**
 * Plays the Timeline Clips of every loaded Scene and Scene Layer copy, and
 * the instances scripts create of 2D and 3D Timeline Clip assets. Each copy
 * gets its own Timeline Clip objects when it loads; they end with it. An
 * instance lives while a reference reaches it or while it plays. Playing
 * clips advance once per tick, before actors tick, and write their tracks'
 * values to the animated actors (an instance: to its proxies' bound objects)
 * through the same paths tweens use.
 */
export class TimelineRuntime {
  private readonly host: TimelineRuntimeHost;
  private readonly owners = new Map<EngineObject, Map<string, TimelineClipObject>>();
  /** One Timeline object per Timeline Asset for the session, made on first use. */
  private readonly timelines = new Map<string, TimelineObject>();
  /** Live clip asset instances, in creation order. */
  private readonly instances = new Set<TimelineClipInstance>();
  private instanceCount = 0;

  constructor(host: TimelineRuntimeHost) {
    this.host = host;
  }

  /** Creates a Scene or Scene Layer copy's clip objects the first time they are needed. */
  private ensure(owner: EngineObject): Map<string, TimelineClipObject> | undefined {
    if (owner.destroyed) return undefined;
    let clips = this.owners.get(owner);
    if (!clips) {
      const document = this.host.clipsFor(owner);
      clips = new Map((document?.clips ?? []).map((clip) => {
        const classId = timelineClipClassId(document!.documentGuid, clip.id);
        this.host.ensureClipClass(classId);
        return [clip.id, new TimelineClipObject(clip, owner, classId)];
      }));
      this.owners.set(owner, clips);
    }
    return clips;
  }

  /** Ends the clips of a copy that unloaded; references to them read as empty. */
  remove(owner: EngineObject): void {
    const clips = this.owners.get(owner);
    if (!clips) return;
    this.owners.delete(owner);
    for (const clip of clips.values()) {
      clip.destroyed = true;
      this.host.release(clip);
    }
  }

  /** Ends every clip, instance and Timeline object: Play stopped. */
  reset(): void {
    for (const owner of [...this.owners.keys()]) this.remove(owner);
    for (const instance of [...this.instances]) {
      instance.destroyed = true;
      this.host.release(instance);
    }
    this.instances.clear();
    for (const timeline of this.timelines.values()) {
      timeline.destroyed = true;
      this.host.release(timeline);
    }
    this.timelines.clear();
  }

  /** A Timeline Asset's Timeline object, made the first time a script asks for it. */
  timeline(assetGuid: unknown): TimelineObject | null {
    const guid = typeof assetGuid === "string" ? assetGuid.trim() : "";
    if (!guid) return null;
    let timeline = this.timelines.get(guid);
    if (!timeline) {
      timeline = new TimelineObject(guid);
      this.host.ensureTimelineClass(timeline.classId);
      this.timelines.set(guid, timeline);
    }
    return timeline;
  }

  /**
   * The asset's clips in the live `owners` (the main Scene, then Scene Layer
   * copies in creation order), optionally only one document's clip.
   */
  timelineClips(timeline: TimelineObject, owners: Iterable<EngineObject>, only?: { documentGuid: string; clipId: string }): TimelineClipObject[] {
    const found: TimelineClipObject[] = [];
    const classId = only ? timelineClipClassId(only.documentGuid, only.clipId) : undefined;
    for (const owner of owners) {
      for (const clip of this.ensure(owner)?.values() ?? []) {
        if (clip.destroyed || clip.clip.timelineAsset !== timeline.assetGuid) continue;
        if (classId && clip.classId !== classId) continue;
        found.push(clip);
        if (classId) return found;
      }
    }
    return found;
  }

  /**
   * A new instance of the clip asset `assetGuid` on its Timeline, with each
   * object in `inputs` (by proxy id) bound Relative. None when the asset is
   * not packed or belongs to another Timeline Asset.
   */
  createInstance(timeline: TimelineObject, assetGuid: string, inputs: Readonly<Record<string, unknown>> = {}): TimelineClipInstance | null {
    if (timeline.destroyed) return null;
    const entry = this.host.clipAsset(assetGuid);
    if (!entry || entry.payload.timelineAsset !== timeline.assetGuid) return null;
    const classId = timelineClipClassId(entry.guid, TIMELINE_CLIP_ASSET_CLIP_ID);
    this.host.ensureClipClass(classId);
    const proxies = new Map(entry.payload.proxies.map((proxy) => [proxy.id, { name: proxy.name, represents: proxy.represents }]));
    this.instanceCount += 1;
    const instance = new TimelineClipInstance(timelineClipOfAsset(entry.payload, entry.name), timeline, classId, entry.guid, proxies,
      `${entry.guid}:timeline-clip-instance:${this.instanceCount}`);
    for (const [proxyId, object] of Object.entries(inputs)) {
      if (object !== null && object !== undefined) this.bind(instance, proxyId, object, false);
    }
    this.instances.add(instance);
    this.host.register(instance);
    return instance;
  }

  /**
   * Binds a proxy to `object`, which must be a live actor for an Actor proxy
   * or a component for a Component proxy. Relative keys offset the transform
   * it has now; the next tick applies it. False when it cannot stand in.
   */
  bind(instance: TimelineClipInstance, proxyId: string, object: unknown, absolute: boolean): boolean {
    const proxy = instance.proxies.get(proxyId);
    if (instance.destroyed || !proxy || !timelineProxyAccepts(proxy.represents, object) || object.destroyed) return false;
    instance.bindings.set(proxyId, { target: object, absolute, base: copyTransform(object.transform) });
    return true;
  }

  /** Clears a proxy: its tracks stop applying. */
  unbind(instance: TimelineClipInstance, proxyId: string): void {
    instance.bindings.delete(proxyId);
  }

  /** Clears every proxy of the instance. */
  unbindAll(instance: TimelineClipInstance): void {
    instance.bindings.clear();
  }

  /** The object bound to a proxy, or none (a destroyed one reads as none). */
  bound(instance: TimelineClipInstance, proxyId: string): Actor | ActorComponent | null {
    const binding = instance.bindings.get(proxyId);
    return binding && !binding.target.destroyed ? binding.target : null;
  }

  /** Keeps playing instances alive: hands each to the collector's root visitor. */
  forEachPlayingInstance(visit: (instance: TimelineClipInstance) => void): void {
    for (const instance of this.instances) if (!instance.destroyed && instance.playback.playing) visit(instance);
  }

  /** An instance the collector destroyed: it stops advancing. */
  forget(object: EngineObject): void {
    if (object instanceof TimelineClipInstance) this.instances.delete(object);
  }

  /** Live clip asset instances, in creation order. */
  liveInstances(): TimelineClipInstance[] {
    return [...this.instances].filter((instance) => !instance.destroyed);
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
        this.step(clip, dt);
      }
    }
    // Instances never Auto Play; one created this tick by an actor waits for the next.
    for (const instance of [...this.instances]) {
      if (instance.destroyed) this.instances.delete(instance);
      else if (canRun(instance.owner)) this.step(instance, dt);
    }
  }

  private step(clip: TimelineClipObject, dt: number): void {
    if (!clip.playback.playing) return;
    const result = advanceTimelinePlayback(clip.playback, clip.clip.length, dt);
    clip.playback = result.state;
    this.apply(clip);
    this.fireStep(clip, result.sweeps, result.cycles, result.finished);
  }

  /** Plays forwards, or in reverse, from where the clip is; a Once clip at the end it plays towards starts over. */
  play(clip: TimelineClipObject, reverse = false): void {
    if (clip.destroyed) return;
    clip.generation += 1;
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
    clip.generation += 1;
    clip.playback = { ...clip.playback, playing: false };
  }

  /** Stops and returns to the start, or to the end while playing in reverse. */
  stop(clip: TimelineClipObject): void {
    if (clip.destroyed) return;
    clip.generation += 1;
    clip.started = true;
    const time = clip.playback.direction < 0 ? clip.clip.length : 0;
    clip.playback = { ...clip.playback, playing: false, time };
    this.apply(clip);
  }

  /**
   * Moves to `time` and applies the values there. With `fireEvents`, the event
   * keys passed over fire in that direction, the start included.
   */
  setPosition(clip: TimelineClipObject, time: number, fireEvents = false): void {
    if (clip.destroyed || !Number.isFinite(time)) return;
    this.captureRestore(clip);
    clip.generation += 1;
    const from = clip.playback.time;
    const to = Math.min(clip.clip.length, Math.max(0, time));
    clip.playback = { ...clip.playback, time: to };
    this.apply(clip);
    if (fireEvents && to !== from) this.fireStep(clip, [{ from, to, includeFrom: true, includeTo: false }], 0, false);
  }

  /** Never below 0: Reverse plays backwards. */
  setPlayRate(clip: TimelineClipObject, rate: number): void {
    if (Number.isFinite(rate)) clip.playback = { ...clip.playback, rate: Math.max(0, rate) };
  }

  setLoopMode(clip: TimelineClipObject, loopMode: TimelineLoopMode): void {
    clip.playback = { ...clip.playback, loopMode };
  }

  /**
   * The step's event keys in playback order, then On Looped per wrap or turn,
   * then for a Once clip at its end When Finished and On Finished. A listener
   * that changes the clip's playback ends the rest of the step's firing.
   */
  private fireStep(clip: TimelineClipObject, sweeps: readonly TimelineSweep[], cycles: number, finished: boolean): void {
    const generation = clip.generation;
    const live = () => !clip.destroyed && clip.generation === generation;
    for (const { track, key } of timelineEventKeysInSweeps(clip.clip.eventTracks, sweeps)) {
      const values = track.inputs.map((input) =>
        Object.hasOwn(key.values, input.name) ? structuredClone(key.values[input.name]) : defaultValueForMember(input.typeId, input.typeClassId));
      if (!this.fire(clip, track.name, values, live)) return;
    }
    for (let cycle = 0; cycle < cycles; cycle += 1) {
      if (!this.fire(clip, "On Looped", [], live)) return;
    }
    if (!finished) return;
    if (clip.clip.whenFinished === "restore") this.restoreValues(clip);
    this.fire(clip, "On Finished", [], live);
  }

  /**
   * Fires a clip's dispatcher, then its Timeline's `<Event> (<Clip>)` with
   * the clip as the last input. A Timeline no script asked for has no
   * listeners. False once a listener changed the clip's playback.
   */
  private fire(clip: TimelineClipObject, event: string, values: readonly unknown[], live: () => boolean): boolean {
    this.host.fireDispatcher(clip, jsIdent(event), values);
    if (!live()) return false;
    const timeline = clip.clip.timelineAsset ? this.timelines.get(clip.clip.timelineAsset) : undefined;
    if (!timeline || timeline.destroyed) return true;
    // Its listeners get their own copies of the key's values.
    const refired = [...values.map((value) => structuredClone(value)), clip];
    this.host.fireDispatcher(timeline, jsIdent(timelineRefiredDispatcherName(event, clip.clip.name)), refired);
    return live();
  }

  /** Writes every unmuted track's value at the clip's time to its actor or bound object. */
  apply(clip: TimelineClipObject): void {
    if (clip.destroyed) return;
    for (const object of clip.clip.objects) {
      const target = this.trackTarget(clip, object.actorId, true);
      if (!target) continue;
      for (const track of object.tracks) {
        if (track.muted) continue;
        const value = evaluateTimelineTrack(track, clip.playback.time);
        if (value !== undefined) this.write(target, object.actorId, track, value);
      }
    }
  }

  /**
   * The object an object track animates: a scene clip's placed actor, or an
   * instance's bound object (a destroyed one unbinds itself; an unbound
   * proxy is reported once per Play when `report` is set).
   */
  private trackTarget(clip: TimelineClipObject, actorId: string, report: boolean): TrackTarget | null {
    if (!(clip instanceof TimelineClipInstance)) {
      const actor = this.host.ownedActor(clip.owner, actorId);
      return actor && !actor.destroyed ? { object: actor } : null;
    }
    const binding = clip.bindings.get(actorId);
    if (binding && (binding.target.destroyed || (binding.target instanceof ActorComponent && binding.target.owner?.destroyed))) {
      clip.bindings.delete(actorId);
    } else if (binding) {
      return { object: binding.target, binding };
    }
    if (report && !clip.unboundWarned.has(actorId)) {
      clip.unboundWarned.add(actorId);
      const proxy = clip.proxies.get(actorId);
      if (proxy) this.host.warn(`${clip.clip.name}: the ${proxy.name} proxy is not bound.`);
    }
    return null;
  }

  private write({ object, binding }: TrackTarget, actorId: string, track: TimelinePropertyTrack, value: unknown): void {
    const { target } = track;
    if (target.kind === "transform") {
      const channel = CHANNEL[target.property as keyof typeof CHANNEL];
      if (channel && this.writeTransform(object, channel, value, binding)) {
        if (object instanceof Actor) this.host.teleportActor(object);
        else this.host.refreshComponent(object, "transform");
      }
      return;
    }
    if (target.kind === "visible") {
      object.setVariable("visible", value === true);
      if (object instanceof ActorComponent) this.host.refreshComponent(object, "visible");
      return;
    }
    if (target.kind === "variable") {
      object.setVariable(target.property, timelineStoredValue(track, value, object.getVariable(target.property), object instanceof ActorComponent));
      if (object instanceof ActorComponent) this.host.refreshComponent(object, target.property);
      return;
    }
    const component = this.trackComponent(object, actorId, target.componentId);
    if (!component) return;
    component.setVariable(target.property, timelineStoredValue(track, value, component.getVariable(target.property), true));
    this.host.refreshComponent(component, target.property);
  }

  /** A component track's component: on an actor by its authored id, or a Component proxy's own (its id is the proxy's). */
  private trackComponent(object: Actor | ActorComponent, actorId: string, componentId: string | undefined): ActorComponent | null {
    if (!componentId) return null;
    if (object instanceof ActorComponent) return componentId === actorId ? object : null;
    return this.host.component(object, componentId);
  }

  /**
   * A transform key. Scene clips and Absolute bindings set it (an Absolute
   * actor in world space); a Relative binding offsets the transform it had
   * when bound: location turned by its rotation, rotation after it, scale
   * multiplied.
   */
  private writeTransform(object: Actor | ActorComponent, channel: (typeof CHANNEL)[keyof typeof CHANNEL], value: unknown, binding: TimelineProxyBinding | undefined): boolean {
    const findActor = (id: string) => this.host.findActor(id) ?? undefined;
    if (!binding || binding.absolute) {
      return applyTweenTransform(object, channel, value, binding && object instanceof Actor ? "world" : "local", findActor);
    }
    const base = binding.base;
    const next = copyTransform(object.transform);
    const offset = value as Record<string, unknown>;
    if (channel === "position") {
      const turned = quatRotateVector(base.rotation, offset as { x: number; y: number; z: number });
      next.position = { x: base.position.x + turned.x, y: base.position.y + turned.y, z: base.position.z + turned.z };
    } else if (channel === "rotation") {
      next.rotation = multiplyQuats(base.rotation, rotatorToQuat(offset as { pitch: number; yaw: number; roll: number }));
    } else {
      const scale = offset as { x: number; y: number; z: number };
      next.scale = { x: base.scale.x * scale.x, y: base.scale.y * scale.y, z: base.scale.z * scale.z };
    }
    return applyTweenTransform(object, "transform", next, "local", findActor);
  }

  /** The animated properties' values when Play starts, for When Finished: Restore State. */
  private captureRestore(clip: TimelineClipObject): void {
    if (clip.restore || clip.clip.whenFinished !== "restore") return;
    const restore = new Map<string, () => void>();
    for (const object of clip.clip.objects) {
      const bound = this.trackTarget(clip, object.actorId, false);
      if (!bound) continue;
      const owner = bound.object;
      for (const track of object.tracks) {
        const { target } = track;
        const key = `${object.actorId}:${target.kind}:${target.componentId ?? ""}:${target.property}`;
        if (restore.has(key)) continue;
        if (target.kind === "transform") {
          const channel = CHANNEL[target.property as keyof typeof CHANNEL];
          if (!channel) continue;
          const saved = structuredClone(owner.transform[channel]);
          restore.set(key, () => {
            if (owner.destroyed) return;
            Object.assign(owner.transform[channel], saved);
            if (owner instanceof Actor) this.host.teleportActor(owner);
            else this.host.refreshComponent(owner, "transform");
          });
          continue;
        }
        const component = target.kind === "component" ? this.trackComponent(owner, object.actorId, target.componentId) : owner;
        if (!component) continue;
        const name = target.kind === "visible" ? "visible" : target.property;
        const saved = structuredClone(component.getVariable(name));
        restore.set(key, () => {
          if (component.destroyed) return;
          component.setVariable(name, structuredClone(saved));
          if (component instanceof ActorComponent) this.host.refreshComponent(component, name);
        });
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
    case "setPosition": timelines.setPosition(clip, Number(args.time), args.fireEvents === true); return;
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

/** Runs a Timeline Proxy node (`timelineProxy.bind*`, `unbind`, `unbindAll`) on a clip asset instance. */
export function timelineProxyControl(
  timelines: TimelineRuntime,
  instance: TimelineClipInstance,
  action: string,
  proxyId: string,
  args: Record<string, unknown>,
): void {
  switch (action) {
    case "bind": timelines.bind(instance, proxyId, args.object, args.absolute === true); return;
    case "unbind": timelines.unbind(instance, proxyId); return;
    case "unbindAll": timelines.unbindAll(instance); return;
  }
}

import {
  countText2DRevealCharacters, parseText2DProperties, text2DAppearDuration, text2DAppearSoundPlan,
  type Text2DAppearSoundPlan,
} from "@haptic/core";
import type { Actor, ActorComponent, World } from "@haptic/object-model";
import type { RuntimeSubsystem } from "./runtime-subsystems";
import { Text2DLetterScripts } from "./text2d-letter-scripts";
import { componentOwners } from "./world-component-index";

/** A forward reveal's sound clock in timeline seconds; it outlives the reveal by the sound offset. */
type AppearSound = { plan: Text2DAppearSoundPlan; clock: number; looping: boolean };
type AppearState = { progress: number; direction: -1 | 0 | 1; duration: number; sound: AppearSound | null };
export type Text2DAppearOperation = "triggerAppear" | "play" | "playReverse";
export type Text2DAppearSoundEvent =
  | { type: "play"; component: ActorComponent; assetGuid: string; loop: boolean; voiceId?: string }
  | { type: "stop"; voiceId: string };

const loopVoiceId = (component: ActorComponent) => `${component.guid}:appearSound`;

/** Simulation-owned reveal timing; renderers only consume its normalized position. */
export class Text2DAppearRuntime implements RuntimeSubsystem {
  private readonly states = new WeakMap<ActorComponent, AppearState>();
  private readonly dirty = new Set<ActorComponent>();
  private sounds: Text2DAppearSoundEvent[] = [];
  /** Scripted Appear Modes and Decorator Effects, which follow the reveal this runtime owns. */
  readonly letters = new Text2DLetterScripts();

  progress(component: ActorComponent): number {
    return this.state(component).progress;
  }

  /** The scripted letter poses the renderer holds; undefined while every letter is at rest. */
  letterPoses(component: ActorComponent): number[] | undefined {
    return this.letters.poses(component);
  }

  refresh(component: ActorComponent): void {
    const state = this.state(component);
    state.duration = this.duration(component);
    this.finishInstant(component, state);
    if (state.sound) {
      const clock = state.direction === 1 ? state.progress * state.duration : state.sound.clock;
      this.setSound(component, state, clock);
    }
  }

  execute(component: ActorComponent, operation: Text2DAppearOperation): void {
    if (component.classId !== "2DRichTextComponent" || component.destroyed || !component.owner || component.owner.destroyed) return;
    const state = this.state(component);
    if (operation === "triggerAppear") state.progress = 0;
    state.direction = operation === "playReverse" ? -1 : 1;
    state.duration = this.duration(component);
    if (state.direction === 1) this.startSound(component, state);
    else this.stopSound(component, state);
    this.finishInstant(component, state);
    this.dirty.add(component);
  }

  advance(world: World, deltaSeconds: number, canTick: (actor: Actor) => boolean): void {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;
    for (const actor of componentOwners(world, "2DRichTextComponent")) {
      if (actor.destroyed || !canTick(actor)) continue;
      for (const component of actor.components) {
        if (component.classId !== "2DRichTextComponent" || component.destroyed) continue;
        const state = this.state(component);
        if (state.sound) this.advanceSound(component, state, deltaSeconds);
        if (state.direction) {
          const target = state.direction === 1 ? 1 : 0;
          const step = state.duration > 0 ? deltaSeconds / state.duration : 1;
          const remaining = Math.abs(target - state.progress);
          state.progress = step >= remaining - Number.EPSILON * 4
            ? target : state.progress + state.direction * step;
          if (state.progress === target) state.direction = 0;
          this.dirty.add(component);
        }
        this.letters.advance(component, state.progress, deltaSeconds);
      }
    }
  }

  flush(
    send: (component: ActorComponent, progress: number) => void,
    sound?: (event: Text2DAppearSoundEvent) => void,
    letterPoses?: (component: ActorComponent, poses: number[]) => void,
  ): void {
    for (const component of this.dirty) {
      if (!component.destroyed && component.owner && !component.owner.destroyed) send(component, this.state(component).progress);
    }
    this.dirty.clear();
    const sounds = this.sounds;
    this.sounds = [];
    for (const event of sounds) {
      if (event.type === "stop" || (!event.component.destroyed && event.component.owner && !event.component.owner.destroyed)) sound?.(event);
    }
    if (letterPoses) this.letters.flush(letterPoses);
  }

  remove(component: ActorComponent): void {
    const state = this.states.get(component);
    if (state) this.stopSound(component, state);
    this.letters.remove(component);
    this.states.delete(component);
    this.dirty.delete(component);
  }

  /** A released slot's owner forgets its reveal state. */
  releaseSlot(_slotId: number, owner: Actor | undefined): void {
    if (owner) for (const component of owner.components) this.remove(component);
  }

  private state(component: ActorComponent): AppearState {
    let state = this.states.get(component);
    if (!state) {
      const properties = parseText2DProperties(Object.fromEntries(component.variables), { rich: true });
      state = { progress: properties.appearStart === "revealed" ? 1 : 0,
        direction: properties.appearStart === "play" ? 1 : 0, duration: this.duration(component), sound: null };
      this.states.set(component, state);
      if (state.direction === 1) this.startSound(component, state);
      this.finishInstant(component, state);
    }
    return state;
  }

  private duration(component: ActorComponent): number {
    const properties = parseText2DProperties(Object.fromEntries(component.variables), { rich: true });
    return text2DAppearDuration(countText2DRevealCharacters(properties), properties);
  }

  /** A forward play sounds from its current position; earlier cues are not replayed. */
  private startSound(component: ActorComponent, state: AppearState): void {
    this.stopSound(component, state);
    if (state.progress < 1) this.setSound(component, state, state.progress * state.duration);
  }

  private setSound(component: ActorComponent, state: AppearState, clock: number): void {
    const plan = text2DAppearSoundPlan(parseText2DProperties(Object.fromEntries(component.variables), { rich: true }));
    const looping = state.sound?.looping === true;
    if (looping && !(plan?.loop && plan.assetGuid === state.sound?.plan.assetGuid)) {
      this.stopSound(component, state);
    }
    state.sound = plan ? { plan, clock, looping: state.sound?.looping === true } : null;
  }

  private stopSound(component: ActorComponent, state: AppearState): void {
    if (state.sound?.looping) this.sounds.push({ type: "stop", voiceId: loopVoiceId(component) });
    state.sound = null;
  }

  private advanceSound(component: ActorComponent, state: AppearState, deltaSeconds: number): void {
    const sound = state.sound!;
    const from = sound.clock, to = from + deltaSeconds;
    sound.clock = to;
    const { plan } = sound;
    if (plan.loop) {
      if (to >= plan.loop.stop) this.stopSound(component, state);
      else if (!sound.looping && to > plan.loop.start) {
        sound.looping = true;
        this.sounds.push({ type: "play", component, assetGuid: plan.assetGuid, loop: true, voiceId: loopVoiceId(component) });
      }
      return;
    }
    for (const time of plan.times) {
      if (time >= from && time < to) this.sounds.push({ type: "play", component, assetGuid: plan.assetGuid, loop: false });
    }
    if (to > plan.times[plan.times.length - 1]!) state.sound = null;
  }

  private finishInstant(component: ActorComponent, state: AppearState): void {
    if (state.direction && state.duration === 0) {
      state.progress = state.direction === 1 ? 1 : 0;
      state.direction = 0;
      this.dirty.add(component);
    }
  }
}

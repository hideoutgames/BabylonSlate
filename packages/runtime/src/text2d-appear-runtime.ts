import {
  countText2DRevealCharacters, parseText2DProperties, text2DAppearDuration, text2DAppearSoundPlan, text2DLetterStart,
  text2DShownLetters, type Text2DAppearSoundPlan, type Text2DProperties, type Text2DShownLetter,
} from "@haptic/core";
import {
  RICH_TEXT_APPEAR_FINISHED_EVENT, RICH_TEXT_DISAPPEAR_FINISHED_EVENT, RICH_TEXT_LETTER_SHOWN_EVENT,
  type Actor, type ActorComponent, type World,
} from "@haptic/object-model";
import { RichTextDecorators, type RichTextDecorator } from "./rich-text-decorators";
import type { RuntimeSubsystem } from "./runtime-subsystems";
import { Text2DLetterScripts, type Text2DLetterScriptsHost } from "./text2d-letter-scripts";
import { componentOwners } from "./world-component-index";

/** What the reveal needs from the session: letter scripting, and the owner's component events. */
export interface Text2DAppearHost extends Text2DLetterScriptsHost {
  /** Whether `component`'s owner handles component event `event` (an export name) for it. */
  handlesComponentEvent(component: ActorComponent, event: string): boolean;
  fireComponentEvent(component: ActorComponent, event: string, args: Record<string, unknown>): void;
}

/** A forward reveal's sound clock in timeline seconds; it outlives the reveal by the sound offset. */
type AppearSound = { plan: Text2DAppearSoundPlan; clock: number; looping: boolean };
/**
 * A forward reveal's On Letter Shown schedule, only while the owner handles it: `letters` ascend by start time and
 * those from `cursor` on are still to show; `clock` is the reveal position in timeline seconds.
 */
type ShownSchedule = { text: string; interval: number; letters: readonly Text2DShownLetter[]; cursor: number; clock: number };
type QueuedEvent = { event: string; args: Record<string, unknown> };
type AppearState = {
  progress: number; direction: -1 | 0 | 1; duration: number; sound: AppearSound | null;
  shown: ShownSchedule | null;
  /** Component events that occurred and run at this component's next reveal step, in order; null until the first. */
  events: QueuedEvent[] | null;
};
export type Text2DAppearOperation = "triggerAppear" | "play" | "playReverse";
export type Text2DAppearSoundEvent =
  | { type: "play"; component: ActorComponent; assetGuid: string; loop: boolean; voiceId?: string }
  | { type: "stop"; voiceId: string };

const loopVoiceId = (component: ActorComponent) => `${component.guid}:appearSound`;

/** Simulation-owned reveal timing; renderers only consume its normalized position. */
export class Text2DAppearRuntime implements RuntimeSubsystem {
  private host: Text2DAppearHost | null = null;
  private readonly states = new WeakMap<ActorComponent, AppearState>();
  private readonly idleComponents = new WeakMap<ActorComponent, number>();
  private readonly dirty = new Set<ActorComponent>();
  private sounds: Text2DAppearSoundEvent[] = [];
  /** Scripted Appear Modes and Letter Effects, which follow the reveal this runtime owns. */
  readonly letters = new Text2DLetterScripts((component) => this.properties(component));
  /** The loaded Rich Text Decorators and the text each 2D Rich Text draws with their tags expanded. */
  private readonly decorators = new RichTextDecorators({
    withTag: (self, values, run) => this.letters.withTag(self, values, run),
  });

  bind(host: Text2DAppearHost): void {
    this.host = host;
    this.letters.bind(host);
  }

  progress(component: ActorComponent): number {
    return this.state(component).progress;
  }

  /**
   * The text a 2D Rich Text draws: its authored text with the custom tags of the loaded Rich Text Decorators expanded.
   * The authored text itself while no Decorator is loaded or it has no custom tag.
   */
  displayText(component: ActorComponent): unknown {
    const text = component.getVariable("text");
    return this.decorators.active ? this.decorators.text(component, text) : text;
  }

  /** A 2D Rich Text's properties as drawn (`displayText`): what its reveal, sound and letter scripts follow. */
  properties(component: ActorComponent): Text2DProperties {
    const variables = Object.fromEntries(component.variables);
    if (this.decorators.active) variables.text = this.decorators.text(component, variables.text);
    return parseText2DProperties(variables, { rich: true });
  }

  /**
   * A script load's Rich Text Decorators replace the previous ones and every live 2D Rich Text of `world` is expanded
   * again; returns those whose drawn text changed, which their owner sends again.
   */
  loadDecorators(world: World, decorators: ReadonlyMap<string, RichTextDecorator>): ActorComponent[] {
    const changed = this.decorators.load(decorators, this.richTexts(world));
    for (const component of changed) this.textChanged(component);
    return changed;
  }

  /** Refresh Text: runs `component`'s Decorators again; whether its drawn text changed, so its owner sends it again. */
  refreshText(component: ActorComponent): boolean {
    if (!this.decorators.refresh(component)) return false;
    this.textChanged(component);
    return true;
  }

  /** The scripted letter poses the renderer holds; undefined while every letter is at rest. */
  letterPoses(component: ActorComponent): Float32Array | undefined {
    return this.letters.poses(component);
  }

  refresh(component: ActorComponent): void {
    this.idleComponents.delete(component);
    const state = this.state(component);
    state.duration = this.duration(component);
    if (state.shown) this.refreshShown(component, state);
    this.finishInstant(component, state);
    if (state.sound) {
      const clock = state.direction === 1 ? state.progress * state.duration : state.sound.clock;
      this.setSound(component, state, clock);
    }
  }

  execute(component: ActorComponent, operation: Text2DAppearOperation): void {
    if (component.classId !== "2DRichTextComponent" || component.destroyed || !component.owner || component.owner.destroyed) return;
    this.idleComponents.delete(component);
    const state = this.state(component);
    if (operation === "triggerAppear") state.progress = 0;
    state.direction = operation === "playReverse" ? -1 : 1;
    state.duration = this.duration(component);
    if (state.direction === 1) {
      this.startSound(component, state);
      this.startShown(component, state);
    } else {
      this.stopSound(component, state);
      state.shown = null;
    }
    this.finishInstant(component, state);
    this.dirty.add(component);
  }

  advance(world: World, deltaSeconds: number, canTick: (actor: Actor) => boolean): void {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;
    for (const actor of componentOwners(world, "2DRichTextComponent")) {
      if (actor.destroyed || !canTick(actor)) continue;
      for (const component of actor.components) {
        if (component.classId !== "2DRichTextComponent" || component.destroyed) continue;
        const rev = component.variablesRevision;
        if (this.idleComponents.get(component) === rev) continue;
        const state = this.state(component);
        if (state.sound) this.advanceSound(component, state, deltaSeconds);
        if (state.direction) {
          const target = state.direction === 1 ? 1 : 0;
          const step = state.duration > 0 ? deltaSeconds / state.duration : 1;
          const remaining = Math.abs(target - state.progress);
          state.progress = step >= remaining - Number.EPSILON * 4
            ? target : state.progress + state.direction * step;
          if (state.shown) this.advanceShown(state, deltaSeconds);
          if (state.progress === target) this.finish(component, state, remaining > 0);
          this.dirty.add(component);
        }
        this.letters.advance(component, state.progress, deltaSeconds);
        // After the reveal and the letter poses moved, so handlers read where the text is now.
        if (state.events?.length) this.dispatchEvents(component, state.events);
        if (state.direction === 0 && !state.sound && !state.events?.length && this.letters.isIdleAt(component, rev)) {
          this.idleComponents.set(component, rev);
        }
      }
    }
  }

  flush(
    send: (component: ActorComponent, progress: number) => void,
    sound?: (event: Text2DAppearSoundEvent) => void,
    letterPoses?: (component: ActorComponent, poses: Float32Array) => void,
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
    if (state) {
      this.stopSound(component, state);
      state.shown = null;
      state.events = null;
    }
    this.letters.remove(component);
    this.states.delete(component);
    this.idleComponents.delete(component);
    this.dirty.delete(component);
  }

  /** A released slot's owner forgets its reveal state. */
  releaseSlot(_slotId: number, owner: Actor | undefined): void {
    if (owner) for (const component of owner.components) this.remove(component);
  }

  /** The drawn text changed without a variable write: the letter scripts read it again (the reveal on `refresh`). */
  private textChanged(component: ActorComponent): void {
    this.idleComponents.delete(component);
    this.letters.invalidate(component);
  }

  private *richTexts(world: World): Iterable<ActorComponent> {
    for (const actor of componentOwners(world, "2DRichTextComponent")) {
      if (actor.destroyed) continue;
      for (const component of actor.components) {
        if (component.classId === "2DRichTextComponent" && !component.destroyed) yield component;
      }
    }
  }

  private state(component: ActorComponent): AppearState {
    let state = this.states.get(component);
    if (!state) {
      const properties = this.properties(component);
      const duration = text2DAppearDuration(countText2DRevealCharacters(properties), properties);
      state = { progress: properties.appearStart === "revealed" ? 1 : 0,
        direction: properties.appearStart === "play" ? 1 : 0, duration, sound: null,
        shown: null, events: null };
      this.states.set(component, state);
      // Play On Start is a forward play from hidden.
      if (state.direction === 1) {
        this.startSound(component, state);
        this.startShown(component, state, properties);
      }
      this.finishInstant(component, state);
    }
    return state;
  }

  private duration(component: ActorComponent): number {
    const properties = this.properties(component);
    return text2DAppearDuration(countText2DRevealCharacters(properties), properties);
  }

  /** A forward play sounds from its current position; earlier cues are not replayed. */
  private startSound(component: ActorComponent, state: AppearState): void {
    this.stopSound(component, state);
    if (state.progress < 1) this.setSound(component, state, state.progress * state.duration);
  }

  private setSound(component: ActorComponent, state: AppearState, clock: number): void {
    const plan = text2DAppearSoundPlan(this.properties(component));
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
      const target = state.direction === 1 ? 1 : 0;
      const moved = state.progress !== target;
      state.progress = target;
      this.finish(component, state, moved);
      this.dirty.add(component);
    }
  }

  /**
   * The reveal reached the end it was playing towards. The letters still to show have started; Appear or Disappear
   * Finished runs only when this play moved the reveal there.
   */
  private finish(component: ActorComponent, state: AppearState, moved: boolean): void {
    const forward = state.direction === 1;
    state.direction = 0;
    if (state.shown) this.showLetters(state, Number.POSITIVE_INFINITY);
    if (!moved) return;
    const event = forward ? RICH_TEXT_APPEAR_FINISHED_EVENT : RICH_TEXT_DISAPPEAR_FINISHED_EVENT;
    if (this.host?.handlesComponentEvent(component, event.exportName)) this.queue(state, event.exportName, {});
  }

  /** A forward play's On Letter Shown schedule from where the reveal is, when the owner handles it. */
  private startShown(component: ActorComponent, state: AppearState, properties?: Text2DProperties): void {
    state.shown = null;
    if (state.progress >= 1 || !this.host?.handlesComponentEvent(component, RICH_TEXT_LETTER_SHOWN_EVENT.exportName)) return;
    const parsed = properties ?? this.properties(component);
    const letters = text2DShownLetters(parsed);
    if (letters.length === 0) return;
    const clock = state.progress * state.duration;
    let cursor = 0;
    // Letters that started before a resumed reveal's position have been shown.
    while (cursor < letters.length && text2DLetterStart(letters[cursor]!.index, parsed) < clock) cursor += 1;
    state.shown = { text: parsed.text, interval: text2DLetterStart(1, parsed), letters, cursor, clock };
  }

  /** An edit during a forward reveal keeps its schedule unless the text or its letter timing changed. */
  private refreshShown(component: ActorComponent, state: AppearState): void {
    const shown = state.shown!;
    const properties = this.properties(component);
    if (properties.text === shown.text && text2DLetterStart(1, properties) === shown.interval && properties.appearModes.length > 0) {
      shown.clock = state.progress * state.duration;
    } else {
      this.startShown(component, state, properties);
    }
  }

  private advanceShown(state: AppearState, deltaSeconds: number): void {
    const shown = state.shown!;
    shown.clock += deltaSeconds;
    this.showLetters(state, shown.clock);
  }

  /** Queues On Letter Shown for each scheduled letter that starts before `clock`, in text order. */
  private showLetters(state: AppearState, clock: number): void {
    const shown = state.shown!;
    const { letters, interval } = shown;
    let cursor = shown.cursor;
    while (cursor < letters.length && letters[cursor]!.index * interval < clock) {
      const letter = letters[cursor++]!;
      this.queue(state, RICH_TEXT_LETTER_SHOWN_EVENT.exportName, { index: letter.index, character: letter.character });
    }
    shown.cursor = cursor;
    if (cursor >= letters.length) state.shown = null;
  }

  private queue(state: AppearState, event: string, args: Record<string, unknown>): void {
    (state.events ??= []).push({ event, args });
  }

  /**
   * Runs the events queued before this step, in the order they occurred. One a handler causes (an instant finish
   * of a Play it calls) waits for the next step, so handlers that restart the reveal cannot loop within a tick.
   */
  private dispatchEvents(component: ActorComponent, events: QueuedEvent[]): void {
    const count = events.length;
    for (let index = 0; index < count; index++) {
      const { event, args } = events[index]!;
      if (component.destroyed || !component.owner || component.owner.destroyed) break;
      this.host?.fireComponentEvent(component, event, args);
    }
    events.copyWithin(0, count);
    events.length -= count;
  }
}

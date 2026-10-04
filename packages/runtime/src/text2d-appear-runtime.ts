import { countText2DRevealCharacters, parseText2DProperties, text2DAppearDuration } from "@babylonslate/core";
import type { Actor, ActorComponent } from "@babylonslate/object-model";

type AppearState = { progress: number; direction: -1 | 0 | 1; duration: number };
export type Text2DAppearOperation = "triggerAppear" | "play" | "playReverse";

/** Simulation-owned reveal timing; renderers only consume its normalized position. */
export class Text2DAppearRuntime {
  private readonly states = new WeakMap<ActorComponent, AppearState>();
  private readonly dirty = new Set<ActorComponent>();

  progress(component: ActorComponent): number {
    return this.state(component).progress;
  }

  refresh(component: ActorComponent): void {
    const state = this.state(component);
    state.duration = this.duration(component);
    this.finishInstant(component, state);
  }

  execute(component: ActorComponent, operation: Text2DAppearOperation): void {
    if (component.classId !== "2DRichTextComponent" || component.destroyed || !component.owner || component.owner.destroyed) return;
    const state = this.state(component);
    if (operation === "triggerAppear") state.progress = 0;
    state.direction = operation === "playReverse" ? -1 : 1;
    state.duration = this.duration(component);
    this.finishInstant(component, state);
    this.dirty.add(component);
  }

  advance(actors: readonly Actor[], deltaSeconds: number, canTick: (actor: Actor) => boolean): void {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;
    for (const actor of actors) {
      if (actor.destroyed || !canTick(actor)) continue;
      for (const component of actor.components) {
        if (component.classId !== "2DRichTextComponent" || component.destroyed) continue;
        const state = this.state(component);
        if (!state.direction) continue;
        const target = state.direction === 1 ? 1 : 0;
        const step = state.duration > 0 ? deltaSeconds / state.duration : 1;
        const remaining = Math.abs(target - state.progress);
        state.progress = step >= remaining - Number.EPSILON * 4
          ? target : state.progress + state.direction * step;
        if (state.progress === target) state.direction = 0;
        this.dirty.add(component);
      }
    }
  }

  flush(send: (component: ActorComponent, progress: number) => void): void {
    for (const component of this.dirty) {
      if (!component.destroyed && component.owner && !component.owner.destroyed) send(component, this.state(component).progress);
    }
    this.dirty.clear();
  }

  remove(component: ActorComponent): void {
    this.states.delete(component);
    this.dirty.delete(component);
  }

  private state(component: ActorComponent): AppearState {
    let state = this.states.get(component);
    if (!state) {
      const properties = parseText2DProperties(Object.fromEntries(component.variables), { rich: true });
      state = { progress: properties.appearStart === "revealed" ? 1 : 0,
        direction: properties.appearStart === "play" ? 1 : 0, duration: this.duration(component) };
      this.states.set(component, state);
      this.finishInstant(component, state);
    }
    return state;
  }

  private duration(component: ActorComponent): number {
    const properties = parseText2DProperties(Object.fromEntries(component.variables), { rich: true });
    return text2DAppearDuration(countText2DRevealCharacters(properties), properties);
  }

  private finishInstant(component: ActorComponent, state: AppearState): void {
    if (state.direction && state.duration === 0) {
      state.progress = state.direction === 1 ? 1 : 0;
      state.direction = 0;
      this.dirty.add(component);
    }
  }
}

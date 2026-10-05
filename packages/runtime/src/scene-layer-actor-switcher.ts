import { Actor, SceneLayerActorSwitcher, type ClassRegistry } from "@babylonslate/object-model";

export type SceneLayerActorEntry = { classId: string; defaults: Record<string, unknown> };

/** Strings remain convenient graph array inputs; authored entries carry defaults. */
function actorEntry(value: unknown): SceneLayerActorEntry | null {
  if (typeof value === "string" && value.trim()) return { classId: value.trim(), defaults: {} };
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.classId !== "string" || !entry.classId.trim()) return null;
  return { classId: entry.classId.trim(), defaults: entry.defaults && typeof entry.defaults === "object" && !Array.isArray(entry.defaults)
    ? structuredClone(entry.defaults as Record<string, unknown>) : {} };
}

type SwitcherServices = {
  classes: ClassRegistry;
  alive(actor: Actor): boolean;
  spawn(parent: Actor, classId: string, defaults: Record<string, unknown>): Actor | null;
  remove(actor: Actor): void;
  event(actor: Actor, name: string, args: Record<string, unknown>): void;
};

/** Selection ownership stays independent of rendering and script execution. */
export class SceneLayerActorSwitchers {
  private readonly initialized = new WeakSet<SceneLayerActorSwitcher>();
  private readonly switching = new WeakSet<SceneLayerActorSwitcher>();
  private readonly owners = new Map<Actor, SceneLayerActorSwitcher>();
  private readonly children = new Map<SceneLayerActorSwitcher, Actor>();

  private readonly services: SwitcherServices;

  constructor(services: SwitcherServices) { this.services = services; }

  initialize(actor: Actor): void {
    if (!(actor instanceof SceneLayerActorSwitcher) || this.initialized.has(actor) || !this.services.alive(actor)) return;
    this.initialized.add(actor);
    this.switchTo(actor, actor.getVariable("initialIndex") ?? 0);
  }

  current(target: unknown): Actor | null {
    if (!(target instanceof SceneLayerActorSwitcher) || !this.services.alive(target)) return null;
    const actor = target.currentActor;
    return actor && this.services.alive(actor) ? actor : null;
  }

  switchTo(target: unknown, index: unknown): Actor | null {
    if (!(target instanceof SceneLayerActorSwitcher) || !this.services.alive(target) || !target.sceneLayerId) return null;
    const previousActor = this.current(target);
    if (this.switching.has(target)) return previousActor;
    const previousIndex = previousActor ? target.currentIndex : -1;
    if (typeof index !== "number" || !Number.isInteger(index) || index < -1) return previousActor;
    const entries = target.sceneLayerActorEntries;
    const entry = index === -1 ? null : actorEntry(Array.isArray(entries) ? entries[index] : null);
    if (index !== -1 && (!entry || !this.services.classes.isA(entry.classId, "SceneLayerActor"))) return previousActor;
    if (index === previousIndex && (index === -1 || previousActor)) return previousActor;
    this.initialized.add(target);
    this.switching.add(target);
    try {
      this.services.event(target, "onSceneLayerActorSwitching", { previousActor, currentActor: previousActor, previousIndex, index });
      if (!this.services.alive(target)) return null;
      const actor = entry ? this.services.spawn(target, entry.classId, entry.defaults) : null;
      if (entry && !actor) return previousActor;
      if (!this.services.alive(target)) {
        if (actor) this.services.remove(actor);
        return null;
      }
      if (previousActor) {
        this.services.event(previousActor, "onSceneLayerActorSwitchedFrom", { switcher: target, index: previousIndex });
        this.owners.delete(previousActor);
      }
      if (!this.services.alive(target)) {
        if (actor) this.services.remove(actor);
        return null;
      }
      target.setSelection(actor, index);
      this.children.delete(target);
      if (actor) { this.owners.set(actor, target); this.children.set(target, actor); }
      if (previousActor) this.services.remove(previousActor);
      if (actor && this.services.alive(target) && this.services.alive(actor)) {
        this.services.event(actor, "onSceneLayerActorSwitchedTo", { switcher: target, index });
      }
      if (this.services.alive(target)) {
        this.services.event(target, "onSceneLayerActorSwitched", { previousActor, currentActor: this.current(target), previousIndex, index: target.currentIndex });
      }
      return this.current(target);
    } finally {
      this.switching.delete(target);
    }
  }

  /** Also clears a switcher's reference when gameplay destroys its active child. */
  retire(actor: Actor): void {
    const owner = this.owners.get(actor);
    if (owner) {
      this.owners.delete(actor);
      if (this.children.get(owner) === actor) {
        this.children.delete(owner);
        owner.setSelection(null, -1);
      }
    }
    if (!(actor instanceof SceneLayerActorSwitcher)) return;
    const child = this.children.get(actor);
    this.children.delete(actor);
    actor.setSelection(null, -1);
    if (child) {
      this.owners.delete(child);
      this.services.remove(child);
    }
  }
}

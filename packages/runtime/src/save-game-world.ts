import { SaveGameError, newGuid, type SaveGameValue, type Transform } from "@babylonslate/core";
import { Actor, ActorComponent, BObject, type World } from "@babylonslate/object-model";

interface SavedActor {
  id: string;
  classId: string;
  spawned: boolean;
  destroyed: boolean;
  transform?: Transform;
  parent?: string | null;
  variables: Record<string, SaveGameValue>;
  components: Record<string, Record<string, SaveGameValue>>;
}
interface WorldSave {
  version: 1;
  sceneId: string;
  actors: SavedActor[];
}
interface Selection {
  transform: boolean;
  destruction: boolean;
  variables: string[];
  components: Record<string, string[]>;
}
interface TrackedActor {
  actor: Actor;
  id: string;
  spawned: boolean;
  selection: Selection;
  initial: SavedActor;
  captured: boolean;
}
interface StagedWorldSave {
  snapshot: WorldSave;
  prepared: Map<string, Actor>;
  targets: Map<string, Actor>;
}
export interface SaveGameWorldHost {
  world: World;
  sceneId(): string;
  eligible(actor: Actor): boolean;
  isSpawned(actor: Actor): boolean;
  prepare(id: string, classId: string, spawned: boolean): Actor | null;
  realize(actor: Actor): void;
  remove(actor: Actor): void;
  synchronize(actors: readonly Actor[]): void;
  reportError(error: unknown): void;
}

const reserved = new Set(["__proto__", "prototype", "constructor"]);
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function strings(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item || reserved.has(item))) {
    throw new SaveGameError("incompatible", "Save Game variable selections must contain variable names.");
  }
  return [...new Set(value as string[])];
}
function selection(actor: Actor): Selection | null {
  const component = actor.components.find((item) => !item.destroyed && item.classId === "SaveGameComponent");
  if (!component) return null;
  const components: Record<string, string[]> = Object.create(null);
  const selectedComponents = component.getVariable("componentVariables");
  if (selectedComponents !== undefined && !record(selectedComponents)) {
    throw new SaveGameError("incompatible", "Save Game component variable selections are invalid.");
  }
  for (const [id, names] of Object.entries(selectedComponents ?? {})) {
    if (reserved.has(id)) throw new SaveGameError("incompatible", "Invalid component identity.");
    components[id] = strings(names);
  }
  return {
    transform: component.getVariable("saveTransform") !== false,
    destruction: component.getVariable("persistDestruction") !== false,
    variables: strings(component.getVariable("actorVariables")), components,
  };
}
function componentId(component: ActorComponent): string { return component.sourceId ?? component.guid; }
function findComponent(actor: Actor, id: string): ActorComponent | undefined {
  return actor.components.find((component) => !component.destroyed && componentId(component) === id);
}
function validTransform(value: unknown): value is Transform {
  if (!record(value)) return false;
  return (["position", "rotation", "scale"] as const).every((key) => {
    const vector = value[key];
    return record(vector) && (key === "rotation" ? ["x", "y", "z", "w"] : ["x", "y", "z"])
      .every((axis) => typeof vector[axis] === "number" && Number.isFinite(vector[axis]));
  });
}

/** Selected gameplay state only. Runtime identities and renderer internals never enter a save. */
export class SaveGameWorld {
  private readonly tracked = new Map<string, TrackedActor>();
  private readonly identity = new WeakMap<Actor, string>();
  private scene = "";

  constructor(private readonly host: SaveGameWorldHost) {}

  persistentId(actor: Actor): string {
    return this.identity.get(actor) ?? actor.guid;
  }

  findActor(id: string): Actor | undefined {
    const actor = this.tracked.get(id)?.actor ?? this.host.world.findActor(id);
    return actor && !actor.destroyed ? actor : undefined;
  }

  private updateScene(): void {
    const scene = this.host.sceneId();
    if (scene !== this.scene) { this.tracked.clear(); this.scene = scene; }
  }

  register(actor: Actor, spawned = false, persistentId?: string): void {
    this.updateScene();
    const selected = selection(actor);
    if (!selected) {
      if (persistentId !== undefined) throw new SaveGameError("incompatible", "Add a Save Game Component before registering an actor.");
      return;
    }
    if (!this.host.eligible(actor)) throw new SaveGameError("incompatible", "Save Game actors must belong to the main world scene; overlays and streamed scenes are not supported.");
    const previousId = this.identity.get(actor);
    if (previousId && this.tracked.get(previousId)?.actor === actor) {
      if (persistentId && persistentId !== previousId) {
        const entry = this.tracked.get(previousId)!;
        if (!entry.spawned || entry.captured || this.tracked.has(persistentId) || reserved.has(persistentId)) {
          throw new SaveGameError("incompatible", "Set a unique spawned actor identity before its first save.");
        }
        this.tracked.delete(previousId);
        this.identity.set(actor, persistentId);
        entry.id = persistentId;
        entry.initial.id = persistentId;
        this.tracked.set(persistentId, entry);
      }
      return;
    }
    const id = persistentId ?? (spawned ? `spawn:${newGuid()}` : actor.guid);
    if (!id || reserved.has(id)) throw new SaveGameError("incompatible", "Invalid persistent actor identity.");
    const previous = this.tracked.get(id);
    if (previous && previous.actor !== actor && !previous.actor.destroyed) throw new SaveGameError("incompatible", `Duplicate persistent actor identity: ${id}`);
    this.identity.set(actor, id);
    const entry: TrackedActor = { actor, id, spawned, selection: selected, initial: null!, captured: false };
    this.tracked.set(id, entry);
    entry.initial = this.captureActor(entry);
  }

  private encode(value: unknown, seen = new Set<object>()): SaveGameValue {
    if (value instanceof ActorComponent) {
      if (!value.owner) return null;
      if (!this.identity.has(value.owner) && this.host.isSpawned(value.owner)) throw new SaveGameError("incompatible", "Register spawned reference targets before saving.");
      return { $saveReference: "component", actor: this.identity.get(value.owner) ?? value.owner.guid, component: componentId(value) };
    }
    if (value instanceof Actor) {
      if (!this.identity.has(value) && this.host.isSpawned(value)) throw new SaveGameError("incompatible", "Register spawned reference targets before saving.");
      return { $saveReference: "actor", actor: this.identity.get(value) ?? value.guid };
    }
    if (value instanceof BObject) throw new SaveGameError("incompatible", "Only actor and actor-component object references can be saved.");
    if (value === undefined || value === null) return null;
    if (typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object" || seen.has(value)) throw new SaveGameError("incompatible", "Saved variables must contain finite data without cycles.");
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new SaveGameError("incompatible", "Saved variables must be plain data, arrays, or actor references.");
    }
    seen.add(value);
    try {
      if (Array.isArray(value)) return value.map((item) => this.encode(item, seen));
      const out: Record<string, SaveGameValue> = Object.create(null);
      for (const [key, child] of Object.entries(value)) {
        if (reserved.has(key) || key === "$saveReference") throw new SaveGameError("incompatible", "Saved variable contains a reserved key.");
        out[key] = this.encode(child, seen);
      }
      return out;
    } finally { seen.delete(value); }
  }

  private captureActor(entry: TrackedActor): SavedActor {
    const { actor, id, spawned, selection: selected } = entry;
    const saved: SavedActor = { id, classId: actor.classId, spawned, destroyed: actor.destroyed, variables: {}, components: {} };
    if (actor.destroyed) return saved;
    if (selected.transform) {
      saved.transform = structuredClone(actor.transform);
      const parentGuid = actor.getVariable("parentId");
      const parent = typeof parentGuid === "string" ? this.host.world.findActor(parentGuid) : undefined;
      if (parent && !this.identity.has(parent) && this.host.isSpawned(parent)) {
        throw new SaveGameError("incompatible", "Register spawned parents before saving their children.");
      }
      // Initial placed actors are registered before all parents have spawned.
      saved.parent = parent ? this.persistentId(parent) : typeof parentGuid === "string" ? parentGuid : null;
    }
    for (const name of selected.variables) saved.variables[name] = this.encode(actor.getVariable(name));
    for (const [id, names] of Object.entries(selected.components)) {
      const component = findComponent(actor, id);
      if (!component) throw new SaveGameError("incompatible", `Selected component is unavailable: ${id}`);
      const values: Record<string, SaveGameValue> = {};
      for (const name of names) values[name] = this.encode(component.getVariable(name));
      saved.components[id] = values;
    }
    return saved;
  }

  capture(): SaveGameValue {
    this.updateScene();
    for (const actor of this.host.world.getActors()) this.register(actor);
    const actors = [...this.tracked.values()].filter((entry) => !entry.actor.destroyed || entry.selection.destruction)
      .map((entry) => this.captureActor(entry));
    // Validate references before persisting, including references to a destroyed target.
    const snapshot = { version: 1, sceneId: this.scene, actors } satisfies WorldSave;
    this.validateReferences(snapshot, this.liveTargets());
    for (const entry of this.tracked.values()) entry.captured = true;
    return snapshot as unknown as SaveGameValue;
  }

  private liveTargets(): Map<string, Actor> {
    const targets = new Map<string, Actor>();
    for (const actor of this.host.world.getActors()) if (!actor.destroyed) targets.set(this.identity.get(actor) ?? actor.guid, actor);
    return targets;
  }

  private decode(value: SaveGameValue, targets: Map<string, Actor>): unknown {
    if (Array.isArray(value)) return value.map((item) => this.decode(item, targets));
    if (!record(value)) return value;
    if ("$saveReference" in value) {
      if (typeof value.actor !== "string") throw new SaveGameError("corrupt", "Invalid actor reference.");
      const actor = targets.get(value.actor);
      if (!actor || actor.destroyed) throw new SaveGameError("incompatible", `Saved actor reference is unavailable: ${value.actor}`);
      if (value.$saveReference === "actor") return actor;
      if (value.$saveReference !== "component" || typeof value.component !== "string") throw new SaveGameError("corrupt", "Invalid component reference.");
      const component = findComponent(actor, value.component);
      if (!component) throw new SaveGameError("incompatible", `Saved component reference is unavailable: ${value.component}`);
      return component;
    }
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (reserved.has(key)) throw new SaveGameError("corrupt", "Saved variable contains a reserved key.");
      out[key] = this.decode(child as SaveGameValue, targets);
    }
    return out;
  }

  private validateReferences(snapshot: WorldSave, targets: Map<string, Actor>): void {
    for (const saved of snapshot.actors) {
      if (saved.destroyed) targets.delete(saved.id);
    }
    for (const saved of snapshot.actors) {
      this.decode(saved.variables, targets);
      this.decode(saved.components, targets);
      if (saved.parent && !targets.has(saved.parent)) throw new SaveGameError("incompatible", `Saved parent is unavailable: ${saved.parent}`);
    }
    const byId = new Map(snapshot.actors.map((saved) => [saved.id, saved]));
    for (const saved of snapshot.actors) {
      const visited = new Set<string>();
      let id: string | null | undefined = saved.id;
      while (id) {
        if (visited.has(id)) throw new SaveGameError("corrupt", "Saved actor parenting contains a cycle.");
        visited.add(id);
        const row = byId.get(id);
        if (row?.parent !== undefined) id = row.parent;
        else {
          const parentGuid = targets.get(id)?.getVariable("parentId");
          const parent = typeof parentGuid === "string" ? this.host.world.findActor(parentGuid) : undefined;
          id = parent ? this.persistentId(parent) : null;
        }
      }
    }
  }

  stage(value: SaveGameValue): StagedWorldSave {
    this.updateScene();
    if (!record(value) || value.version !== 1 || typeof value.sceneId !== "string" || !Array.isArray(value.actors)) {
      throw new SaveGameError("corrupt", "Invalid saved world state.");
    }
    if (value.sceneId !== this.scene) throw new SaveGameError("incompatible", "Load the saved scene before loading this game.");
    const snapshot = structuredClone(value) as unknown as WorldSave;
    const prepared = new Map<string, Actor>();
    const targets = this.liveTargets();
    const ids = new Set<string>();
    for (const saved of snapshot.actors) {
      if (!record(saved) || typeof saved.id !== "string" || !saved.id || reserved.has(saved.id) || ids.has(saved.id) ||
        typeof saved.classId !== "string" || typeof saved.spawned !== "boolean" || typeof saved.destroyed !== "boolean" ||
        !record(saved.variables) || !record(saved.components) || (saved.transform !== undefined && !validTransform(saved.transform)) ||
        (saved.parent !== undefined && saved.parent !== null && typeof saved.parent !== "string")) {
        throw new SaveGameError("corrupt", "Invalid or duplicate saved actor.");
      }
      ids.add(saved.id);
      if (saved.destroyed) {
        const candidate = targets.get(saved.id) ?? this.host.prepare(saved.id, saved.classId, saved.spawned);
        const selected = candidate && selection(candidate);
        if (!candidate || candidate.classId !== saved.classId || !selected?.destruction || !this.host.eligible(candidate)) {
          throw new SaveGameError("incompatible", `Saved destruction cannot be restored: ${saved.id}`);
        }
        if (saved.transform || saved.parent !== undefined || Object.keys(saved.variables).length || Object.keys(saved.components).length) {
          throw new SaveGameError("corrupt", "Destroyed actor records cannot contain live state.");
        }
        continue;
      }
      let actor = targets.get(saved.id);
      if (actor && (actor.classId !== saved.classId || !this.host.eligible(actor))) throw new SaveGameError("incompatible", `Actor definition changed: ${saved.id}`);
      if (!actor) {
        actor = this.host.prepare(saved.id, saved.classId, saved.spawned) ?? undefined;
        if (!actor) throw new SaveGameError("incompatible", `Actor definition is unavailable: ${saved.classId}`);
        prepared.set(saved.id, actor);
        targets.set(saved.id, actor);
      }
      const selected = selection(actor);
      if (!selected) throw new SaveGameError("incompatible", `Actor no longer has a Save Game Component: ${saved.id}`);
      if (Object.keys(saved.variables).some((name) => !selected.variables.includes(name)) || (saved.transform && !selected.transform)) {
        throw new SaveGameError("incompatible", `Saved actor selection changed: ${saved.id}`);
      }
      for (const [id, variables] of Object.entries(saved.components)) {
        if (!record(variables)) throw new SaveGameError("corrupt", "Invalid component variables.");
        if (!findComponent(actor, id) || Object.keys(variables).some((name) => !selected.components[id]?.includes(name))) {
          throw new SaveGameError("incompatible", `Saved component selection changed: ${id}`);
        }
      }
    }
    // Spawned actors absent from this checkpoint must not survive loading it.
    for (const entry of this.tracked.values()) if (entry.spawned && !ids.has(entry.id)) targets.delete(entry.id);
    this.validateReferences(snapshot, targets);
    return { snapshot, prepared, targets };
  }

  apply(staged: unknown): void {
    const { snapshot, prepared, targets } = staged as StagedWorldSave;
    if (snapshot.sceneId !== this.host.sceneId()) throw new SaveGameError("incompatible", "The scene changed while the save was loading.");
    const rollback: Array<{ actor: Actor; transform: Transform; variables: Map<string, unknown>; components: Array<[ActorComponent, Map<string, unknown>]> }> = [];
    const added: Actor[] = [];
    try {
      for (const saved of snapshot.actors) {
        if (saved.destroyed) continue;
        const actor = targets.get(saved.id)!;
        if (actor.destroyed || (!prepared.has(saved.id) && actor.world !== this.host.world) ||
          (prepared.has(saved.id) && this.host.world.findActor(actor.guid))) {
          throw new SaveGameError("incompatible", "Actor membership changed while the save was loading.");
        }
        rollback.push({ actor, transform: structuredClone(actor.transform), variables: new Map(actor.variables), components: actor.components.map((component) => [component, new Map(component.variables)]) });
        if (saved.transform) actor.transform = structuredClone(saved.transform);
        if (saved.parent !== undefined) actor.setVariable("parentId", saved.parent ? targets.get(saved.parent)!.guid : null);
        for (const [name, value] of Object.entries(saved.variables)) actor.setVariable(name, this.decode(value, targets));
        for (const [id, variables] of Object.entries(saved.components)) {
          const component = findComponent(actor, id)!;
          for (const [name, value] of Object.entries(variables)) component.setVariable(name, this.decode(value, targets));
        }
      }
      for (const saved of snapshot.actors) {
        const actor = prepared.get(saved.id);
        if (!actor) continue;
        this.identity.set(actor, saved.id);
        added.push(actor);
        this.host.realize(actor);
      }
      this.host.synchronize([...targets.values()]);
    } catch (error) {
      for (const actor of added.reverse()) this.host.remove(actor);
      this.host.world.flushPending();
      for (const entry of rollback) {
        entry.actor.transform = entry.transform;
        entry.actor.variables.clear();
        for (const [key, value] of entry.variables) entry.actor.setVariable(key, value);
        for (const [component, variables] of entry.components) {
          component.variables.clear();
          for (const [key, value] of variables) component.setVariable(key, value);
        }
      }
      this.host.synchronize(rollback.map((entry) => entry.actor).filter((actor) => !actor.destroyed));
      throw error;
    }
    // All fallible decoding, preparation, and rendering admission precedes destruction.
    const savedIds = new Set(snapshot.actors.map((saved) => saved.id));
    for (const saved of snapshot.actors) {
      const previous = this.tracked.get(saved.id);
      if (saved.destroyed) {
        const actor = previous?.actor ?? this.host.world.findActor(saved.id);
        if (actor && !actor.destroyed) this.finishCommit(() => this.host.remove(actor));
      } else {
        const actor = targets.get(saved.id)!;
        this.identity.set(actor, saved.id);
        this.tracked.set(saved.id, { actor, id: saved.id, spawned: saved.spawned, selection: selection(actor)!, initial: previous?.initial ?? saved, captured: true });
      }
    }
    for (const [id, entry] of this.tracked) {
      if (entry.spawned && !savedIds.has(id)) {
        if (!entry.actor.destroyed) this.finishCommit(() => this.host.remove(entry.actor));
        this.tracked.delete(id);
      }
    }
    this.finishCommit(() => this.host.world.flushPending());
    this.finishCommit(() => this.host.synchronize([...targets.values()].filter((actor) => !actor.destroyed)));
  }

  /** After committing destruction, host notification faults are diagnostics,
   * never a false load failure that implies the old game still exists. */
  private finishCommit(operation: () => void): void {
    try { operation(); }
    catch (error) {
      try { this.host.reportError(error); } catch { /* A disconnected renderer may also reject its diagnostic. */ }
    }
  }

  reset(): void {
    this.updateScene();
    const snapshot = { version: 1, sceneId: this.scene, actors: [...this.tracked.values()].filter((entry) => !entry.spawned).map((entry) => entry.initial) };
    this.apply(this.stage(snapshot as unknown as SaveGameValue));
  }
}

import {
  isFocusTargetClass, normalizeFocusNavigationSettings, parseFocusTargetProperties,
  type FocusDirection, type FocusNavigationSettings, type FocusTargetProperties, type InputValueState,
} from "@haptic/core";
import { Actor, ActorComponent, type World } from "@haptic/object-model";
import { InputResolver, type AxisBinding, type RawInputEvent, type ResolvedInputTick } from "@haptic/input";
import { actorParentGuid, actorWorldTransform, composeParentChildTransform } from "./actor-world-transform";

/** x/y are the rectangle center in the owning layer's design coordinates. */
export interface FocusBounds { x: number; y: number; width: number; height: number }
export interface FocusNavigationHost {
  canRun(actor: Actor): boolean;
  event(actor: Actor, component: ActorComponent, name: string): void;
  bounds?(actor: Actor, component: ActorComponent): FocusBounds | null | undefined;
  onFocusChange?(actor: Actor, component: ActorComponent): void;
}
interface Candidate {
  actor: Actor;
  component: ActorComponent;
  bounds: FocusBounds;
  properties: FocusTargetProperties;
}
/** A Scene Layer actor and its focus-target components. */
interface FocusEntry { actor: Actor; components: ActorComponent[] }
/** Scene Layer actors with focus-target components, for one world structure revision. */
interface FocusTargets {
  revision: number;
  /** Each Scene Layer id's entries, in world order (an actor's layer never changes). */
  byLayer: Map<string, FocusEntry[]>;
  /** The components whose `focused` variable held no value when last looked at, in world order. */
  unset: FocusEntry[];
}

/** Parsed focus properties and the variable values they were parsed from. */
interface ParsedFocusProperties { values: unknown[]; properties: FocusTargetProperties }
/** The parser reads exactly the keys it returns, so `focused` and other writes never invalidate. */
const FOCUS_PROPERTY_KEYS = Object.keys(parseFocusTargetProperties());

function fallbackResolver(): InputResolver {
  const directions: AxisBinding[] = [
    ...["ArrowLeft", "KeyA"].map((code): AxisBinding => ({ device: "key", code, component: "x", digitalValue: -1 })),
    ...["ArrowRight", "KeyD"].map((code): AxisBinding => ({ device: "key", code, component: "x", digitalValue: 1 })),
    ...["ArrowUp", "KeyW"].map((code): AxisBinding => ({ device: "key", code, component: "y", digitalValue: 1 })),
    ...["ArrowDown", "KeyS"].map((code): AxisBinding => ({ device: "key", code, component: "y", digitalValue: -1 })),
  ];
  for (let pad = 0; pad < 4; pad++) {
    directions.push(
      { device: "gamepadAxis", code: `${pad}:0`, component: "x", deadZone: 0.5 },
      { device: "gamepadAxis", code: `${pad}:1`, component: "y", deadZone: 0.5, invert: true },
      ...([ [14, "x", -1], [15, "x", 1], [12, "y", 1], [13, "y", -1] ] as const)
        .map(([button, component, digitalValue]): AxisBinding => ({ device: "gamepadButton", code: `${pad}:${button}`, component, digitalValue })),
    );
  }
  return new InputResolver({
    actions: [{ name: "focusActivate", bindings: [
      { device: "key", code: "Enter" }, { device: "key", code: "Space" },
      ...Array.from({ length: 4 }, (_, pad) => ({ device: "gamepadButton" as const, code: `${pad}:0` })),
    ] }],
    axes: [{ name: "focusNavigate", kind: "2d", bindings: directions }],
  });
}

function directionOf(value: InputValueState["value"] | undefined): FocusDirection | null {
  if (!value || typeof value !== "object") return null;
  if (Math.max(Math.abs(value.x), Math.abs(value.y)) < 0.15) return null;
  return Math.abs(value.x) > Math.abs(value.y)
    ? value.x > 0 ? "right" : "left"
    : value.y > 0 ? "up" : "down";
}
function available(object: Actor | ActorComponent): boolean {
  return !object.destroyed && object.getVariable("visible") !== false && object.getVariable("enabled") !== false;
}

/** Runtime-owned focus; no browser DOM, rendering dependency, or gameplay-input consumption. */
export class SceneLayerFocusNavigation {
  private readonly defaults = fallbackResolver();
  private readonly settings: FocusNavigationSettings;
  private readonly world: World;
  private readonly host: FocusNavigationHost;
  private focused: Candidate | null = null;
  private pressed: Candidate | null = null;
  private direction: FocusDirection | null = null;
  private repeatRemaining = 0;
  private initialLayer: string | null = null;
  private targets: FocusTargets | null = null;
  /** The layers the current `candidates` call walked, reused between calls. */
  private readonly walkedLayers = new Set<string>();
  private readonly parsed = new WeakMap<ActorComponent, ParsedFocusProperties>();
  /**
   * Parent lookups through the World's own guid registry, which holds exactly its actor list; nothing spawns or
   * destroys while candidates are collected.
   */
  private readonly actors: Pick<ReadonlyMap<string, Actor>, "get"> = { get: (guid) => this.world.findActor(guid) };

  constructor(world: World, settings: Partial<FocusNavigationSettings> | undefined, host: FocusNavigationHost) {
    this.world = world;
    this.host = host;
    this.settings = normalizeFocusNavigationSettings(settings);
  }

  /**
   * Which actors and components can be focus targets changes only with the
   * world structure (spawn, destroy, attach, reparent), so the full actor walk
   * reruns only after a structural change. Availability, admission, transforms
   * and bounds are read live on every call.
   */
  private focusTargets(): FocusTargets {
    const revision = this.world.structuralRevision;
    if (this.targets?.revision === revision) return this.targets;
    const byLayer: FocusTargets["byLayer"] = new Map();
    const unset: FocusEntry[] = [];
    for (const actor of this.world.getActors()) {
      if (!actor.sceneLayerId) continue;
      const components = actor.components.filter((component) => isFocusTargetClass(component.classId));
      if (components.length === 0) continue;
      let entries = byLayer.get(actor.sceneLayerId);
      if (!entries) byLayer.set(actor.sceneLayerId, entries = []);
      entries.push({ actor, components });
      const pending = components.filter((component) => component.getVariable("focused") === undefined);
      if (pending.length > 0) unset.push({ actor, components: pending });
    }
    this.targets = { revision, byLayer, unset };
    return this.targets;
  }

  /** Reparsed only when a variable the parser reads (booleans and strings) holds a different value. */
  private focusProperties(component: ActorComponent): FocusTargetProperties {
    const variables = component.variables;
    const entry = this.parsed.get(component);
    if (entry) {
      let same = true;
      for (let i = 0; i < FOCUS_PROPERTY_KEYS.length; i++) {
        if (entry.values[i] !== variables.get(FOCUS_PROPERTY_KEYS[i]!)) { same = false; break; }
      }
      if (same) return entry.properties;
    }
    const properties = parseFocusTargetProperties(Object.fromEntries(variables));
    this.parsed.set(component, { values: FOCUS_PROPERTY_KEYS.map((key) => variables.get(key)), properties });
    return properties;
  }

  /**
   * The live candidates of the topmost layer that has any, in world order.
   *
   * Layers are walked from the top and the walk stops at the first with a
   * candidate, so the layers under it cost nothing. The one thing the walk
   * does to a target outside the owning layer is give its `focused` variable
   * its first value (false) once the target could take focus; `unset` keeps
   * exactly the components still without a value, so that write reaches the
   * layers that were not walked. A `focused` that holds a value is never
   * looked at again here: nothing clears the variable back to undefined.
   */
  private candidates(): Candidate[] {
    if (!this.settings.enabled) return [];
    // Focus targets live only on Scene Layer actors; a world without a live layer has none to walk.
    const liveLayers = this.world.getSceneLayers().filter((layer) => !layer.destroyed);
    if (liveLayers.length === 0) return [];
    const targets = this.focusTargets();
    const result: Candidate[] = [];
    // Same tie-break as the compositor: the last drawn eligible layer owns navigation.
    const layers = liveLayers.sort((a, b) => a.zOrder - b.zOrder || a.guid.localeCompare(b.guid));
    const walked = this.walkedLayers;
    walked.clear();
    for (let at = layers.length - 1; at >= 0 && result.length === 0; at--) {
      const layer = layers[at]!;
      walked.add(layer.guid);
      for (const entry of targets.byLayer.get(layer.guid) ?? []) this.collect(entry, result);
    }
    const unset = targets.unset;
    if (unset.length > 0) {
      let kept = 0;
      for (const entry of unset) {
        if (!walked.has(entry.actor.sceneLayerId!)) this.collect(entry, null);
        let pending = 0;
        for (const component of entry.components) {
          if (component.getVariable("focused") === undefined) entry.components[pending++] = component;
        }
        entry.components.length = pending;
        if (pending > 0) unset[kept++] = entry;
      }
      unset.length = kept;
    }
    return result;
  }

  /**
   * Gives each of the entry's components that can take focus now its first `focused` value and, with `result`,
   * appends those with usable bounds as candidates.
   */
  private collect({ actor, components }: FocusEntry, result: Candidate[] | null): void {
    if (!available(actor) || !this.host.canRun(actor)) return;
    const byGuid = this.actors;
    const visited = new Set<string>([actor.guid]);
    let parentId = actorParentGuid(actor);
    while (parentId) {
      const parent = byGuid.get(parentId);
      if (!parent || visited.has(parentId) || !available(parent) || parent.sceneLayerId !== actor.sceneLayerId) return;
      visited.add(parentId);
      parentId = actorParentGuid(parent);
    }
    const actorTransform = actorWorldTransform(actor, byGuid);
    if (!actorTransform) return;
    for (const component of components) {
      if (!available(component)) continue;
      const properties = this.focusProperties(component);
      if (!properties.focusEnabled) continue;
      if (component.getVariable("focused") === undefined) component.setVariable("focused", false);
      if (!result) continue;
      const chain = [component.transform];
      const seen = new Set([component.guid]);
      let attachment = component.parentId;
      let eligible = true;
      while (attachment) {
        const parent = actor.components.find((entry) => entry.guid === attachment || entry.sourceId === attachment);
        if (!parent || seen.has(parent.guid) || !available(parent)) { eligible = false; break; }
        seen.add(parent.guid);
        chain.unshift(parent.transform);
        attachment = parent.parentId;
      }
      if (!eligible) continue;
      let transform = actorTransform;
      for (const local of chain) transform = composeParentChildTransform(transform, local);
      const customBounds = this.host.bounds?.(actor, component);
      const bounds = customBounds === undefined ? {
        x: transform.position.x, y: transform.position.y,
        width: Math.abs(transform.scale.x), height: Math.abs(transform.scale.y),
      } : customBounds;
      if (!bounds || !Number.isFinite(bounds.x) || !Number.isFinite(bounds.y) || bounds.width <= 0 || bounds.height <= 0) continue;
      result.push({ actor, component, bounds, properties });
    }
  }

  private emit(target: Candidate, event: string): void {
    if (!target.actor.destroyed && !target.component.destroyed && this.host.canRun(target.actor)) {
      this.host.event(target.actor, target.component, event);
    }
  }

  private transition(target: Candidate | null): void {
    if (target?.component === this.focused?.component) return;
    const previous = this.focused;
    this.focused = null;
    const pressed = this.pressed;
    this.pressed = null;
    if (pressed?.component.classId === "2DButtonComponent") this.emit(pressed, "onPressEnd");
    if (previous) {
      previous.component.setVariable("focused", false);
      this.emit(previous, "onFocusLeave");
    }
    // A leave handler can remove/disable the next target or explicitly redirect focus.
    if (this.focused || !target) return;
    const live = this.candidates().find((entry) => entry.component === target.component);
    if (!live) return;
    this.focused = live;
    live.component.setVariable("focused", true);
    this.host.onFocusChange?.(live.actor, live.component);
    this.emit(live, "onFocusEnter");
  }

  /** Revalidate the focused target and return the live candidates, read again only after a leave handler ran. */
  private refreshed(): Candidate[] {
    const candidates = this.candidates();
    const current = candidates.find((entry) => entry.component === this.focused?.component);
    if (this.focused && !current) {
      this.transition(null);
      return this.candidates();
    }
    if (current) this.focused = current;
    return candidates;
  }

  refresh(): void { this.refreshed(); }

  getFocused(): ActorComponent | null { this.refresh(); return this.focused?.component ?? null; }

  setFocus(target: unknown): boolean {
    const candidates = this.candidates();
    const candidate = candidates.find((entry) => target instanceof ActorComponent ? entry.component === target
      : target instanceof Actor ? entry.actor === target : false);
    if (!candidate) return false;
    this.transition(candidate);
    return this.focused?.component === candidate.component;
  }

  /** Tab order shares the same live, top-layer candidate set as gamepad focus. */
  advance(reverse = false): ActorComponent | null {
    const candidates = this.refreshed();
    if (!candidates.length) return null;
    this.initialLayer = candidates[0]!.actor.sceneLayerId;
    const index = candidates.findIndex((entry) => entry.component === this.focused?.component);
    let next = index < 0 ? reverse ? candidates.length - 1 : 0 : index + (reverse ? -1 : 1);
    if (next < 0 || next >= candidates.length) next = this.settings.wrap ? (next + candidates.length) % candidates.length : index;
    this.transition(candidates[next] ?? null);
    return this.getFocused();
  }

  clearFocus(target?: unknown): void {
    if (target !== undefined && target !== this.focused?.component && target !== this.focused?.actor) return;
    this.transition(null);
    this.direction = null;
  }

  private initial(candidates: Candidate[]): Candidate | undefined {
    return candidates.find((entry) => entry.properties.focusInitial) ?? [...candidates].sort((a, b) => b.bounds.y - a.bounds.y || a.bounds.x - b.bounds.x)[0];
  }

  move(direction: FocusDirection): void {
    const candidates = this.refreshed();
    const current = this.focused;
    if (!current) { this.transition(this.initial(candidates) ?? null); return; }
    const key = `focus${direction[0]!.toUpperCase()}${direction.slice(1)}` as keyof FocusTargetProperties;
    const explicit = current.properties[key];
    if (typeof explicit === "string") {
      // Prefab component IDs are relative to their owning instance. Resolve the
      // local definition even when unavailable, so a disabled sibling cannot
      // redirect navigation into another instance of the same prefab.
      const local = current.actor.components.find((component) => component.sourceId === explicit);
      const sourceMatches = local ? [] : candidates.filter((entry) => entry.component.sourceId === explicit);
      const target = local
        ? candidates.find((entry) => entry.component === local)
        : candidates.find((entry) => entry.component.guid === explicit || entry.actor.guid === explicit)
          ?? (sourceMatches.length === 1 ? sourceMatches[0] : undefined);
      // An authored missing/disabled neighbor stops here; never silently route elsewhere.
      if (target) this.transition(target);
      return;
    }
    const horizontal = direction === "left" || direction === "right";
    const sign = direction === "right" || direction === "up" ? 1 : -1;
    const distances = candidates.filter((entry) => entry.component !== current.component).map((entry) => {
      const dx = entry.bounds.x - current.bounds.x, dy = entry.bounds.y - current.bounds.y;
      return { entry, along: (horizontal ? dx : dy) * sign, across: Math.abs(horizontal ? dy : dx) };
    });
    const forward = distances.filter((entry) => entry.along > 0.0001)
      .sort((a, b) => (a.along + a.across * 3) - (b.along + b.across * 3));
    const next = forward[0]?.entry ?? (this.settings.wrap
      ? distances.sort((a, b) => a.along - b.along || a.across - b.across)[0]?.entry : undefined);
    if (next) this.transition(next);
  }

  /**
   * Settings are normalized once and never change, so a disabled navigation never has candidates or a focus, and the
   * fallback bindings are never read once both inputs are configured; neither then needs this tick's work.
   */
  tick(events: readonly RawInputEvent[], input: ResolvedInputTick, dt: number): void {
    if (!this.settings.enabled) return;
    const defaults = this.settings.navigationInputGuid && this.settings.activateInputGuid
      ? null
      : this.defaults.resolve(events, dt);
    const candidates = this.refreshed();
    const layer = candidates[0]?.actor.sceneLayerId ?? null;
    if (layer !== this.initialLayer) {
      this.initialLayer = layer;
      const initial = candidates.find((entry) => entry.properties.focusInitial);
      if (initial) this.transition(initial);
    }
    const navigate = this.settings.navigationInputGuid
      ? input.inputs[this.settings.navigationInputGuid]
      : defaults?.inputs.focusNavigate;
    const direction = directionOf(navigate?.held ? navigate.value : undefined);
    const pulse = !navigate?.held && navigate?.started ? directionOf(navigate.activeValue) : null;
    if (pulse) this.move(pulse);
    if (direction !== this.direction || direction !== null && navigate?.started) {
      this.direction = direction;
      this.repeatRemaining = this.settings.repeatDelay;
      if (direction) this.move(direction);
    } else if (direction) {
      this.repeatRemaining -= dt;
      if (this.repeatRemaining <= 0) {
        this.move(direction);
        this.repeatRemaining = this.settings.repeatInterval;
      }
    }
    const activate = this.settings.activateInputGuid
      ? input.inputs[this.settings.activateInputGuid]
      : defaults?.inputs.focusActivate;
    // A release and repress between ticks ends the previous press first.
    // Keep a final held press pending; a completed tap still ends this tick.
    const releaseBeforeStart = activate?.started && activate.released && (activate.held || this.pressed !== null);
    if (releaseBeforeStart) this.releaseActivation();
    if (activate?.started) {
      this.refresh();
      if (!this.focused) this.transition(this.initial(this.candidates()) ?? null);
      this.pressed = this.focused;
      if (this.pressed?.component.classId === "2DButtonComponent") this.emit(this.pressed, "onPressStart");
    }
    if (activate?.released && (!releaseBeforeStart || !activate.held)) this.releaseActivation();
  }

  private releaseActivation(): void {
    this.refresh();
    const pressed = this.pressed;
    this.pressed = null;
    if (!pressed) return;
    if (pressed.component.classId === "2DButtonComponent") this.emit(pressed, "onPressEnd");
    this.refresh();
    if (pressed.component !== this.focused?.component) return;
    this.emit(pressed, "onFocusActivate");
    this.refresh();
    if (pressed.component === this.focused?.component && pressed.component.classId === "2DButtonComponent") this.emit(pressed, "onClick");
  }
}

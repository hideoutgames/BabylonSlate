import {
  isFocusTargetClass, normalizeFocusNavigationSettings, parseFocusTargetProperties,
  type FocusDirection, type FocusNavigationSettings, type FocusTargetProperties, type InputValueState,
} from "@babylonslate/core";
import { Actor, ActorComponent, type World } from "@babylonslate/object-model";
import { InputResolver, type AxisBinding, type RawInputEvent, type ResolvedInputTick } from "@babylonslate/input";
import { actorParentGuid, actorWorldTransform, composeParentChildTransform, actorGuidIndex } from "./actor-world-transform";

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

  constructor(world: World, settings: Partial<FocusNavigationSettings> | undefined, host: FocusNavigationHost) {
    this.world = world;
    this.host = host;
    this.settings = normalizeFocusNavigationSettings(settings);
  }

  private candidates(): Candidate[] {
    if (!this.settings.enabled) return [];
    const actors = this.world.getActors();
    const byGuid = actorGuidIndex(actors);
    const result: Candidate[] = [];
    for (const actor of actors) {
      if (!actor.sceneLayerId || !available(actor) || !this.host.canRun(actor)) continue;
      const visited = new Set<string>([actor.guid]);
      let parentId = actorParentGuid(actor);
      let visible = true;
      while (parentId) {
        const parent = byGuid.get(parentId);
        if (!parent || visited.has(parentId) || !available(parent) || parent.sceneLayerId !== actor.sceneLayerId) { visible = false; break; }
        visited.add(parentId);
        parentId = actorParentGuid(parent);
      }
      if (!visible) continue;
      const actorTransform = actorWorldTransform(actor, byGuid);
      if (!actorTransform) continue;
      for (const component of actor.components) {
        if (!isFocusTargetClass(component.classId) || !available(component)) continue;
        const properties = parseFocusTargetProperties(Object.fromEntries(component.variables));
        if (!properties.focusEnabled) continue;
        if (component.getVariable("focused") === undefined) component.setVariable("focused", false);
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
    // Same tie-break as the compositor: the last drawn eligible layer owns navigation.
    const layers = this.world.getSceneLayers().filter((layer) => !layer.destroyed)
      .sort((a, b) => a.zOrder - b.zOrder || a.guid.localeCompare(b.guid));
    const active = layers.reverse().find((layer) => result.some((candidate) => candidate.actor.sceneLayerId === layer.guid));
    return active ? result.filter((candidate) => candidate.actor.sceneLayerId === active.guid) : [];
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

  refresh(): void {
    const candidates = this.candidates();
    const current = candidates.find((entry) => entry.component === this.focused?.component);
    if (this.focused && !current) this.transition(null);
    else if (current) this.focused = current;
  }

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
    this.refresh();
    const candidates = this.candidates();
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
    this.refresh();
    const candidates = this.candidates();
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

  tick(events: readonly RawInputEvent[], input: ResolvedInputTick, dt: number): void {
    const defaults = this.defaults.resolve(events, dt);
    this.refresh();
    if (!this.settings.enabled) return;
    const candidates = this.candidates();
    const layer = candidates[0]?.actor.sceneLayerId ?? null;
    if (layer !== this.initialLayer) {
      this.initialLayer = layer;
      const initial = candidates.find((entry) => entry.properties.focusInitial);
      if (initial) this.transition(initial);
    }
    const navigate = this.settings.navigationInputGuid
      ? input.inputs[this.settings.navigationInputGuid]
      : defaults.inputs.focusNavigate;
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
      : defaults.inputs.focusActivate;
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

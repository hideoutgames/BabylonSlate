import type { CommandMessage, ControlMessage } from "@babylonslate/bridge";
import {
  SCENE_LAYER_DEFAULT_LAYER_BOUNDS,
  identityTransform,
  isInteractiveUIControl2DClass,
  isOverlayLayoutClass,
  isOverlayScrollClass,
  isSceneLayerAnchorActor,
  isUIControl2DClass,
  overlayLayoutKey,
  parseSceneLayerAnchor,
  sceneLayerRelativeAnchorWorldPosition,
  type FocusNavigationSettings,
  type OverlaySafeAreaInsets,
} from "@babylonslate/core";
import type { RawInputEvent, ResolvedInputTick } from "@babylonslate/input";
import {
  Actor,
  attachSerializedComponents,
  hydrateClassVariableValue,
  type ActorComponent,
  type SceneActorHooks,
  type World,
} from "@babylonslate/object-model";
import { actorParentGuid } from "./actor-world-transform";
import type { AudioParticleEmitter } from "./audio-particle-emitter";
import { overlayAnchorBindings } from "./overlay-anchor-layout";
import type { OwnerAdmission } from "./owner-admission";
import { liveOverlayButtons, type RenderCommandEmitter } from "./render-command-emitter";
import { SceneLayerActorSwitchers } from "./scene-layer-actor-switcher";
import { SceneLayerFocusNavigation } from "./scene-layer-focus";
import { focusLayoutEntry, revealFocusedElement } from "./scene-layer-focus-layout";
import { SceneLayerLayout } from "./scene-layer-layout";
import { SceneLayerVirtualization } from "./scene-layer-virtualization";
import type { ScriptHost, ScriptHostServices } from "./script-host";
import type { UIControls2DRuntime } from "./ui-controls2d-runtime";

/** Objects the overlay holds from construction; none is replaced during a session. */
interface SceneLayerOverlayDeps {
  world: World;
  focusNavigation: Partial<FocusNavigationSettings> | undefined;
  admission: OwnerAdmission;
  uiControls: UIControls2DRuntime;
  render: Pick<RenderCommandEmitter, "emitMeshAssignment">;
  audioParticles: Pick<AudioParticleEmitter, "emitAudio" | "emitParticles">;
  texturePixelSizes: Readonly<Record<string, { width: number; height: number }>>;
}

interface SceneLayerOverlayHost {
  stopped(): boolean;
  /** A Save Game boundary holds virtual layout until it commits. */
  saveBoundaryActive(): boolean;
  /** The driver is already removing this actor instance. */
  removing(actor: Actor): boolean;
  pixelsPerUnit(): number;
  scripts(): ScriptHost;
  slot(actor: Actor): number | undefined;
  /** The slot of a guid's first-spawned live actor. */
  guidSlot(guid: string): number | undefined;
  actorHooks: SceneActorHooks;
  /** Bind interface handlers, apply class defaults and assign a render slot (emitting its spawn). */
  prepareActor(actor: Actor): void;
  breakParentCycles(actors: readonly Actor[]): void;
  realizeActor(actor: Actor): void;
  /** Remove an actor instance the way the driver removes any owned actor. */
  removeActor(actor: Actor): void;
  publishSnapshot(): void;
  syncOverlayPhysics(): void;
  emit(command: CommandMessage): void;
}

/**
 * Scene Layer overlay: layout and virtualization, anchors against each actor's
 * design pose, the safe area and Play canvas size, pointer, scroll, control and
 * focus input, and Scene Layer Actor Switchers. It realizes a layer's created
 * actors for `SceneLayers` and forgets a removed layer's layout state.
 */
export class SceneLayerOverlay {
  private readonly layout = new SceneLayerLayout();
  private readonly virtualization = new SceneLayerVirtualization();
  private readonly focus: SceneLayerFocusNavigation;
  private readonly switchers: SceneLayerActorSwitchers;
  private readonly designPose = new Map<string, { x: number; y: number }>();
  private readonly anchoredActors = new Set<string>();
  private applyingLayouts = false;
  /** A Save Game boundary deferred layout; its commit publishes once. */
  private layoutDeferred = false;
  private safeAreaInsetsPixels: OverlaySafeAreaInsets = { left: 0, right: 0, top: 0, bottom: 0 };
  private canvasWidth = 1;
  private canvasHeight = 1;
  private spawnDepth = 0;
  private readonly deps: SceneLayerOverlayDeps;
  private readonly host: SceneLayerOverlayHost;

  constructor(deps: SceneLayerOverlayDeps, host: SceneLayerOverlayHost) {
    this.deps = deps;
    this.host = host;
    const { world, admission, uiControls } = deps;
    this.switchers = new SceneLayerActorSwitchers({
      classes: world.classRegistry,
      alive: (actor) => !host.stopped() && !actor.destroyed && !host.removing(actor) &&
        !!actor.sceneLayerId && !!world.findSceneLayer(actor.sceneLayerId),
      spawn: (parent, classId, defaults) => this.spawnActor(parent, classId, defaults),
      remove: (actor) => this.removeActorSubtree(actor),
      event: (actor, event, args) => {
        // Switching during Tick queues the new actor's World spawn. Its Begin
        // Play and Switched To precede the switcher's completion notification.
        const readyOwner = event === "onSceneLayerActorSwitched" && args.currentActor instanceof Actor
          ? args.currentActor : actor;
        admission.run(readyOwner, () =>
          admission.guard(() => host.scripts().invokeEvent(actor.classId, event, actor, args)));
      },
    });
    this.focus = new SceneLayerFocusNavigation(world, deps.focusNavigation, {
      canRun: (actor) => admission.canTickActor(actor),
      event: (actor, component, event) => {
        if (isUIControl2DClass(component.classId) && (event === "onFocusEnter" || event === "onFocusLeave")) {
          const slotId = host.slot(actor);
          if (slotId !== undefined) host.emit({ type: "setUIControl2D", slotId, componentId: component.guid,
            uiControl: { classId: component.classId, properties: uiControls.payload(component) }, focused: event === "onFocusEnter" });
        }
        if (event === "onFocusActivate") uiControls.activate(component);
        host.scripts().invokeEvent(actor.classId, event, actor, {}, component.guid);
      },
      bounds: (actor, component) => {
        const entry = focusLayoutEntry(this.layout, world, actor, component);
        const visual = entry?.componentId ? world.findActor(entry.actorId)?.components.find((target) => target.guid === entry.componentId) : undefined;
        if (visual?.getVariable("visible") === false || visual?.getVariable("enabled") === false) return null;
        return entry?.rect;
      },
      onFocusChange: (actor, component) => revealFocusedElement(this.layout, world, actor, component,
        (layerId, actorId, componentId, x, y) => this.applyScroll(layerId, actorId, componentId, x, y)),
    });
  }

  /** The Play canvas size the host last reported, in pixels. */
  canvasSize(): { width: number; height: number } {
    return { width: this.canvasWidth, height: this.canvasHeight };
  }

  /** Spawn, anchor and assign a Scene Layer's created actors in bounded passes. */
  *realizeActors(actors: readonly Actor[], checkpoint: () => void): Generator<void, void, unknown> {
    const world = this.deps.world;
    for (const actor of actors) {
      checkpoint();
      this.host.prepareActor(actor);
      checkpoint();
      world.spawnActorNow(actor);
      checkpoint();
      yield;
    }
    for (const actor of actors) this.switchers.initialize(actor);
    this.host.breakParentCycles(actors);
    for (const actor of actors) {
      checkpoint();
      this.ensureDesignPose(actor);
      yield;
    }
    for (const _ of this.applyAnchors(actors)) {
      checkpoint();
      yield _;
    }
    for (const actor of actors) {
      checkpoint();
      const slotId = this.host.slot(actor);
      if (slotId === undefined) continue;
      this.deps.render.emitMeshAssignment(actor, slotId);
      checkpoint();
      this.deps.audioParticles.emitAudio(actor);
      checkpoint();
      this.deps.audioParticles.emitParticles(actor);
      checkpoint();
      yield;
    }
  }

  /** Lay out every Scene Layer, creating or retiring virtualized actors, and emit each layer's layout. */
  applyLayouts(): void {
    // Virtual layout creates and retires ordinary UI actors. Their lifecycle
    // must run after restoration, outside the restored-world hook suppression.
    if (this.host.saveBoundaryActive()) { this.layoutDeferred = true; return; }
    if (this.applyingLayouts) return;
    this.applyingLayouts = true;
    const world = this.deps.world;
    const texturePixelSizes = this.deps.texturePixelSizes;
    try {
      for (const layer of world.getSceneLayers()) {
        const safeAreaInsets = {
          left: this.safeAreaInsetsPixels.left * layer.layerBounds.width / this.canvasWidth,
          right: this.safeAreaInsetsPixels.right * layer.layerBounds.width / this.canvasWidth,
          top: this.safeAreaInsetsPixels.top * layer.layerBounds.height / this.canvasHeight,
          bottom: this.safeAreaInsetsPixels.bottom * layer.layerBounds.height / this.canvasHeight,
        };
        let result = this.layout.update(layer.guid, world.getActors(), this.host.pixelsPerUnit(), texturePixelSizes, safeAreaInsets);
        if (this.virtualization.sync(layer.guid, world.getActors(), result?.entries ?? this.layout.entries(layer.guid),
          (owner, classId, defaults) => this.spawnActor(owner, classId, defaults),
          (actor) => this.removeActorSubtree(actor))) {
          result = this.layout.update(layer.guid, world.getActors(), this.host.pixelsPerUnit(), texturePixelSizes, safeAreaInsets) ?? result;
        }
        if (!result || layer.destroyed) continue;
        const transforms = new Map(result.actors.flatMap(actor => actor.components.map(component => [overlayLayoutKey(actor.id, component.id), component.transform] as const)));
        this.host.emit({ type: "sceneLayerLayout", layerId: layer.guid, entries: [...result.entries].flatMap(([key, entry]) => {
          const slotId = this.host.guidSlot(entry.actorId);
          return slotId === undefined ? [] : [{ ...entry, slotId, transform: transforms.get(key) }];
        }) });
      }
    } finally { this.applyingLayouts = false; }
  }

  /** A Save Game boundary ended: whether it deferred layout (cleared on read). */
  takeDeferredLayout(): boolean {
    const deferred = this.layoutDeferred;
    this.layoutDeferred = false;
    return deferred;
  }

  applyScroll(layerId: string, actorId: string, componentId: string, deltaX: number, deltaY: number): void {
    const actor = this.deps.world.findActor(actorId);
    if (!actor || actor.sceneLayerId !== layerId || !this.deps.admission.canTickActor(actor)) return;
    const component = actor.components.find(c => c.guid === componentId && isOverlayScrollClass(c.classId) && !c.destroyed);
    const state = this.layout.entries(layerId).get(overlayLayoutKey(actorId, componentId))?.scroll;
    if (!component || !state) return;
    component.setVariable("scrollX", Math.max(0, Math.min(state.maxX, state.x + (Number.isFinite(deltaX) ? deltaX : 0))));
    component.setVariable("scrollY", Math.max(0, Math.min(state.maxY, state.y + (Number.isFinite(deltaY) ? deltaY : 0))));
    this.applyLayouts();
    this.host.publishSnapshot();
  }

  resize(
    frustumWidth: number,
    frustumHeight: number,
    canvasWidth?: number,
    canvasHeight?: number,
    safeAreaInsets?: Partial<OverlaySafeAreaInsets>,
  ): void {
    const width = Number(frustumWidth);
    const height = Number(frustumHeight);
    if (!Number.isFinite(width) || width <= 0) return;
    if (!Number.isFinite(height) || height <= 0) return;
    if (typeof canvasWidth === "number" && canvasWidth > 0) {
      this.canvasWidth = canvasWidth;
    }
    if (typeof canvasHeight === "number" && canvasHeight > 0) {
      this.canvasHeight = canvasHeight;
    }
    const inset = (value: number | undefined) =>
      typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
    this.safeAreaInsetsPixels = {
      left: inset(safeAreaInsets?.left),
      right: inset(safeAreaInsets?.right),
      top: inset(safeAreaInsets?.top),
      bottom: inset(safeAreaInsets?.bottom),
    };
    for (const _ of this.applyAnchors(this.deps.world.getActors())) void _;
    this.applyLayouts();
    this.host.syncOverlayPhysics();
  }

  focusNavigate(reverse: boolean): void {
    const focused = this.focus.advance(reverse);
    const actor = focused?.owner;
    const slotId = actor ? this.host.slot(actor) : undefined;
    // A single remaining target may not transition. Acknowledge it so the host
    // can reopen a text editor after Tab without inventing another focus order.
    if (focused && isUIControl2DClass(focused.classId) && slotId !== undefined) {
      this.host.emit({ type: "setUIControl2D", slotId, componentId: focused.guid,
        uiControl: { classId: focused.classId, properties: this.deps.uiControls.payload(focused) }, focused: true, beginEditing: true });
    }
  }

  control(message: Extract<ControlMessage, { type: "sceneLayerControl" }>): void {
    const actor = this.deps.world.findActor(message.actorGuid);
    if (!actor || actor.destroyed || actor.sceneLayerId !== message.layerId || !actor.sceneLayerId || !this.deps.admission.canTickActor(actor)) return;
    const component = actor.components.find((entry) => entry.guid === message.componentId || entry.sourceId === message.componentId);
    if (!component || component.destroyed || !isInteractiveUIControl2DClass(component.classId)) return;
    if (message.action === "focus") this.focus.setFocus(component);
    else if (message.action === "blur") this.focus.clearFocus(component);
    else this.deps.uiControls.input(component, message);
  }

  pointer(message: Extract<ControlMessage, { type: "sceneLayerPointer" }>): void {
    const actor = this.deps.world.findActor(message.actorGuid);
    if (!actor || actor.destroyed || !actor.sceneLayerId) return;
    if (!this.deps.admission.canTickActor(actor)) return;
    const requested =
      typeof message.componentId === "string" ? message.componentId.trim() : "";
    const resolved = resolveOverlayPointerButton(this.deps.world, actor, requested);
    if (!resolved) return;
    if (resolved.button?.getVariable("enabled") === false) return;
    if (message.event === "onPressStart" && resolved.button) this.focus.setFocus(resolved.button);
    this.host.scripts().invokeEvent(
      resolved.owner.classId,
      message.event,
      resolved.owner,
      {},
      resolved.button?.guid,
    );
  }

  /** This tick's focus navigation input. */
  tickFocus(events: readonly RawInputEvent[], input: ResolvedInputTick, dt: number): void {
    this.focus.tick(events, input, dt);
  }

  /**
   * A Scene Layer component's property changed: re-anchor for anchor edits,
   * lay out, and write a clamped scroll back. True when the component is the
   * overlay's own (layout or anchor), so nothing else refreshes.
   */
  refreshComponent(owner: Actor, component: ActorComponent, propertyName?: string): boolean {
    if (!owner.sceneLayerId) return false;
    if (component.classId === "2DAnchorComponent") {
      for (const _ of this.applyAnchors(this.deps.world.getActors())) void _;
    }
    this.applyLayouts();
    if (isOverlayScrollClass(component.classId) &&
      (propertyName === "scroll.offset" || propertyName === "scrollX" || propertyName === "scrollY")) {
      const scroll = this.layout.entries(owner.sceneLayerId).get(overlayLayoutKey(owner.guid, component.guid))?.scroll;
      if (scroll) { component.setVariable("scrollX", scroll.x); component.setVariable("scrollY", scroll.y); }
    }
    return isOverlayLayoutClass(component.classId) || component.classId === "2DAnchorComponent";
  }

  /** Show a Scene Layer Actor Switcher's entry (script `Switch Scene Layer Actor`). */
  switchActor(target: unknown, index: unknown): Actor | null {
    return this.switchers.switchTo(target, index);
  }

  currentActor(target: unknown): Actor | null {
    return this.switchers.current(target);
  }

  setFocus(target: unknown): boolean {
    return this.focus.setFocus(target);
  }

  clearFocus(target: unknown): void {
    this.focus.clearFocus(target);
  }

  /** Drop a removed layer's layout, virtualization and focus state. */
  forget(layerGuid: string): void {
    this.layout.remove(layerGuid);
    this.virtualization.remove(layerGuid);
    this.focus.refresh();
  }

  /** The driver begins removing this actor, or it was destroyed: release its switcher selection. */
  retireSwitcher(actor: Actor): void {
    this.switchers.retire(actor);
  }

  /** The driver removes this live actor instance: forget its design pose. */
  forgetActor(actor: Actor): void {
    if (this.deps.world.findActor(actor.guid) !== actor) return;
    this.designPose.delete(actor.guid);
    this.anchoredActors.delete(actor.guid);
  }

  /** Stop: clear focus, then every layer's layout and virtualization. */
  clear(): void {
    this.focus.clearFocus();
    this.layout.clear();
    this.virtualization.clear();
  }

  /** Spawn a prefab in its owner's overlay; transforms stay local to the parent. */
  private spawnActor(parent: Actor, classId: string, defaults: Record<string, unknown> = {}): Actor | null {
    const world = this.deps.world;
    if (this.host.stopped() || parent.destroyed || !parent.sceneLayerId || !world.findSceneLayer(parent.sceneLayerId) ||
      !world.classRegistry.isA(classId, "SceneLayerActor") || this.spawnDepth >= 32) return null;
    this.spawnDepth++;
    let actor: Actor | null = null;
    try {
      const variables = structuredClone(defaults);
      for (const variable of world.classRegistry.inheritedVariables(classId)) {
        if (!Object.hasOwn(variables, variable.name) || !variable.container) continue;
        variables[variable.name] = hydrateClassVariableValue({ ...variable, defaultValue: variables[variable.name] });
      }
      actor = world.createActor({
        classId, sceneLayerId: parent.sceneLayerId,
        variables: { ...variables, parentId: parent.guid },
        hooks: this.host.actorHooks(classId),
      });
      const scripts = this.host.scripts();
      const components = world.classRegistry.ancestry(classId)
        .flatMap((ancestor) => scripts.scriptsFor(ancestor))
        .find((script) => script.components !== undefined)?.components;
      if (components) attachSerializedComponents(world, actor, components, { freshIds: true });
      scripts.bindInterfaceHandlers(actor);
      this.ensureDesignPose(actor);
      for (const _ of this.applyAnchors([actor])) { void _; }
      this.host.realizeActor(actor);
      this.switchers.initialize(actor);
      return actor.destroyed ? null : actor;
    } catch (error) {
      if (actor) this.host.removeActor(actor);
      throw error;
    } finally {
      this.spawnDepth--;
    }
  }

  /** Selection-owned descendants must never outlive their removed screen. */
  private removeActorSubtree(root: Actor): void {
    const descendants = [root];
    const seen = new Set<Actor>(descendants);
    const actors = [...this.deps.world.getActors()];
    for (let index = 0; index < descendants.length; index++) {
      const parent = descendants[index]!;
      for (const actor of actors) {
        if (seen.has(actor) || actor.sceneLayerId !== root.sceneLayerId || actor.getVariable("parentId") !== parent.guid) continue;
        descendants.push(actor); seen.add(actor);
      }
    }
    for (const actor of descendants.reverse()) this.host.removeActor(actor);
  }

  private ensureDesignPose(actor: Actor): void {
    if (!actor.sceneLayerId) return;
    if (this.designPose.has(actor.guid)) return;
    this.designPose.set(actor.guid, {
      x: actor.transform.position.x,
      y: actor.transform.position.y,
    });
  }

  private *applyAnchors(actors: readonly Actor[]): Generator<void, void, unknown> {
    const bindings = overlayAnchorBindings(actors);
    for (const actor of actors) {
      if (!actor.sceneLayerId || actor.destroyed) continue;
      this.ensureDesignPose(actor);
      if (isSceneLayerAnchorActor(actor)) actor.transform = identityTransform();
      const anchor = bindings.get(actor);
      if (anchor) {
        this.applyRelativeAnchor(actor, anchor);
        this.anchoredActors.add(actor.guid);
      } else if (this.anchoredActors.delete(actor.guid)) {
        const authored = this.designPose.get(actor.guid)!;
        actor.transform.position.x = authored.x;
        actor.transform.position.y = authored.y;
      }
      yield;
    }
  }

  private applyRelativeAnchor(actor: Actor, anchorComp: ActorComponent): void {
    this.ensureDesignPose(actor);
    const authored = this.designPose.get(actor.guid) ?? {
      x: actor.transform.position.x,
      y: actor.transform.position.y,
    };
    const layer = this.deps.world.findSceneLayer(actor.sceneLayerId!);
    const bounds = layer?.layerBounds ?? SCENE_LAYER_DEFAULT_LAYER_BOUNDS;
    const pos = sceneLayerRelativeAnchorWorldPosition({
      anchor: parseSceneLayerAnchor(anchorComp.getVariable("anchor")),
      authoredX: authored.x,
      authoredY: authored.y,
      offsetX: Number(anchorComp.getVariable("offsetX")) || 0,
      offsetY: Number(anchorComp.getVariable("offsetY")) || 0,
      layerWidth: bounds.width,
      layerHeight: bounds.height,
      frustumWidth: bounds.width,
      frustumHeight: bounds.height,
    });
    actor.transform.position.x = pos.x;
    actor.transform.position.y = pos.y;
  }

}

function findOverlayButton(
  buttons: readonly ActorComponent[],
  requested: string,
): ActorComponent | undefined {
  return buttons.find(
    (component) =>
      component.guid === requested || component.sourceId === requested,
  );
}

function resolveOverlayPointerButton(
  world: World,
  actor: Actor,
  requested: string,
): { owner: Actor; button: ActorComponent | undefined } | null {
  const own = liveOverlayButtons(actor);
  if (own.length > 0) {
    const button = requested
      ? findOverlayButton(own, requested)
      : own.length === 1
        ? own[0]
        : undefined;
    if (requested && !button) return null;
    return { owner: actor, button };
  }
  const children = world
    .getActors()
    .filter((child) => actorParentGuid(child) === actor.guid);
  if (requested) {
    for (const child of children) {
      const button = findOverlayButton(liveOverlayButtons(child), requested);
      if (button) return { owner: child, button };
    }
    return null;
  }
  const withButtons = children.filter(
    (child) => liveOverlayButtons(child).length > 0,
  );
  if (withButtons.length === 0) return null;
  const owner = withButtons[0]!;
  const buttons = liveOverlayButtons(owner);
  return {
    owner,
    button: buttons.length === 1 ? buttons[0] : undefined,
  };
}

interface SceneLayerOverlayHostDeps {
  overlay: SceneLayerOverlay;
}

/** Script focus targets and Scene Layer Actor Switcher calls. */
export function createSceneLayerOverlayHostBindings(deps: SceneLayerOverlayHostDeps): Pick<ScriptHostServices,
  "switchSceneLayerActor" | "getCurrentSceneLayerActor" | "setFocusTarget" | "clearFocusTarget"> {
  const { overlay } = deps;
  return {
    switchSceneLayerActor: (target, index) => overlay.switchActor(target, index),
    getCurrentSceneLayerActor: (target) => overlay.currentActor(target),
    setFocusTarget: (target) => overlay.setFocus(target),
    clearFocusTarget: (target) => { overlay.clearFocus(target); },
  };
}

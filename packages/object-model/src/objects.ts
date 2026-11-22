import {
  newGuid,
  normalizeScenePostProcessStack,
  normalizeMaterialInstanceOverrides,
  normalizeSuppressedComponentSourceIds,
  POST_PROCESSING_PANEL_CLASS_ID,
  type MaterialInstanceOverrides,
  type ScenePostProcessEntry,
  normalizeSceneLayerCanvasDesign,
  type SceneLayerCanvasDesign,
  layerCameraStartState,
  supportsOverlayVisualStyle,
  type LayerCameraState,
  type Guid,
  type InputKey,
  type TouchInput,
  type DeviceMotionState,
  type GuidFactory,
  type Transform,
} from "@haptic/core";
import { sceneAssetClassId } from "./ids";
import {
  createObservedTransform,
  writeObservedPoseSilent,
  writeObservedTransform,
} from "./observed-transform";

export type TickContext = {
  dt: number;
  tickIndex: number;
  world: WorldLike;
  /** Resolved input actions / axes for this tick; absent when no mappings. */
  isActionHeld?: (action: string) => boolean;
  wasActionPressed?: (action: string) => boolean;
  wasActionReleased?: (action: string) => boolean;
  getPressedKeys?: () => readonly InputKey[];
  getAxis?: (axis: string) => number;
  getAxis2D?: (axis: string) => { x: number; y: number };
  getCursorPosition?: () => { x: number; y: number; pressed: boolean };
  /** This tick's contacts in Finger order, including those lifted this tick. */
  getTouches?: () => readonly TouchInput[];
  /** This tick's Began, Moved, Ended and Cancelled records in input order. */
  getTouchEvents?: () => readonly TouchInput[];
  /** Tilt, acceleration and rotation rate; reading it starts the device's motion input. */
  getDeviceMotion?: () => DeviceMotionState;
  /** The device's current pose becomes zero tilt. */
  calibrateTilt?: () => void;
  setCursorVisible?: (visible: boolean) => void;
  setGamepadRumble?: (
    gamepadIndex: number,
    intensity: number,
    durationMs: number,
  ) => void;
  /** Vibrate the phone or tablet; 0 stops it. */
  vibrateDevice?: (durationMs: number) => void;
  /** Connection transitions observed while resolving this tick. */
  gamepadConnections?: ReadonlyArray<{
    gamepadIndex: number;
    connected: boolean;
  }>;
};

export type TransformChangeSource = "script" | "physics";
export type ComponentChangeKind = "attached" | "destroyed" | "variable" | "transform" | "meta";

export interface WorldLike {
  markStructureChanged?(): void;
  noteActorParentChanged?(actor: Actor, previousParentGuid: Guid | null, nextParentGuid: Guid | null): void;
  noteActorTransformChanged?(actor: Actor, source: TransformChangeSource): void;
  noteActorVariableChanged?(actor: Actor, name: string | null): void;
  noteActorComponentChanged?(actor: Actor, component: ActorComponent, kind: ComponentChangeKind): void;
  noteActorLayerChanged?(actor: Actor, previousLayerId: Guid | null, nextLayerId: Guid | null): void;
  rngNextFloat(): number;
}

export type LifecycleHooks<T extends EngineObject = EngineObject> = {
  onCreation?: (self: T) => void;
  onTick?: (self: T, ctx: TickContext) => void;
  /**
   * Whether `onTick` has anything to run for `self` now; absent means it always has. The World asks
   * before tick admission, so it must be cheap and free of side effects.
   */
  ticks?: (self: T) => boolean;
  onDestroyed?: (self: T) => void;
};

const isPrimitive = (value: unknown): boolean =>
  value === null || (typeof value !== "object" && typeof value !== "function");

const normalizeParentGuid = (value: unknown): Guid | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/**
 * Variables that count their writes. `revision` advances on every set, delete or
 * clear that can change what a reader sees, so a consumer that remembers it can
 * skip re-reading values nothing wrote. Rewriting a primitive with itself is no
 * change; a value that is an object always counts, since it may be mutated
 * in place before it is written again.
 */
class VersionedVariables extends Map<string, unknown> {
  revision = 0;

  constructor(entries: Iterable<readonly [string, unknown]> = []) {
    super();
    // Not `super(entries)`: that would call `set` before `revision` exists.
    for (const [name, value] of entries) this.set(name, value);
  }

  protected onChanged(name: string | null): void { void name; }

  override set(name: string, value: unknown): this {
    // An object value always counts, so it skips the lookup; a primitive costs one `get`, and `has`
    // only when the write is `undefined`, which a missing key also reads as.
    const unchanged = isPrimitive(value) && Object.is(super.get(name), value) && (value !== undefined || super.has(name));
    super.set(name, value);
    if (!unchanged) {
      this.revision++;
      this.onChanged(name);
    }
    return this;
  }

  override delete(name: string): boolean {
    const deleted = super.delete(name);
    if (deleted) {
      this.revision++;
      this.onChanged(name);
    }
    return deleted;
  }

  override clear(): void {
    if (this.size > 0) {
      this.revision++;
      super.clear();
      this.onChanged(null);
      return;
    }
    super.clear();
  }
}

/** Component variables notify the owning actor's World on any write, delete or clear. */
class ComponentVariables extends VersionedVariables {
  private readonly component: ActorComponent;

  constructor(component: ActorComponent, entries: Iterable<readonly [string, unknown]>) {
    super();
    this.component = component;
    for (const [name, value] of entries) super.set(name, value);
  }

  protected override onChanged(): void {
    const owner = this.component?.owner;
    owner?.world?.noteActorComponentChanged?.(owner, this.component, "variable");
  }
}

/** Collider geometry enters through replacement, never in-place vertex mutation.
 * Copy at this existing authoring boundary; direct variables.set uses it too. */
class ColliderVariables extends ComponentVariables {
  constructor(component: ActorComponent, entries: Iterable<readonly [string, unknown]>) {
    super(component, []);
    for (const [name, value] of entries) this.set(name, value);
  }

  override set(name: string, value: unknown): this {
    return super.set(name, name === "shape" ? freezeCollisionValue(structuredClone(value)) : value);
  }
}

/** Every write path, including direct `variables` map writes, marks structural and variable changes. */
class ActorVariables extends VersionedVariables {
  private readonly actor: Actor;

  constructor(actor: Actor, entries: Iterable<readonly [string, unknown]>) {
    super();
    this.actor = actor;
    // Initial values are construction, not a change; no World is attached yet.
    for (const [name, value] of entries) super.set(name, value);
  }

  protected override onChanged(name: string | null): void {
    this.actor?.world?.noteActorVariableChanged?.(this.actor, name);
  }

  // `parentId` changes the hierarchy and so the World's structural revision. A
  // `name` write reaches the World as a variable change (`World.actorNameRevision`).
  override set(name: string, value: unknown): this {
    if (name !== "parentId") return super.set(name, value);
    const previous = this.get(name);
    const prevParent = normalizeParentGuid(previous);
    const nextParent = normalizeParentGuid(value);
    super.set(name, value);
    if (value !== previous) {
      if (prevParent !== nextParent && this.actor?.world?.noteActorParentChanged) {
        this.actor.world.noteActorParentChanged(this.actor, prevParent, nextParent);
      } else {
        this.markStructureChanged();
      }
    }
    return this;
  }

  override delete(name: string): boolean {
    if (name !== "parentId") return super.delete(name);
    const previous = this.get(name);
    const prevParent = normalizeParentGuid(previous);
    const deleted = super.delete(name);
    if (previous !== undefined) {
      if (prevParent !== null && this.actor?.world?.noteActorParentChanged) {
        this.actor.world.noteActorParentChanged(this.actor, prevParent, null);
      } else {
        this.markStructureChanged();
      }
    }
    return deleted;
  }

  override clear(): void {
    const prevParentVal = this.get("parentId");
    const prevParent = normalizeParentGuid(prevParentVal);
    super.clear();
    if (prevParent !== null && this.actor?.world?.noteActorParentChanged) {
      this.actor.world.noteActorParentChanged(this.actor, prevParent, null);
    } else if (prevParentVal !== undefined) {
      this.markStructureChanged();
    }
  }

  private markStructureChanged(): void {
    this.actor?.world?.markStructureChanged?.();
  }
}

function freezeCollisionValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value)) freezeCollisionValue(child, seen);
    Object.freeze(value);
  }
  return value;
}

/** Shared by every object built without hooks; never written. */
const NO_HOOKS: LifecycleHooks = Object.freeze({});

export class EngineObject {
  readonly guid: Guid;
  readonly classId: string;
  readonly variables: Map<string, unknown>;
  implementedInterfaces: string[] = [];
  /** Per-instance interface handlers keyed by `interfaceGuid:methodName`; null until the first is bound. */
  interfaceHandlers: Map<
    string,
    (args: Record<string, unknown>) => Record<string, unknown>
  > | null = null;
  private readonly hooks: LifecycleHooks;
  private _destroyed = false;

  get destroyed(): boolean {
    return this._destroyed;
  }

  set destroyed(value: boolean) {
    if (this._destroyed === value) return;
    this._destroyed = value;
    this.onDestroyedFlagChanged();
  }

  protected onDestroyedFlagChanged(): void {}

  constructor(options: {
    classId: string;
    guid?: Guid;
    guidFactory?: GuidFactory;
    variables?: Record<string, unknown>;
    hooks?: LifecycleHooks;
    implementedInterfaces?: string[];
  }) {
    this.guid = options.guid ?? newGuid(options.guidFactory);
    this.classId = options.classId;
    this.variables = this.createVariables(Object.entries(options.variables ?? {}));
    this.hooks = options.hooks ?? NO_HOOKS;
    this.implementedInterfaces = [...(options.implementedInterfaces ?? [])];
  }

  /** Runs during construction, before subclass fields are initialized. */
  protected createVariables(entries: Array<[string, unknown]>): Map<string, unknown> {
    return new VersionedVariables(entries);
  }

  /**
   * Advances whenever a variable is written, deleted or cleared; rewriting a
   * primitive with itself does not. An unchanged revision proves no variable
   * value changed, so a caller can skip re-reading them.
   */
  get variablesRevision(): number {
    const variables = this.variables;
    return variables instanceof VersionedVariables ? variables.revision : Number.NaN;
  }

  callOnCreation(): void {
    this.hooks.onCreation?.(this);
  }

  /** Whether a tick hook is bound and has something to run: otherwise `callOnTick` does nothing, so the World skips its tick admission. */
  get ticks(): boolean {
    const hooks = this.hooks;
    return hooks.onTick !== undefined && (hooks.ticks === undefined || hooks.ticks(this));
  }

  callOnTick(ctx: TickContext): void {
    if (this.destroyed) return;
    this.hooks.onTick?.(this, ctx);
  }

  callOnDestroyed(): void {
    this.hooks.onDestroyed?.(this);
  }

  getVariable(name: string): unknown {
    return this.variables.get(name);
  }

  setVariable(name: string, value: unknown): void {
    this.variables.set(name, value);
  }
}

export class Actor extends EngineObject {
  private readonly _transform: Transform;
  private _transformRevision = 0;
  readonly components: ActorComponent[] = [];
  world: WorldLike | null = null;
  /** Dense position in the World's actor list, reassigned after removals. */
  spawnIndex = -1;
  /**
   * The World's spawn count when this actor spawned: never reassigned, so it
   * orders actors across removals (the actor list is ascending in it).
   */
  spawnOrder = -1;
  private _generateHitEvents = true;
  private _generateOverlapEvents = true;
  /** When false, World skips this actor's Event Tick (`onTick`). Components still tick. */
  tickEnabled = true;
  /** Keeps the actor and its components ticking while the game is paused (`World.gamePaused`). */
  tickOnPause = false;
  private _sceneLayerId: Guid | null = null;
  readonly suppressedComponentSourceIds: readonly string[];

  get transform(): Transform {
    return this._transform;
  }

  set transform(value: Transform) {
    writeObservedTransform(this._transform, value);
  }

  /**
   * Advances whenever any coordinate of `transform` changes (from scripts,
   * runtime writers, or physics readback); writing the same coordinate value
   * (`Object.is`) does not advance it.
   */
  get transformRevision(): number {
    return this._transformRevision;
  }

  /** When false, skip script `onHit` for this actor. Physics still simulates. */
  get generateHitEvents(): boolean {
    return this._generateHitEvents;
  }

  set generateHitEvents(value: boolean) {
    if (this._generateHitEvents === value) return;
    this._generateHitEvents = value;
    this.world?.noteActorVariableChanged?.(this, "generateHitEvents");
  }

  /** When false, skip script begin/end overlap for this actor. */
  get generateOverlapEvents(): boolean {
    return this._generateOverlapEvents;
  }

  set generateOverlapEvents(value: boolean) {
    if (this._generateOverlapEvents === value) return;
    this._generateOverlapEvents = value;
    this.world?.noteActorVariableChanged?.(this, "generateOverlapEvents");
  }

  /** Owning overlay instance; null for world-scene actors. */
  get sceneLayerId(): Guid | null {
    return this._sceneLayerId;
  }

  set sceneLayerId(value: Guid | null) {
    const next = value ?? null;
    if (this._sceneLayerId === next) return;
    const previous = this._sceneLayerId;
    this._sceneLayerId = next;
    this.world?.noteActorLayerChanged?.(this, previous, next);
  }

  constructor(
    options: {
      classId: string;
      guid?: Guid;
      guidFactory?: GuidFactory;
      variables?: Record<string, unknown>;
      hooks?: LifecycleHooks<Actor>;
      implementedInterfaces?: string[];
      transform?: Transform;
      sceneLayerId?: Guid | null;
      suppressedComponentSourceIds?: readonly string[];
    },
  ) {
    super({
      ...options,
      hooks: options.hooks as LifecycleHooks | undefined,
    });
    this._transform = createObservedTransform(options.transform, this);
    this._sceneLayerId = options.sceneLayerId ?? null;
    this.suppressedComponentSourceIds = Object.freeze(normalizeSuppressedComponentSourceIds(options.suppressedComponentSourceIds));
  }

  protected override createVariables(entries: Array<[string, unknown]>): Map<string, unknown> {
    return new ActorVariables(this, entries);
  }

  /** Called by observed transform accessors on any script/runtime coordinate write. */
  noteTransformChanged(): void {
    this._transformRevision++;
    this.world?.noteActorTransformChanged?.(this, "script");
  }

  /**
   * Apply a stepped physics pose directly without emitting a `"script"`
   * transform writeback. Advances `transformRevision` and emits `"physics"`
   * iff at least one position/rotation coordinate changed.
   */
  writeTransformPoseFromPhysics(
    position: Transform["position"],
    rotation: Transform["rotation"],
  ): boolean {
    if (!writeObservedPoseSilent(this._transform, position, rotation)) return false;
    this._transformRevision++;
    this.world?.noteActorTransformChanged?.(this, "physics");
    return true;
  }

  attachComponent(component: ActorComponent): void {
    if (component.owner) {
      throw new Error(`component ${component.guid} already attached`);
    }
    // Including during its own On Destroyed: nothing would ever end the component.
    if (this.destroyed) {
      throw new Error(`cannot attach component ${component.guid} to destroyed actor ${this.guid}`);
    }
    component.owner = this;
    this.components.push(component);
    this.world?.markStructureChanged?.();
    this.world?.noteActorComponentChanged?.(this, component, "attached");
    if (this.world) component.callOnCreation();
  }
}

/** Owns the one live selection of an overlay actor switcher. */
export class SceneLayerActorSwitcher extends Actor {
  private selection: Actor | null = null;
  private selectionIndex = -1;

  get currentActor(): Actor | null {
    return this.destroyed || this.selection?.destroyed ? null : this.selection;
  }

  get currentIndex(): number {
    return this.currentActor ? this.selectionIndex : -1;
  }

  /** Runtime controller publishes a selection atomically for graph getters. */
  setSelection(actor: Actor | null, index: number): void {
    this.selection = actor;
    this.selectionIndex = actor ? index : -1;
  }

  /** Authored class/default pairs; graph class-array getters project only IDs. */
  get sceneLayerActorEntries(): readonly unknown[] {
    const entries = super.getVariable("sceneLayerActors");
    return Array.isArray(entries) ? entries : [];
  }

  override getVariable(name: string): unknown {
    if (name === "sceneLayerActors") return this.sceneLayerActorEntries.map((entry) => {
      if (typeof entry === "string") return entry;
      if (entry && typeof entry === "object" && "classId" in entry && typeof entry.classId === "string") return entry.classId;
      return "";
    });
    if (name === "currentActor") return this.currentActor;
    if (name === "currentIndex") return this.currentIndex;
    return super.getVariable(name);
  }

  override setVariable(name: string, value: unknown): void {
    if (name === "currentActor" || name === "currentIndex") return;
    super.setVariable(name, value);
  }
}

/** Typed live actor identity for a placed additive-scene origin. */
export class SceneStreamingActor extends Actor {}

export class ActorComponent extends EngineObject {
  override callOnDestroyed(): void {
    this.owner?.world?.markStructureChanged?.();
    super.callOnDestroyed();
    // A script holding the component's Material object sees it destroyed, and the component lets go of it.
    if (this.materialObject) this.materialObject.destroyed = true;
    this.materialObject = null;
  }

  protected override onDestroyedFlagChanged(): void {
    const owner = this.owner;
    owner?.world?.noteActorComponentChanged?.(owner, this, "destroyed");
  }

  protected override createVariables(entries: Array<[string, unknown]>): Map<string, unknown> {
    return this.classId === "ColliderComponent"
      ? new ColliderVariables(this, entries)
      : new ComponentVariables(this, entries);
  }

  private materialObject: MaterialObject | null = null;
  private creationCalled = false;
  // `classId` never changes, so its class checks run once. Field initializers
  // run before the constructor body's first `getVariable`.
  /** Overlay visuals read a default Opacity and Tint while they hold none. */
  private readonly overlayStyleDefaults = supportsOverlayVisualStyle(this.classId);
  /** Mesh classes answer `materialObject` with their material instance; a Post Processing Panel with its pass's. */
  private readonly materialObjectClass =
    this.classId === "MeshComponent" || this.classId === "DynamicRuntimeMeshComponent" || this.classId === POST_PROCESSING_PANEL_CLASS_ID;

  override callOnCreation(): void {
    if (this.creationCalled || this.destroyed || !this.owner?.world) return;
    this.creationCalled = true;
    super.callOnCreation();
  }
  private materialRevision = 0;
  owner: Actor | null = null;
  private _assetGuid: Guid | null = null;
  /** Prefab component id when Place Actors remapped `guid`. */
  sourceId: string | null = null;
  private readonly _transform: Transform;
  private _transformRevision = 0;
  private _parentId: string | null;
  /** Authored seed only; current values belong to RuntimeMaterialParameters. */
  materialInstance?: MaterialInstanceOverrides;

  /** Optional asset reference stub for engine components. */
  get assetGuid(): Guid | null {
    return this._assetGuid;
  }

  set assetGuid(value: Guid | null) {
    const next = value ?? null;
    if (this._assetGuid === next) return;
    this._assetGuid = next;
    const owner = this.owner;
    owner?.world?.noteActorComponentChanged?.(owner, this, "meta");
  }

  get parentId(): string | null {
    return this._parentId;
  }

  set parentId(value: string | null) {
    const next = value ?? null;
    if (this._parentId === next) return;
    this._parentId = next;
    const owner = this.owner;
    owner?.world?.noteActorComponentChanged?.(owner, this, "meta");
  }

  get transform(): Transform {
    return this._transform;
  }

  set transform(value: Transform) {
    writeObservedTransform(this._transform, value);
  }

  get transformRevision(): number {
    return this._transformRevision;
  }

  noteTransformChanged(): void {
    this._transformRevision++;
    const owner = this.owner;
    owner?.world?.noteActorComponentChanged?.(owner, this, "transform");
  }

  constructor(
    options: {
      classId: string;
      guid?: Guid;
      guidFactory?: GuidFactory;
      variables?: Record<string, unknown>;
      hooks?: LifecycleHooks<ActorComponent>;
      implementedInterfaces?: string[];
      assetGuid?: Guid | null;
      sourceId?: string | null;
      transform?: Transform;
      parentId?: string | null;
      materialInstance?: MaterialInstanceOverrides;
    },
  ) {
    super({
      ...options,
      hooks: options.hooks as LifecycleHooks | undefined,
    });
    this._assetGuid = options.assetGuid ?? null;
    this.sourceId =
      typeof options.sourceId === "string" && options.sourceId.trim()
        ? options.sourceId.trim()
        : null;
    this._parentId = options.parentId ?? null;
    const materialInstance = normalizeMaterialInstanceOverrides(options.materialInstance);
    if (materialInstance?.materialGuid === this.getVariable("materialGuid")) this.materialInstance = materialInstance;
    this._transform = createObservedTransform(options.transform, this);
  }

  override getVariable(name: string): unknown {
    if (this.overlayStyleDefaults && !this.variables.has(name)) {
      if (name === "opacity") return 1;
      if (name === "tint") return [1, 1, 1, 1];
    }
    if (!this.materialObjectClass || name !== "materialObject") {
      return super.getVariable(name);
    }
    const guid = super.getVariable("materialGuid");
    if (
      this.destroyed ||
      !this.owner ||
      this.owner.destroyed ||
      typeof guid !== "string" ||
      !guid.trim()
    ) {
      if (this.materialObject) this.materialObject.destroyed = true;
      this.materialObject = null;
      return null;
    }
    if (
      !this.materialObject ||
      this.materialObject.materialAssetGuid !== guid
    ) {
      if (this.materialObject) this.materialObject.destroyed = true;
      this.materialObject = new MaterialObject(
        this,
        guid,
        ++this.materialRevision,
      );
    }
    return this.materialObject;
  }

  override setVariable(name: string, value: unknown): void {
    if (this.materialObjectClass) {
      if (name === "materialObject") return;
      if (name === "materialGuid" && value !== super.getVariable(name)) {
        if (this.materialObject) this.materialObject.destroyed = true;
        this.materialObject = null;
        this.materialInstance = undefined;
      }
    }
    super.setVariable(name, value);
  }
}

/** Engine-neutral reference to one mesh component's current material instance. */
export class MaterialObject extends EngineObject {
  readonly targetKind = "mesh" as const;
  readonly component: ActorComponent;
  readonly materialAssetGuid: string;

  constructor(
    component: ActorComponent,
    materialAssetGuid: string,
    revision: number,
  ) {
    super({
      classId: "MaterialObject",
      guid: `${component.guid}:material:${revision}`,
    });
    this.component = component;
    this.materialAssetGuid = materialAssetGuid;
  }
}

export type GameInstanceHooks = LifecycleHooks<GameInstance> & {
  onGameEnd?: (self: GameInstance) => void;
  onSceneStartLoading?: (self: GameInstance, sceneName: string) => void;
  onSceneFinishLoading?: (self: GameInstance, sceneName: string) => void;
  onFirstSceneLoaded?: (self: GameInstance, sceneName: string) => void;
  onSceneExit?: (self: GameInstance, sceneName: string) => void;
};

const LAYER_CAMERA_CLASS_ID = "LayerCamera";
const SCENE_CAMERA_MANAGER_CLASS_ID = "SceneCameraManager";

/**
 * The 2D orthographic camera a Scene or one Scene Layer instance owns. It
 * starts on the document's Camera Location; scripts move, turn and zoom it
 * through the runtime (`setLayerCamera`), never by writing `state` directly.
 * It lives exactly as long as its owner: it reads as destroyed once the
 * owner is.
 */
export class LayerCamera extends EngineObject {
  readonly owner: EngineObject;
  state: LayerCameraState;

  constructor(owner: EngineObject, location?: readonly [number, number] | null) {
    super({ classId: LAYER_CAMERA_CLASS_ID, guid: `${owner.guid}:layerCamera` });
    this.owner = owner;
    this.state = layerCameraStartState(location);
    // Validity follows the owner, whichever route ends it.
    Object.defineProperty(this, "destroyed", {
      get: () => owner.destroyed,
      set: () => {},
      enumerable: true,
      configurable: true,
    });
  }

  /** Camera Location, Rotation and Zoom read the live pose; nothing else is stored. */
  override getVariable(name: string): unknown {
    if (name === "location") return { x: this.state.x, y: this.state.y };
    if (name === "rotation") return this.state.rotation;
    if (name === "zoom") return this.state.zoom;
    return super.getVariable(name);
  }
}

/**
 * The session's one Scene Camera Manager: what the main Scene's view looks
 * through. Its Layer Camera, Camera Actor and Camera Component are read live
 * by the runtime; it stores nothing itself. Scene Layers never use it.
 */
export class SceneCameraManager extends EngineObject {
  constructor() {
    super({ classId: SCENE_CAMERA_MANAGER_CLASS_ID, guid: "scene-camera-manager" });
  }
}

export class SceneLayer extends EngineObject {
  assetGuid: string;
  zOrder: number;
  ownerSceneGuid: string | null;
  /** Its asset's canvas: how its design canvas is sized and how Play scales it. */
  canvas: SceneLayerCanvasDesign;
  /** Its actors and SceneLayerScript keep ticking while the game is paused, whatever their own Tick On Pause. */
  tickOnPause: boolean;
  /** Its Play camera: every instance starts on the asset's Camera Location and scripts move it. */
  readonly camera: LayerCamera;

  constructor(options: {
    classId?: string;
    guid?: Guid;
    guidFactory?: GuidFactory;
    assetGuid: string;
    zOrder: number;
    ownerSceneGuid?: string | null;
    canvas?: SceneLayerCanvasDesign;
    cameraLocation?: readonly [number, number] | null;
    tickOnPause?: boolean;
    variables?: Record<string, unknown>;
    hooks?: LifecycleHooks;
  }) {
    super({
      classId: options.classId ?? "SceneLayer",
      guid: options.guid,
      guidFactory: options.guidFactory,
      variables: options.variables,
      hooks: options.hooks,
    });
    this.assetGuid = options.assetGuid;
    this.zOrder = options.zOrder;
    this.ownerSceneGuid = options.ownerSceneGuid ?? null;
    this.tickOnPause = options.tickOnPause === true;
    this.canvas = normalizeSceneLayerCanvasDesign(options.canvas);
    this.camera = new LayerCamera(this, options.cameraLocation);
  }
}

export class Scene extends EngineObject {
  assetGuid: string;
  postProcessStack: ScenePostProcessEntry[];
  /** The Layer Camera Play looks through while no camera actor is possessed; starts on the Scene's Layer Camera Location. */
  readonly camera: LayerCamera;

  constructor(options: {
    classId?: string;
    guid?: Guid;
    guidFactory?: GuidFactory;
    assetGuid: string;
    sceneName: string;
    postProcessStack?: ScenePostProcessEntry[];
    cameraLocation?: readonly [number, number] | null;
    variables?: Record<string, unknown>;
    hooks?: LifecycleHooks;
  }) {
    super({
      classId: options.classId ?? sceneAssetClassId(options.assetGuid),
      guid: options.guid,
      guidFactory: options.guidFactory,
      variables: {
        sceneName: options.sceneName,
        assetGuid: options.assetGuid,
        ...options.variables,
      },
      hooks: options.hooks,
    });
    this.assetGuid = options.assetGuid;
    this.postProcessStack = normalizeScenePostProcessStack(options.postProcessStack);
    this.camera = new LayerCamera(this, options.cameraLocation);
  }
}

const SCENE_LAYER_POST_PROCESSING_CLASS_ID = "SceneLayerPostProcessing";

/**
 * The session's Scene Layer post-processing: one pass stack every Scene Layer shares. Every layer draws into one
 * transparent target, these passes run over it, and the result is blended over the world. It starts from the
 * Project Setting and lives as long as the session, across Scene changes, as Scene Layers can; scripts add and
 * remove passes with Register and Unregister Scene Layer Post-Processing.
 */
export class SceneLayerPostProcessing extends EngineObject {
  /** Passes in draw order; each has an Entry ID and none is Scalable (layers draw at full resolution). */
  postProcessStack: ScenePostProcessEntry[] = [];

  constructor() {
    super({ classId: SCENE_LAYER_POST_PROCESSING_CLASS_ID, guid: "scene-layer-post-processing" });
  }
}

/** What owns post-process passes: the main Scene's own stack, or the Scene Layer stack every layer shares. */
export type PostProcessOwner = Scene | SceneLayerPostProcessing;

/** A pass reference shares the reflected MaterialObject type without inventing a mesh owner. */
export class PostProcessMaterialObject extends EngineObject {
  readonly targetKind = "postProcess" as const;
  readonly materialAssetGuid: string;
  readonly owner: PostProcessOwner;
  readonly entry: ScenePostProcessEntry;

  constructor(
    owner: PostProcessOwner,
    entry: ScenePostProcessEntry,
  ) {
    super({ classId: "MaterialObject" });
    this.owner = owner;
    this.entry = entry;
    this.materialAssetGuid = entry.materialGuid;
  }

  isCurrent(): boolean {
    return !this.destroyed && !this.owner.destroyed &&
      this.owner.postProcessStack.includes(this.entry) &&
      this.entry.materialGuid === this.materialAssetGuid;
  }
}

export type MaterialInstanceObject = MaterialObject | PostProcessMaterialObject;

const postProcessReferences = new WeakMap<PostProcessOwner, WeakMap<ScenePostProcessEntry, PostProcessMaterialObject>>();

/** Reordering preserves identity; removal/replacement invalidates references even if an ID is reused. */
export function getPostProcessMaterialObject(
  owner: PostProcessOwner,
  entryId: string,
): PostProcessMaterialObject | null {
  if (owner.destroyed) return null;
  const entry = owner.postProcessStack.find((candidate) => candidate.id === entryId);
  if (!entry) return null;
  let references = postProcessReferences.get(owner);
  const previous = references?.get(entry);
  if (previous?.isCurrent()) return previous;
  if (previous) previous.destroyed = true;
  if (!references) postProcessReferences.set(owner, references = new WeakMap());
  const reference = new PostProcessMaterialObject(owner, entry);
  references.set(entry, reference);
  return reference;
}

export class GameInstance extends EngineObject {
  private readonly gameHooks: GameInstanceHooks;
  /** Keeps ticking while the game is paused (`World.gamePaused`); from the Game Instance class defaults. */
  tickOnPause = false;

  constructor(
    options: {
      classId: string;
      guid?: Guid;
      guidFactory?: GuidFactory;
      variables?: Record<string, unknown>;
      hooks?: GameInstanceHooks;
      implementedInterfaces?: string[];
    },
  ) {
    super({
      ...options,
      hooks: options.hooks as LifecycleHooks | undefined,
    });
    this.gameHooks = options.hooks ?? {};
  }

  callOnGameEnd(): void {
    this.gameHooks.onGameEnd?.(this);
  }

  callOnSceneStartLoading(sceneName: string): void {
    this.gameHooks.onSceneStartLoading?.(this, sceneName);
  }

  callOnSceneFinishLoading(sceneName: string): void {
    this.gameHooks.onSceneFinishLoading?.(this, sceneName);
  }

  callOnFirstSceneLoaded(sceneName: string): void {
    this.gameHooks.onFirstSceneLoaded?.(this, sceneName);
  }

  callOnSceneExit(sceneName: string): void {
    this.gameHooks.onSceneExit?.(this, sceneName);
  }
}

type SubsystemOptions<H> = {
  classId: string;
  /** Fixed deterministic guid; subsystems never draw from a guid factory. */
  guid: Guid;
  variables?: Record<string, unknown>;
  hooks?: H;
  implementedInterfaces?: string[];
};

/**
 * Hidden abstract base of GameSubsystem and SceneSubsystem. `onCreation` is
 * the subsystem's On Init. Init and End each run at most once, and Init never
 * after End. The instance is `ended` from the moment End starts and
 * `destroyed` once it returns.
 */
export abstract class Subsystem extends EngineObject {
  private initStarted = false;
  private endStarted = false;

  constructor(options: SubsystemOptions<LifecycleHooks>) {
    super(options);
  }

  get ended(): boolean {
    return this.endStarted;
  }

  /** True once the World called On Init. */
  protected get initCalled(): boolean {
    return this.initStarted;
  }

  override callOnCreation(): void {
    if (this.initStarted || this.endStarted) return;
    this.initStarted = true;
    super.callOnCreation();
  }

  protected runEnd(end: () => void): void {
    if (this.endStarted) return;
    this.endStarted = true;
    try {
      end();
    } finally {
      this.destroyed = true;
    }
  }
}

/** Game Instance parity hooks; `onGameEnd` is the subsystem's On End. */
export type GameSubsystemHooks = Omit<LifecycleHooks<GameSubsystem>, "onDestroyed"> & {
  onGameEnd?: (self: GameSubsystem) => void;
  onSceneStartLoading?: (self: GameSubsystem, sceneName: string) => void;
  onSceneFinishLoading?: (self: GameSubsystem, sceneName: string) => void;
  onFirstSceneLoaded?: (self: GameSubsystem, sceneName: string) => void;
  onSceneExit?: (self: GameSubsystem, sceneName: string) => void;
};

/** Session-lifetime subsystem that wraps the Game Instance lifecycle. */
export class GameSubsystem extends Subsystem {
  private readonly gameHooks: GameSubsystemHooks;

  constructor(options: SubsystemOptions<GameSubsystemHooks>) {
    super({ ...options, hooks: options.hooks as LifecycleHooks | undefined });
    this.gameHooks = options.hooks ?? {};
  }

  /** On End, like the Game Instance's, even when `World.end()` ran before `start()`. */
  callOnGameEnd(): void {
    this.runEnd(() => this.gameHooks.onGameEnd?.(this));
  }

  callOnSceneStartLoading(sceneName: string): void {
    if (!this.ended) this.gameHooks.onSceneStartLoading?.(this, sceneName);
  }

  callOnSceneFinishLoading(sceneName: string): void {
    if (!this.ended) this.gameHooks.onSceneFinishLoading?.(this, sceneName);
  }

  callOnFirstSceneLoaded(sceneName: string): void {
    if (!this.ended) this.gameHooks.onFirstSceneLoaded?.(this, sceneName);
  }

  callOnSceneExit(sceneName: string): void {
    if (!this.ended) this.gameHooks.onSceneExit?.(this, sceneName);
  }
}

export type SceneSubsystemHooks = Omit<LifecycleHooks<SceneSubsystem>, "onDestroyed"> & {
  onEnd?: (self: SceneSubsystem) => void;
  onSceneLoaded?: (self: SceneSubsystem, sceneName: string) => void;
  onStreamedSceneLoaded?: (
    self: SceneSubsystem,
    streamingActor: SceneStreamingActor,
    scene: Scene,
  ) => void;
  onStreamedSceneUnloaded?: (
    self: SceneSubsystem,
    streamingActor: SceneStreamingActor,
    scene: Scene,
  ) => void;
  onSceneLayerAdded?: (self: SceneSubsystem, layer: SceneLayer) => void;
  onSceneLayerRemoved?: (self: SceneSubsystem, layer: SceneLayer) => void;
  onSceneActorSpawned?: (self: SceneSubsystem, actor: Actor) => void;
  onSceneActorDestroyed?: (self: SceneSubsystem, actor: Actor) => void;
};

/**
 * Lives with one main Scene object; notifications stop once End starts. The
 * World sends Actor Destroyed / Layer Removed only after this instance's
 * generation received that object's Spawned / Added.
 */
export class SceneSubsystem extends Subsystem {
  /** The main Scene this instance was created with. */
  readonly scene: Scene;
  private readonly sceneHooks: SceneSubsystemHooks;

  constructor(options: SubsystemOptions<SceneSubsystemHooks> & { scene: Scene }) {
    super({ ...options, hooks: options.hooks as LifecycleHooks | undefined });
    this.scene = options.scene;
    this.sceneHooks = options.hooks ?? {};
  }

  /**
   * On End, even when the host deferred its scripted On Init. Only an
   * instance retired before the World called its On Init (a sibling's On
   * Init replaced the Scene) ends silently.
   */
  callOnEnd(): void {
    this.runEnd(() => {
      if (this.initCalled) this.sceneHooks.onEnd?.(this);
    });
  }

  callOnSceneLoaded(sceneName: string): void {
    if (!this.ended) this.sceneHooks.onSceneLoaded?.(this, sceneName);
  }

  callOnStreamedSceneLoaded(streamingActor: SceneStreamingActor, scene: Scene): void {
    if (!this.ended) {
      this.sceneHooks.onStreamedSceneLoaded?.(this, streamingActor, scene);
    }
  }

  callOnStreamedSceneUnloaded(streamingActor: SceneStreamingActor, scene: Scene): void {
    if (!this.ended) {
      this.sceneHooks.onStreamedSceneUnloaded?.(this, streamingActor, scene);
    }
  }

  callOnSceneLayerAdded(layer: SceneLayer): void {
    if (!this.ended) this.sceneHooks.onSceneLayerAdded?.(this, layer);
  }

  callOnSceneLayerRemoved(layer: SceneLayer): void {
    if (!this.ended) this.sceneHooks.onSceneLayerRemoved?.(this, layer);
  }

  callOnSceneActorSpawned(actor: Actor): void {
    if (!this.ended) this.sceneHooks.onSceneActorSpawned?.(this, actor);
  }

  callOnSceneActorDestroyed(actor: Actor): void {
    if (!this.ended) this.sceneHooks.onSceneActorDestroyed?.(this, actor);
  }
}

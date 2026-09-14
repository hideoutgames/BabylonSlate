import {
  identityTransform,
  newGuid,
  normalizeScenePostProcessStack,
  type ScenePostProcessEntry,
  SCENE_LAYER_DEFAULT_LAYER_BOUNDS,
  type Guid,
  type InputKey,
  type GuidFactory,
  type Transform,
} from "@babylonslate/core";
import { sceneAssetClassId } from "./ids";

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
  setCursorVisible?: (visible: boolean) => void;
  setGamepadRumble?: (
    gamepadIndex: number,
    intensity: number,
    durationMs: number,
  ) => void;
  /** Connection transitions observed while resolving this tick. */
  gamepadConnections?: ReadonlyArray<{
    gamepadIndex: number;
    connected: boolean;
  }>;
};

export interface WorldLike {
  rngNextFloat(): number;
}

export type LifecycleHooks<T extends BObject = BObject> = {
  onCreation?: (self: T) => void;
  onTick?: (self: T, ctx: TickContext) => void;
  onDestroyed?: (self: T) => void;
};

export class BObject {
  readonly guid: Guid;
  readonly classId: string;
  readonly variables: Map<string, unknown>;
  implementedInterfaces: string[] = [];
  interfaceHandlers = new Map<
    string,
    (args: Record<string, unknown>) => Record<string, unknown>
  >();
  private readonly hooks: LifecycleHooks;
  destroyed = false;

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
    this.variables = new Map(Object.entries(options.variables ?? {}));
    this.hooks = options.hooks ?? {};
    this.implementedInterfaces = [...(options.implementedInterfaces ?? [])];
  }

  callOnCreation(): void {
    this.hooks.onCreation?.(this);
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

export class Actor extends BObject {
  transform: Transform;
  readonly components: ActorComponent[] = [];
  world: WorldLike | null = null;
  /** Stable spawn index assigned by World. */
  spawnIndex = -1;
  /** When false, skip script `onHit` for this actor. Physics still simulates. */
  generateHitEvents = true;
  /** When false, skip script begin/end overlap for this actor. */
  generateOverlapEvents = true;
  /** Owning overlay instance; null for world-scene actors. */
  sceneLayerId: Guid | null = null;

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
    },
  ) {
    super({
      ...options,
      hooks: options.hooks as LifecycleHooks | undefined,
    });
    this.transform = options.transform
      ? {
          position: { ...options.transform.position },
          rotation: { ...options.transform.rotation },
          scale: { ...options.transform.scale },
        }
      : identityTransform();
    this.sceneLayerId = options.sceneLayerId ?? null;
  }

  attachComponent(component: ActorComponent): void {
    if (component.owner) {
      throw new Error(`component ${component.guid} already attached`);
    }
    component.owner = this;
    this.components.push(component);
    component.callOnCreation();
  }
}

export class ActorComponent extends BObject {
  private materialObject: MaterialObject | null = null;
  logic: ComponentLogic | null = null;

  override callOnTick(ctx: TickContext): void {
    super.callOnTick(ctx);
    if (!this.destroyed) this.logic?.callOnTick(ctx);
  }

  override callOnDestroyed(): void {
    if (this.logic && !this.logic.destroyed) {
      this.logic.destroyed = true;
      this.logic.callOnDestroyed();
    }
    super.callOnDestroyed();
  }
  private materialRevision = 0;
  owner: Actor | null = null;
  /** Optional asset reference stub for engine components. */
  assetGuid: Guid | null = null;
  /** Prefab component id when Place Actors remapped `guid`. */
  sourceId: string | null = null;
  transform: Transform;
  parentId: string | null;

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
    },
  ) {
    super({
      ...options,
      hooks: options.hooks as LifecycleHooks | undefined,
    });
    this.assetGuid = options.assetGuid ?? null;
    this.sourceId =
      typeof options.sourceId === "string" && options.sourceId.trim()
        ? options.sourceId.trim()
        : null;
    this.parentId = options.parentId ?? null;
    this.transform = options.transform
      ? {
          position: { ...options.transform.position },
          rotation: { ...options.transform.rotation },
          scale: { ...options.transform.scale },
        }
      : identityTransform();
  }

  override getVariable(name: string): unknown {
    if (this.classId !== "MeshComponent" || name !== "materialObject") {
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
    if (this.classId === "MeshComponent") {
      if (name === "materialObject") return;
      if (name === "materialGuid" && value !== super.getVariable(name)) {
        if (this.materialObject) this.materialObject.destroyed = true;
        this.materialObject = null;
      }
    }
    super.setVariable(name, value);
  }
}

/** One authored logic instance owned by a Logic Component. */
export class ComponentLogic extends BObject {
  readonly component: ActorComponent;
  constructor(component: ActorComponent, options: ConstructorParameters<typeof BObject>[0]) {
    super(options);
    this.component = component;
  }
  override getVariable(name: string): unknown {
    return name === "component" ? this.component : super.getVariable(name);
  }
  override setVariable(name: string, value: unknown): void {
    if (name !== "component") super.setVariable(name, value);
  }
}

/** Engine-neutral reference to one mesh component's current material instance. */
export class MaterialObject extends BObject {
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
  onGameStart?: (self: GameInstance) => void;
  onGameEnd?: (self: GameInstance) => void;
  onSceneLoaded?: (self: GameInstance, sceneName: string) => void;
  onSceneStartLoading?: (self: GameInstance, sceneName: string) => void;
  onSceneFinishLoading?: (self: GameInstance, sceneName: string) => void;
  onFirstSceneLoaded?: (self: GameInstance, sceneName: string) => void;
  onSceneExit?: (self: GameInstance, sceneName: string) => void;
};

export class SceneLayer extends BObject {
  assetGuid: string;
  zOrder: number;
  ownerSceneGuid: string | null;
  postProcessStack: ScenePostProcessEntry[];
  layerBounds: { width: number; height: number };

  constructor(options: {
    classId?: string;
    guid?: Guid;
    guidFactory?: GuidFactory;
    assetGuid: string;
    zOrder: number;
    ownerSceneGuid?: string | null;
    postProcessStack?: ScenePostProcessEntry[];
    layerBounds?: { width: number; height: number };
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
    this.postProcessStack = normalizeScenePostProcessStack(options.postProcessStack);
    this.layerBounds = {
      width: options.layerBounds?.width && options.layerBounds.width > 0
        ? options.layerBounds.width
        : SCENE_LAYER_DEFAULT_LAYER_BOUNDS.width,
      height: options.layerBounds?.height && options.layerBounds.height > 0
        ? options.layerBounds.height
        : SCENE_LAYER_DEFAULT_LAYER_BOUNDS.height,
    };
  }
}

export class Scene extends BObject {
  assetGuid: string;
  postProcessStack: ScenePostProcessEntry[];

  constructor(options: {
    classId?: string;
    guid?: Guid;
    guidFactory?: GuidFactory;
    assetGuid: string;
    sceneName: string;
    postProcessStack?: ScenePostProcessEntry[];
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
  }
}

/** A pass reference shares the reflected MaterialObject type without inventing a mesh owner. */
export class PostProcessMaterialObject extends BObject {
  readonly targetKind = "postProcess" as const;
  readonly materialAssetGuid: string;
  readonly owner: Scene | SceneLayer;
  readonly entry: ScenePostProcessEntry;

  constructor(
    owner: Scene | SceneLayer,
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

const postProcessReferences = new WeakMap<Scene | SceneLayer, WeakMap<ScenePostProcessEntry, PostProcessMaterialObject>>();

/** Reordering preserves identity; removal/replacement invalidates references even if an ID is reused. */
export function getPostProcessMaterialObject(
  owner: Scene | SceneLayer,
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

export class GameInstance extends BObject {
  private readonly gameHooks: GameInstanceHooks;

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

  callOnGameStart(): void {
    this.gameHooks.onGameStart?.(this);
  }

  callOnGameEnd(): void {
    this.gameHooks.onGameEnd?.(this);
  }

  callOnSceneLoaded(sceneName: string): void {
    this.gameHooks.onSceneLoaded?.(this, sceneName);
  }

  callOnSceneStartLoading(sceneName: string): void {
    this.gameHooks.onSceneStartLoading?.(this, sceneName);
  }

  callOnSceneFinishLoading(sceneName: string): void {
    this.gameHooks.onSceneFinishLoading?.(this, sceneName);
    this.gameHooks.onSceneLoaded?.(this, sceneName);
  }

  callOnFirstSceneLoaded(sceneName: string): void {
    this.gameHooks.onFirstSceneLoaded?.(this, sceneName);
  }

  callOnSceneExit(sceneName: string): void {
    this.gameHooks.onSceneExit?.(this, sceneName);
  }
}

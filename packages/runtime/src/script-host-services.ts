import type {
  AssetLoadHandleState,
  InputTypeValue,
  InputValueState,
  RenderTargetMode,
  RuntimeAssetLoadState,
  RuntimeAssetPreloadOptions,
  RuntimeAssetPreloadResult,
  SaveGameService,
  ScalabilityRequest,
  ScalabilityResult,
  ScalabilitySnapshot,
  SceneLayerCamera,
  SceneStreamingState,
  WaterSample,
} from "@haptic/core";
import type { MaterialParameterValue } from "@haptic/bridge";
import type {
  Actor,
  ActorComponent,
  ClassRegistry,
  EngineObject,
  InterfaceRegistry,
  MaterialInstanceObject,
  PostProcessMaterialObject,
  Scene,
  SceneLayer,
} from "@haptic/object-model";
import type {
  ColliderShape,
  HitResult,
  LineTraceOptions,
  OverlapResult,
  PhysicsTransform,
  TeleportOptions,
  Vec3,
} from "@haptic/physics";
import type { InputBindingControls } from "@haptic/input";
import type { EditorDataApi } from "@haptic/scripting";
import type { RuntimeAssetCatalog } from "./asset-catalog";
import type { RuntimeDataApi } from "./data-catalog";
import type { LogSeverity } from "./log-ring";
import type { TweenRequest } from "./tween-runtime";

export type AnimGraphControl = {
  getVariable(name: string): unknown;
  setVariable(name: string, value: unknown): void;
  getCurrentState(): { id: string; name: string } | null;
  jumpToState(state: string): void;
};

export type ScriptColor = { x: number; y: number; z: number; w: number };

/** How a load handle settled: Loaded succeeds; a Failed handle carries its error. */
export type ScriptAssetLoadResult = Pick<RuntimeAssetPreloadResult, "success" | "errorMessage">;

/**
 * Engine services a compiled graph calls through `ctx`. The host implements the
 * subsystems that exist today; the rest are inert stubs so a graph that uses a
 * node from a later phase runs instead of throwing.
 */
export interface ScriptHostServices {
  saveGame?: SaveGameService;
  registerSaveActor?(actor: EngineObject, persistentId?: string): void;
  getSaveActorId?(actor: Actor): string;
  resolveSaveActor?(id: string): Actor | undefined;
  /** Read-only session data, shared by runtime and editor utility graphs. */
  data?: RuntimeDataApi;
  /** Explicit editor-only capability; absent in every game runtime. */
  editorData?: EditorDataApi;
  /** Session seed shared with the world and trace metadata. */
  seed?: number;
  /** Whether an object may receive authored calls during its owner's load. */
  canRunOwner?(owner: EngineObject): boolean;
  inputBindings?: InputBindingControls;
  getInputState?: (input: InputTypeValue) => InputValueState | null;
  getProjectName?(): string;
  getProjectVersion?(): string;
  /** The game's third-party notices text; rejects when the host has none or cannot read them. */
  getThirdPartyNotices?(): Promise<string>;
  /** When set, `ctx.callInterface` uses P3 dispatch (pin defaults on miss). */
  interfaceRegistry?: InterfaceRegistry;
  /** Live-object `ctx.isA` uses ClassRegistry ancestry, not string equality. */
  classRegistry?: ClassRegistry;
  /** World actors in deterministic spawn order for class queries. */
  getActors?(): readonly Actor[];
  /** Live Scene instance for the active Play scene, if any. */
  getSceneReference?(owner?: EngineObject | null): Scene | null;
  /**
   * `Get <Subsystem>`: the live (never ended) GameSubsystem, or the current
   * main Scene's SceneSubsystem, whose class isA `classId`. Compiled graphs
   * call it at every use, so it must be cheap and side-effect free. Hosts
   * without subsystems (Editor Utility) omit it and the node reads null.
   */
  getSubsystem?(classId: string): EngineObject | null;
  /** `Get Game Instance`: the session Game Instance, if the host has one. */
  getGameInstance?(): EngineObject | null;
  /**
   * The packaged asset list the Asset Registry nodes query. Read each time a
   * graph touches `ctx.assetRegistry`, so a host may rebuild it when its
   * source changes. Hosts without one answer every query with nothing.
   */
  getAssetCatalog?(): RuntimeAssetCatalog | null;
  getTargetSceneName?(target: unknown): string;
  loadScene?(target: unknown, blocking: boolean): Promise<void>;
  unloadScene?(target: unknown, blocking: boolean): Promise<void>;
  /** A consumer's on-demand load of cold assets; `releaseAcquiredAssets` ends its ownership. */
  acquireAssets?(assets: readonly string[], owner: EngineObject | null): Promise<RuntimeAssetPreloadResult>;
  releaseAcquiredAssets?(preloadId: string): void;
  prepareAssets?(assets: readonly string[], owner: EngineObject | null): Promise<void>;
  /** The host-published state of one asset. */
  getAssetLoadState?(assetGuid: string): RuntimeAssetLoadState;
  /**
   * Load handles scripts request, wait on, query and release. A host that
   * omits them fails every load with an "unavailable in this host" error.
   */
  requestAssetLoad?(assets: readonly string[], owner: EngineObject | null, options?: RuntimeAssetPreloadOptions): string;
  requestClassLoad?(classId: string, owner: EngineObject | null, options?: RuntimeAssetPreloadOptions): string;
  /** A blocking wait holds the simulation (like Load Scene Blocking) until the handle settles. */
  waitForAssetLoad?(handle: string, owner: EngineObject | null, blocking: boolean): Promise<ScriptAssetLoadResult>;
  releaseAssetLoad?(handle: string): void;
  unloadAsset?(assetGuid: string, owner: EngineObject | null, options?: Pick<RuntimeAssetPreloadOptions, "sessionWide">): void;
  getAssetLoadHandleState?(handle: string): AssetLoadHandleState;
  getAssetLoadHandleProgress?(handle: string): number;
  isSceneLoaded?(target: unknown): boolean;
  getSceneLoadProgress?(target: unknown): number;
  getSceneState?(target: unknown): SceneStreamingState;
  resolveInstanceId?(owner: EngineObject | null, id: string): string;
  waitForSimulation?(owner: EngineObject | null): Promise<void>;
  /** Scene load progress in 0..1. */
  getSceneLoadingProgress?(): number;
  log(severity: LogSeverity, category: string, message: string): void;
  /** A failed Assert node: an error for the node that ran it. Without it, the failure is an Error log. */
  assertFailed?(message: string): void;
  addComponent?(
    actor: Actor | null | undefined,
    classId: string,
    transform?: unknown,
  ): unknown;
  animGraphControl?(target: unknown): AnimGraphControl | null;
  spawnActor?(classId: string, transform?: unknown, owner?: EngineObject | null): Actor | null;
  spawnActorAsync?(classId: string, transform?: unknown, owner?: EngineObject | null): Promise<Actor | null>;
  /** Emit a bone attachment (or detach with a null target); false when the renderer cannot address either actor. */
  attachToBone?(actor: Actor, target: Actor | null, boneName: string): boolean;
  print(
    message: string,
    key: string,
    duration: number,
    color: ScriptColor,
  ): void;
  drawDebug?(payload: Record<string, unknown>): void;
  /** False strips Line Trace's debug lines whatever `drawDebug` says; true when omitted. */
  traceDebugDraw?: boolean;
  setCursorVisible?(visible: boolean): void;
  destroyActor(actor: Actor | null | undefined): void;
  executeConsoleCommand(command: string): { success: boolean; output: string };
  executeConsoleCommandAsync?(command: string): Promise<{ success: boolean; output: string }>;
  delay(seconds: number, owner?: EngineObject | null): Promise<void>;
  tween?(request: TweenRequest): Promise<boolean>;
  isTweenSessionActive?(): boolean;
  reportError(error: unknown): void;
  /** Debugger loop guard; omitted in release players. */
  checkInfiniteLoop?(): void;
  /**
   * Resolve a backend physics actor id to a live Actor. Missing / destroyed
   * actors must return undefined so query nodes never surface string ids.
   */
  findActor?(actorId: string): Actor | undefined;
  /*
   * Scene queries take the object whose script calls them (`caller`: the
   * actor, component or Scene Layer running the script, null outside one) so
   * the host can answer from that object's physics world.
   */
  sampleWater?(position: Vec3, actorId: string | null, caller?: EngineObject | null): WaterSample & { actorId: string | null };
  lineTrace?(start: Vec3, end: Vec3, options?: LineTraceOptions & { channel?: string }, caller?: EngineObject | null): HitResult;
  projectCursorToScene?(
    channel?: string,
    options?: { drawDebug?: boolean; duration?: number },
    caller?: EngineObject | null,
  ): HitResult & {
    worldOrigin: Vec3;
    worldDirection: Vec3;
  };
  projectTouchToScene?(
    finger: number,
    channel?: string,
    options?: { drawDebug?: boolean; duration?: number },
    caller?: EngineObject | null,
  ): HitResult & {
    worldOrigin: Vec3;
    worldDirection: Vec3;
  };
  sphereOverlap?(center: Vec3, radius: number, channel?: string, caller?: EngineObject | null): OverlapResult;
  shapeSweep?(
    shape: ColliderShape,
    start: PhysicsTransform,
    end: PhysicsTransform,
    channel?: string,
    caller?: EngineObject | null,
  ): HitResult;
  addImpulse?(
    actor: Actor | null | undefined,
    impulse: Vec3,
    strength?: number,
  ): void;
  moveCharacter?(
    actor: Actor | null | undefined,
    translation: Vec3,
    dt: number,
    offset?: number,
  ): void;
  /** Publish an explicit authored transform to its owning physics world. */
  teleportActor?(actor: Actor, options?: TeleportOptions): void;
  changeScene?(scene: string): void;
  createSceneLayer?(
    assetGuid: string,
    zOrder?: number,
  ): SceneLayer | null;
  createSceneLayerAsync?(assetGuid: string, zOrder: number, owner: EngineObject | null): Promise<SceneLayer | null>;
  removeSceneLayer?(layerGuid: string): void;
  clearSceneLayers?(): void;
  switchSceneLayerActor?(target: unknown, index: unknown): Actor | null;
  getCurrentSceneLayerActor?(target: unknown): Actor | null;
  setFocusTarget?(target: unknown): boolean;
  clearFocusTarget?(target: unknown): void;
  registerSceneLayerPostProcess?(
    layerGuid: string,
    materialGuid: string,
  ): void;
  unregisterSceneLayerPostProcess?(
    layerGuid: string,
    materialGuid: string,
  ): void;
  /** A live Scene Layer instance's camera; null once the layer is gone. */
  getSceneLayerCamera?(layerGuid: string): SceneLayerCamera | null;
  /** Change any of a layer camera's centre, roll and zoom; values that are not finite numbers keep the current ones. */
  setSceneLayerCamera?(layerGuid: string, changes: { x?: unknown; y?: unknown; rotation?: unknown; zoom?: unknown }): void;
  /** The live Scene Layer an actor (or a component's actor) belongs to; null for world actors. */
  getOwningSceneLayer?(target: EngineObject | null): SceneLayer | null;
  playSound?(
    asset: string,
    volume?: number,
    options?: {
      emitterActorGuid?: string | null;
      loop?: boolean;
      voiceId?: string;
    },
  ): void;
  stopSound?(voiceId: string): void;
  setParticlePlaying?(
    actorGuid: string,
    playing: boolean,
    componentId?: string,
  ): void;
  setChannelVolume?(channelGuid: string, volume: number): void;
  setGlobalVolume?(volume: number): void;
  getScalability?(): ScalabilitySnapshot | null;
  requestScalability?(request: ScalabilityRequest): ScalabilityResult;
  setMaterialParameter?(
    material: MaterialInstanceObject,
    parameterName: string,
    parameter: MaterialParameterValue,
  ): void;
  getPostProcessEntry?(owner: Scene | SceneLayer, entryId: string): PostProcessMaterialObject | null;
  getMaterialParameter?(material: MaterialInstanceObject, name: string, kind: MaterialParameterValue["kind"]): MaterialParameterValue | null;
  resetMaterialParameter?(material: MaterialInstanceObject, name: string, kind: MaterialParameterValue["kind"]): boolean;
  possessCamera?(target: unknown): void;
  getRenderTargetMode?(guid: string): RenderTargetMode;
  getRenderTargetTextureTarget?(guid: string): string | null;
  captureRenderTarget?(target: Actor): void;
  recaptureReflectionProbes?(): void;
  updateIllumination?(target: unknown): void;
  paint2D?(component: ActorComponent, operation: string, args: Record<string, unknown>): boolean;
  uiControlFunction?(component: ActorComponent, name: string, args: Record<string, unknown>): boolean;
  text2DAppear?(component: ActorComponent, operation: "triggerAppear" | "play" | "playReverse"): void;
  text2DAppearProgress?(component: ActorComponent): number;
  refreshComponent?(component: ActorComponent, propertyName?: string): void;
  dynamicMeshFunction?(component: ActorComponent, name: string, args: Record<string, unknown>): Record<string, unknown>;
  movementFunction?(component: ActorComponent, name: string, args: Record<string, unknown>): Record<string, unknown>;
  /** Apply live world-scene gravity from a Scene Gravity Set. */
  setWorldGravity?(gravity: { x: number; y: number; z: number }): void;
  findPathTo?(
    from: Vec3,
    to: Vec3,
  ): Vec3[];
  moveTo?(actor: Actor | null | undefined, destination: Vec3): void;
  stopMovement?(actor: Actor | null | undefined): void;
  isPathValid?(from: Vec3, to: Vec3): boolean;
  getClosestNavigablePoint?(point: Vec3): Vec3 | null;
  getRandomPointInRadius?(center: Vec3, radius: number): Vec3 | null;
  addObstacle?(kind: string, pose: Vec3, size: Vec3): string;
  removeObstacle?(id: string): void;
}

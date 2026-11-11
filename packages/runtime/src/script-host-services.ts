import type { CurveAssetCatalogEntry, GameEnvironment, GlobalParameterType } from "@haptic/core";
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
  LayerCamera,
  MaterialInstanceObject,
  PostProcessMaterialObject,
  Scene,
  SceneCameraManager,
  SceneLayer,
  TimelineClipInstance,
  TimelineClipObject,
  TimelineObject,
  WorldInputProvider,
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
import type { RegisteredPostProcess } from "./scene-post-process";

export type AnimGraphControl = {
  getVariable(name: string): unknown;
  setVariable(name: string, value: unknown): void;
  getCurrentState(): { id: string; name: string } | null;
  jumpToState(state: string): void;
};

export type ScriptColor = { x: number; y: number; z: number; w: number };

/** How a load handle settled: Loaded succeeds; a Failed handle carries its error. */
export type ScriptAssetLoadResult = Pick<RuntimeAssetPreloadResult, "success" | "errorMessage">;
/** `blocking`: Spawn Actor (Blocking) and Spawn Actor Deferred (Blocking) hold the simulation while the Class prepares. */
export type SpawnActorOptions = { blocking?: boolean };

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
  /** Curve assets of the current sources, by guid; a missing entry means the asset is not loaded. */
  curves?: ReadonlyMap<string, CurveAssetCatalogEntry>;
  /** Explicit editor-only capability; absent in every game runtime. */
  editorData?: EditorDataApi;
  /** Session seed shared with the world and trace metadata. */
  seed?: number;
  /** Whether an object may receive authored calls during its owner's load. */
  canRunOwner?(owner: EngineObject): boolean;
  inputBindings?: InputBindingControls;
  getInputState?: (input: InputTypeValue) => InputValueState | null;
  /**
   * The session's device input: cursor, touches, keys, motion, rumble and vibration. A script reads it
   * from any call, not only one a tick dispatched.
   */
  input?: WorldInputProvider;
  getProjectName?(): string;
  getProjectVersion?(): string;
  /** Project Settings > Export > App Identity > Build Number of the running project or package. */
  getBuildNumber?(): number;
  /** The simulation step the current tick captured (fixed step × time dilation). Absent outside a simulation. */
  getDeltaSeconds?(): number;
  /** Frames finished since the session started. Absent outside a simulation. */
  getFrameCount?(): number;
  getTimeDilation?(): number;
  /** Clamped to 0..8 like `slomo`; applies from the next tick. */
  setTimeDilation?(rate: number): void;
  getGameTimeSeconds?(): number;
  getRealTimeSeconds?(): number;
  /** Set Game Paused: from the next tick only what ticks on pause runs. Absent outside a simulation. */
  setGamePaused?(paused: boolean): void;
  isGamePaused?(): boolean;
  /** Quit Game: end the session as the `quit` console command does. Absent where nothing can end. */
  quitGame?(): void;
  /** Where the session runs; `DEFAULT_GAME_ENVIRONMENT` when absent. */
  environment?: GameEnvironment;
  /** Gameplay Extension libraries, evaluated with the first script load; compiled modules see them as `extensions`. */
  extensionLibraries?: readonly import("@haptic/core").ExtensionGameLibrary[];
  /** The game view's size in CSS pixels, the space cursor and touch positions use. */
  getViewportSize?(): { width: number; height: number };
  /** Ask the host to write the clipboard; validated text only. */
  copyToClipboard?(text: string): void;
  /** Ask the host to open an http or https address the member already validated. */
  openUrl?(url: string): void;
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
  /** A blocking wait holds the simulation (like Load Scene (Blocking)) until the handle settles. */
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
  /** Create Object: a collectable instance of a plain Object class, or null. */
  createObject?(classId: string): EngineObject | null;
  /** Collect Garbage: request a collection pass at the end of the tick. */
  collectGarbage?(): void;
  spawnActorAsync?(classId: string, transform?: unknown, owner?: EngineObject | null, options?: SpawnActorOptions): Promise<Actor | null>;
  /** Spawn Actor Deferred: the prepared actor outside the World, without Begin Play, until `finishDeferredSpawn`. */
  beginDeferredSpawnAsync?(classId: string, transform?: unknown, owner?: EngineObject | null, options?: SpawnActorOptions): Promise<Actor | null>;
  /** Finish Deferred Spawn Actor: spawns a `beginDeferredSpawnAsync` actor, running its Begin Play; null when it was discarded. */
  finishDeferredSpawn?(actor: Actor): Actor | null;
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
  /** A `TickWait` in a simulation, which resumes its graph inside the tick the wait ends in. */
  delay(seconds: number, owner?: EngineObject | null): PromiseLike<void>;
  /** Resolves in the next tick, counted like `delay` while the owner may run. */
  delayOneTick?(owner?: EngineObject | null): PromiseLike<void>;
  /** Restarts `key`'s wait for `owner`; the earlier wait rejects with a `retriggered` cancellation. */
  retriggerableDelay?(key: string, seconds: number, owner?: EngineObject | null): PromiseLike<void>;
  /** Set Timer By Event and the Timer Handle nodes (`ScriptTimers`). */
  timers?: import("./runtime-host-timing").ScriptTimerService;
  tween?(request: TweenRequest): PromiseLike<boolean>;
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
    options?: LineTraceOptions & { channel?: string },
    caller?: EngineObject | null,
  ): HitResult;
  /**
   * Every actor along a line (`shape` null) or a linear shape sweep, nearest first, one hit per actor, at most
   * `MAX_MULTI_TRACE_HITS`.
   */
  multiTrace?(
    shape: ColliderShape | null,
    start: PhysicsTransform,
    end: PhysicsTransform,
    options?: LineTraceOptions & { channel?: string },
    caller?: EngineObject | null,
  ): HitResult[];
  /** Actors whose shapes `shape` at `pose` overlaps, nearest first. */
  shapeOverlap?(
    shape: ColliderShape,
    pose: PhysicsTransform,
    options?: LineTraceOptions & { channel?: string },
    caller?: EngineObject | null,
  ): OverlapResult;
  addImpulse?(
    actor: Actor | null | undefined,
    impulse: Vec3,
    strength?: number,
  ): void;
  /** A world impulse at a world point on the actor's body. */
  addImpulseAtPoint?(actor: Actor, impulse: Vec3, point: Vec3): void;
  /** The actor's body velocity at its center of mass (angular in radians/second); null without a body. */
  physicsVelocity?(actor: Actor): { linear: Vec3; angular: Vec3; centerOfMass: Vec3 } | null;
  /** Replace the supplied velocities of the actor's dynamic body (angular in radians/second). */
  setPhysicsVelocity?(actor: Actor, velocity: { linear?: Vec3; angular?: Vec3 }): void;
  setActorCollisionEnabled?(actor: Actor, enabled: boolean): void;
  isActorCollisionEnabled?(actor: Actor): boolean;
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
  /** A Scene or Scene Layer copy's Timeline Clip (`Get <Name> Timeline Clip`). */
  timelineClip?(owner: EngineObject | null, clipId: string): TimelineClipObject | null;
  /** A Timeline Clip control node (`timelineClip.play`, `timelineClip.setPosition`, ...). */
  timelineClipControl?(clip: TimelineClipObject, action: string, args: Record<string, unknown>): void;
  /** A Timeline Asset's Timeline object for the session (Get Timeline Object Reference From Timeline Asset). */
  timeline?(asset: unknown): TimelineObject | null;
  /** The Timeline's loaded scene clips, main Scene first; `only` picks one document's clip. */
  timelineClips?(timeline: TimelineObject, only?: { documentGuid: string; clipId: string }): TimelineClipObject[];
  /** A new instance of a clip asset on its Timeline (`Create <Name> Timeline Clip`). */
  createTimelineClip?(timeline: TimelineObject, assetGuid: string, inputs: Record<string, unknown>): TimelineClipObject | null;
  /** A Timeline Proxy node on a clip asset instance (Bind Actor or Component To Timeline Proxy, Unbind, Unbind All). */
  timelineProxy?(instance: TimelineClipInstance, action: string, proxyId: string, args: Record<string, unknown>): void;
  /** Get Timeline Proxy: the objects bound to the proxy, in bind order. */
  timelineProxyGet?(instance: TimelineClipInstance, proxyId: string): EngineObject[];
  getCurrentSceneLayerActor?(target: unknown): Actor | null;
  setFocusTarget?(target: unknown): boolean;
  clearFocusTarget?(target: unknown): void;
  registerSceneLayerPostProcess?(
    layerGuid: string,
    materialGuid: string,
  ): RegisteredPostProcess<SceneLayer> | null;
  unregisterSceneLayerPostProcess?(
    layerGuid: string,
    materialGuid: string,
  ): void;
  /** Register Scene Post-Processing on the current Scene. */
  registerScenePostProcess?(materialGuid: string): RegisteredPostProcess<Scene> | null;
  /** Unregister Scene Post-Processing on the current Scene. */
  unregisterScenePostProcess?(materialGuid: string): void;
  /**
   * Change any of a Layer Camera's centre, roll and zoom (a Scene Layer
   * instance's or the main Scene's); values that are not finite numbers keep
   * the current ones, and a destroyed camera ignores it.
   */
  setLayerCamera?(camera: LayerCamera, changes: { x?: unknown; y?: unknown; rotation?: unknown; zoom?: unknown }): void;
  /** The session's Scene Camera Manager. */
  getSceneCameraManager?(): SceneCameraManager | null;
  /** The main Scene's Layer Camera; null between Scenes. */
  getMainSceneCamera?(): LayerCamera | null;
  /** The possessed actor the main Scene's view looks through; null while its Layer Camera is in view. */
  getCameraActor?(): Actor | null;
  /** That actor's Camera component in view; null while the Layer Camera is in view. */
  getCameraComponent?(): ActorComponent | null;
  /** The live Scene Layer an actor (or a component's actor) belongs to; null for world actors. */
  getOwningSceneLayer?(target: EngineObject | null): SceneLayer | null;
  playSound?(
    asset: string,
    volume?: number,
    options?: {
      emitterActorGuid?: string | null;
      loop?: boolean;
      voiceId?: string;
      /** Play Sound At Location's fixed spatial position. */
      location?: { x: number; y: number; z: number } | null;
      /** Pitch multiplier on the Audio asset's pitch. */
      pitch?: number;
    },
  ): void;
  stopSound?(voiceId: string): void;
  /** Play Camera Shake and its handle nodes; ids from 1, 0 for no shake (`CameraShakes`). */
  cameraShakes?: {
    play(asset: unknown, options: {
      target?: string | null;
      scale?: unknown;
      world?: { epicenter: Vec3; inner: number; outer: number; falloff: number } | null;
    }): number;
    stop(id: number, immediately: boolean): void;
    stopAll(immediately: boolean, target?: string | null): void;
    setPaused(id: number, paused: boolean): void;
    setScale(id: number, scale: unknown): void;
    isPlaying(id: number): boolean;
    isPaused(id: number): boolean;
  };
  /** A new script voice id, `script:<n>`; `n` is the voice's Sound Handle Id. */
  scriptVoiceId?(): string;
  /** Sound Handle nodes over the session's live voices, by voice id. */
  soundVoices?: {
    isPlaying(voiceId: string): boolean;
    /** The play-call volume of a playing voice, 0 otherwise. */
    volume(voiceId: string): number;
    setVolume(voiceId: string, volume: number): void;
    setPitch(voiceId: string, pitch: number): void;
    /** Ramp to `to` over `seconds` of real time, from `from` or the current volume, then stop when `stopAtEnd`. */
    fade(voiceId: string, seconds: number, to: number, options?: { from?: number; stopAtEnd?: boolean }): void;
  };
  /** `restart`: Restart Particles, which cuts the run on screen whatever the component's Retrigger. */
  setParticlePlaying?(
    actorGuid: string,
    playing: boolean,
    componentId?: string,
    restart?: boolean,
  ): void;
  /** Spawn Particles At Location / Attached: a transient effect actor, or null when it cannot spawn. */
  spawnParticleEffect?(request: import("./runtime-particle-effects").ParticleEffectRequest, owner: EngineObject | null): Actor | null;
  /** Whether the component (or, without `componentId`, any ParticleComponent of the actor) is playing. */
  isParticlesPlaying?(actorGuid: string, componentId?: string): boolean;
  /** `count` extra particles from a playing ParticleComponent; `slot` -1 for every emitter slot. */
  emitParticleBurst?(actorGuid: string, count: number, slot: number, componentId?: string): void;
  /**
   * Sets a runtime parameter value on the actor's ParticleComponents (only `componentId` when
   * given) whose Particle System declares `name`. False when none does.
   */
  setParticleParameter?(actorGuid: string, name: string, value: readonly number[], componentId?: string): boolean;
  /** The first such component's value: runtime ?? override ?? default, sized to the parameter's type. */
  getParticleParameter?(actorGuid: string, name: string, componentId?: string): { found: boolean; value: number[] };
  /** Drops the runtime value, back to the component's override or the default. False when no System declares `name`. */
  resetParticleParameter?(actorGuid: string, name: string, componentId?: string): boolean;
  /**
   * Sets a Global Parameter Collection value for the session when `collection` declares `name`
   * with one of `types`, sized to its type. False (with one warning) otherwise.
   */
  setGlobalParameter?(collection: unknown, name: unknown, value: readonly number[], types: readonly GlobalParameterType[]): boolean;
  /** The value set this session, else the default; `found` false when it cannot be resolved. */
  getGlobalParameter?(collection: unknown, name: unknown, types: readonly GlobalParameterType[]): { found: boolean; value: number[] };
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
  possessCamera?(target: unknown, blend?: { seconds: number; curve: string }): void;
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

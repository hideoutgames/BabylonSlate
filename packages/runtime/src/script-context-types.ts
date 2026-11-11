import type {
  AssetLoadHandleState,
  AssetLoadStateName,
  CurveKind,
  DeviceMotionState,
  InputKey,
  InputTypeValue,
  InputValueState,
  RangeKind,
  RenderTargetCaptureProperty,
  RenderTargetMode,
  RuntimeAssetPreloadOptions,
  SaveGameInfo,
  SaveGameMigration,
  SaveGameMigrationData,
  SaveGameOptions,
  SaveGameResult,
  SaveGameValue,
  ScalabilityRequest,
  ScalabilityResult,
  ScalabilitySnapshot,
  SceneStreamingState,
  TouchInput,
  TweenValueType,
  CalendarDate,
  DevicePlatform,
  RandomDraw,
  RandomSeed,
  TagContainer,
  Transform,
  TimeOfDay,
  WaterSample,
} from "@haptic/core";
import type { ScriptBundleEntry } from "@haptic/bridge";
import type {
  Actor,
  ActorComponent,
  EngineObject,
  MaterialObject,
  PostProcessMaterialObject,
  Scene,
  SceneLayer,
  TimelineClipObject,
} from "@haptic/object-model";
import type { ColliderShape, OverlapResult, PhysicsTransform, TeleportOptions, Vec3 } from "@haptic/physics";
import type { AnimStateFacts } from "@haptic/anim-graph";
import type { ScriptLoopLocation } from "@haptic/debugger";
import type { InputBindingControls } from "@haptic/input";
import type { EditorDataApi } from "@haptic/scripting";
import type { ScriptAssetRegistry } from "./asset-catalog";
import type { RuntimeDataApi } from "./data-catalog";
import type { LogSeverity } from "./log-ring";
import type { CompiledModuleExports } from "./module-loader";
import type { ScriptBreakpoints } from "./script-breakpoints";
import type { ScriptDebugTrace } from "./script-debug";
import type { EventDelegate } from "./script-dispatchers";
import type { ScriptAssetLoadResult, ScriptColor, SpawnActorOptions } from "./script-host-services";
import type { TweenReference } from "./tween-runtime";

/** What is under a point of the game view: Project Cursor To Scene and Project Touch To Scene. */
export type ScreenProjection = {
  hit: boolean;
  location: Vec3 | null;
  normal: Vec3 | null;
  distance: number;
  actor: Actor | null;
  worldOrigin: Vec3;
  worldDirection: Vec3;
};

export interface ScriptContext {
  getSaveData<TData extends object = Record<string, SaveGameValue>>(): TData;
  /** `container` is the field's `"array"` or `"map"`; a Map field reads as a `Map` and is written from one. */
  getSaveField(fieldId: string, type?: string, container?: string): unknown;
  setSaveField(fieldId: string, value: unknown, type?: string, container?: string): void;
  newGame(): Promise<SaveGameResult<Record<string, SaveGameValue>>>;
  saveGame(options?: SaveGameOptions): Promise<SaveGameResult<SaveGameInfo>>;
  loadGame(options?: SaveGameOptions): Promise<SaveGameResult<SaveGameInfo>>;
  listSaves(options?: { profile?: string }): Promise<SaveGameResult<SaveGameInfo[]>>;
  deleteSave(options?: SaveGameOptions): Promise<SaveGameResult<void>>;
  registerSaveActor(actor: EngineObject | null, persistentId?: string): void;
  registerSaveMigration(fromVersion: number, migrate: SaveGameMigration | string): void;
  getSaveMigrationField(fieldId: string, type?: string, container?: string): unknown;
  setSaveMigrationField(fieldId: string, value: unknown, type?: string, container?: string): void;
  data: RuntimeDataApi;
  /** Cold data reads prepare their owner-scoped source before returning copied values. */
  readDataEntryAsync(tree: string, path: string, definitionGuid?: string): Promise<Record<string, unknown> | null>;
  editorData: EditorDataApi;
  /** Asset Registry queries over the host's packaged asset catalog. */
  assetRegistry: ScriptAssetRegistry;
  inputBindings?: InputBindingControls;
  getInputState?: (input: InputTypeValue) => InputValueState | null;
  self: EngineObject | null;
  deltaSeconds: number;
  tickIndex: number;
  /**
   * The recorder of the instance the editor's graph debugger follows; null for every other
   * instance and outside the editor. Only debug-instrumented scripts read it.
   */
  debugTrace: ScriptDebugTrace | null;
  /** The session's node breakpoints; null when none are set. Only breakpoint-instrumented scripts read it. */
  breakpoints: ScriptBreakpoints | null;
  formatValue(value: unknown): string;
  checkInfiniteLoop(location?: ScriptLoopLocation): void;
  log(severity: LogSeverity, category: string, message: string): void;
  /**
   * A compiled node found null on an input it acts on and skipped itself. Logs `message` as an error
   * ("Hero: Destroy Actor (Target) tried to access null.") every time, and never throws.
   */
  nullAccess(message: string): void;
  /**
   * Compiled async entries register their locals while they run, so objects a
   * waiting Delay holds stay alive. Returns the function that ends the frame.
   */
  holdFrame(values: () => readonly unknown[]): () => void;
  /**
   * Create Object: a new object of a plain Object class, after its On Init
   * ran; null for any other class. It lives while a reference reaches it.
   */
  createObject(classId: unknown): EngineObject | null;
  /** Collect Garbage: a collection pass runs at the end of the current tick. */
  collectGarbage(): void;
  /**
   * An Assert node's check failed. Reports "Assertion failed: <message> (<detail>)" as an error for
   * the node every time, and never throws: the graph continues.
   */
  assertFailed(message: unknown, detail?: string): void;
  /** Assert Equal: reports a failure naming both values unless they are equal (`scriptValuesEqual`). */
  assertEqual(actual: unknown, expected: unknown, message: unknown): void;
  print(
    message: string,
    key: string,
    duration: number,
    color: ScriptColor,
  ): void;
  drawDebug(payload: Record<string, unknown>): void;
  getVariable(name: string): unknown;
  setVariable(name: string, value: unknown): void;
  variableReference(target: EngineObject | null | undefined, name: string, implicitSelf?: boolean): TweenReference | null;
  tweenValue(reference: TweenReference | null, type: TweenValueType, a: unknown, b: unknown, duration: number, curve: unknown): PromiseLike<boolean>;
  tweenProperty(target: unknown, property: string, type: TweenValueType, a: unknown, b: unknown, duration: number, curve: unknown, space?: unknown): PromiseLike<boolean>;
  getVariableFrom(target: EngineObject | null | undefined, name: string): unknown;
  setVariableOn(
    target: EngineObject | null | undefined,
    name: string,
    value: unknown,
  ): void;
  destroyActor(actor: EngineObject | null | undefined): void;
  setActorLocation(
    actor: EngineObject | null | undefined,
    location: { x: number; y: number; z: number },
  ): void;
  addActorWorldOffset(
    actor: EngineObject | null | undefined,
    offset: { x: number; y: number; z: number },
  ): void;
  setActorRotation(
    actor: EngineObject | null | undefined,
    rotation: { pitch: number; yaw: number; roll: number },
  ): void;
  setActorScale(
    actor: EngineObject | null | undefined,
    scale: { x: number; y: number; z: number },
  ): void;
  setActorTransform(
    actor: EngineObject | null | undefined,
    transform: {
      position?: { x: number; y: number; z: number };
      rotation?: { x: number; y: number; z: number; w: number };
      scale?: { x: number; y: number; z: number };
    } | null | undefined,
    options?: TeleportOptions,
  ): void;
  rotatorToQuat(
    rotator: { pitch?: number; yaw?: number; roll?: number } | null | undefined,
  ): { x: number; y: number; z: number; w: number };
  quatToRotator(
    quat: { x?: number; y?: number; z?: number; w?: number } | null | undefined,
  ): { pitch: number; yaw: number; roll: number };
  combineRotators(
    a: { pitch?: number; yaw?: number; roll?: number } | null | undefined,
    b: { pitch?: number; yaw?: number; roll?: number } | null | undefined,
  ): { pitch: number; yaw: number; roll: number };
  inverseRotator(
    rotator: { pitch?: number; yaw?: number; roll?: number } | null | undefined,
  ): { pitch: number; yaw: number; roll: number };
  deltaRotator(
    from: { pitch?: number; yaw?: number; roll?: number } | null | undefined,
    to: { pitch?: number; yaw?: number; roll?: number } | null | undefined,
  ): { pitch: number; yaw: number; roll: number };
  lerpRotator(
    a: { pitch?: number; yaw?: number; roll?: number } | null | undefined,
    b: { pitch?: number; yaw?: number; roll?: number } | null | undefined,
    alpha: number,
  ): { pitch: number; yaw: number; roll: number };
  rotatorForward(
    rotator: { pitch?: number; yaw?: number; roll?: number } | null | undefined,
  ): { x: number; y: number; z: number };
  rotatorRight(
    rotator: { pitch?: number; yaw?: number; roll?: number } | null | undefined,
  ): { x: number; y: number; z: number };
  rotatorUp(
    rotator: { pitch?: number; yaw?: number; roll?: number } | null | undefined,
  ): { x: number; y: number; z: number };
  lookAtRotator(
    from: { x?: number; y?: number; z?: number } | null | undefined,
    target: { x?: number; y?: number; z?: number } | null | undefined,
  ): { pitch: number; yaw: number; roll: number };
  multiplyQuats(
    a: { x?: number; y?: number; z?: number; w?: number } | null | undefined,
    b: { x?: number; y?: number; z?: number; w?: number } | null | undefined,
  ): { x: number; y: number; z: number; w: number };
  inverseQuat(
    quat: { x?: number; y?: number; z?: number; w?: number } | null | undefined,
  ): { x: number; y: number; z: number; w: number };
  slerpQuats(
    a: { x?: number; y?: number; z?: number; w?: number } | null | undefined,
    b: { x?: number; y?: number; z?: number; w?: number } | null | undefined,
    alpha: number,
  ): { x: number; y: number; z: number; w: number };
  quatRotateVector(
    quat: { x?: number; y?: number; z?: number; w?: number } | null | undefined,
    vector: { x?: number; y?: number; z?: number } | null | undefined,
  ): { x: number; y: number; z: number };
  normalizeQuat(
    quat: { x?: number; y?: number; z?: number; w?: number } | null | undefined,
  ): { x: number; y: number; z: number; w: number };
  /** Seeded PRNG surface — never Math.random. */
  random: {
    float(): number;
    int(min: number, max: number): number;
    bool(): boolean;
  };
  /** Random In Range nodes: draws from the seeded session RNG (integers inclusive, others from Min up to Max). */
  randomInRange(kind: RangeKind, range: unknown): unknown;
  /** Random Bool With Weight, Random Unit Vector, Random Array Item, Shuffle Array: from the global seed. */
  randomDraw(draw: RandomDraw, a?: unknown, b?: unknown): unknown;
  /**
   * Seeded Random nodes: draw from the Seed read through `reference` (else `seed`) and write it back moved on
   * by the values drawn, so the wired variable continues where the draw left off.
   */
  seededRandomDraw(reference: TweenReference | null, seed: unknown, draw: RandomDraw, a?: unknown, b?: unknown): unknown;
  /** Get Global Randomization Seed: the global seed and how many values the normal Random nodes have drawn. */
  getGlobalRandomSeed(): RandomSeed;
  /** Set Global Randomization Seed: the normal Random nodes continue from this Seed and Step. */
  setGlobalRandomSeed(seed: unknown): void;
  /** Get Step Count: the Seed's Step. */
  randomSeedStep(seed: unknown): number;
  /** Set Actor Hidden In Game: the actor's `visible`, which hides its components but not attached actors. */
  setActorHidden(actor: unknown, hidden: unknown): void;
  isActorHidden(actor: unknown): boolean;
  /** Set Visibility: the component's `visible` (and its attached components' with `propagate`), re-sent to the renderer. */
  setComponentVisible(component: unknown, visible: unknown, propagate: unknown): void;
  isComponentVisible(component: unknown): boolean;
  /** A component's transform relative to its parent component (or actor), or in the world; null when not live. */
  componentTransform(component: unknown, space: "relative" | "world"): Transform | null;
  /** Set a component's location (vec3), rotation (rotator), scale (vec3) or whole transform, relative or in the world. */
  setComponentTransform(component: unknown, channel: "position" | "rotation" | "scale" | "transform", value: unknown, space: "relative" | "world"): void;
  /** Get Distance To: between the two actors' world locations; 0 when either is missing. */
  actorDistance(a: unknown, b: unknown): number;
  addActorLocalOffset(actor: unknown, offset: Partial<Record<"x" | "y" | "z", unknown>> | null | undefined): void;
  addActorLocalRotation(actor: unknown, rotation: Partial<Record<"pitch" | "yaw" | "roll", unknown>> | null | undefined): void;
  addActorWorldRotation(actor: unknown, rotation: Partial<Record<"pitch" | "yaw" | "roll", unknown>> | null | undefined): void;
  /** Teleport: location and rotation at once, keeping or zeroing a physics body's velocity. */
  teleportActor(
    actor: unknown,
    location: Partial<Record<"x" | "y" | "z", unknown>> | null | undefined,
    rotation: Partial<Record<"pitch" | "yaw" | "roll", unknown>> | null | undefined,
    resetVelocity: unknown,
  ): void;
  /** The actor's Tags (`ACTOR_TAGS_PROPERTY`): its Class default, its placed override, or what scripts set. */
  getActorTags(actor: unknown): TagContainer;
  setActorTags(actor: unknown, tags: unknown): void;
  /** Get Class: the object's class id, or None. */
  getObjectClass(object: unknown): string | null;
  classIsChildOf(classId: unknown, parentClassId: unknown): boolean;
  /** Get Display Name: an actor's or component's name, else its class. */
  getDisplayName(object: unknown): string;
  /** Ease: Alpha clamped to 0..1 and shaped by an Easing Curve member (`sampleEasingCurve` in core). */
  easeAlpha(curve: unknown, alpha: unknown): number;
  /** Play Camera Shake: a shake of the main Scene's view, whichever camera is in view; `{ Id: 0 }` when none plays. */
  playCameraShake(asset: unknown, scale: unknown): { Id: number };
  /** Play Camera Shake On Scene Layer: a shake of the Scene Layer's own view. */
  playCameraShakeOnSceneLayer(layer: unknown, asset: unknown, scale: unknown): { Id: number };
  /** Play World Camera Shake: the main view's shake, strongest near Epicenter (`worldCameraShakeScale`). */
  playWorldCameraShake(asset: unknown, epicenter: unknown, innerRadius: unknown, outerRadius: unknown, falloff: unknown): { Id: number };
  /** Stop Camera Shake: blends it out, or ends it now with `immediately`. */
  stopCameraShake(handle: unknown, immediately: unknown): void;
  stopAllCameraShakes(immediately: unknown): void;
  setCameraShakePaused(handle: unknown, paused: boolean): void;
  setCameraShakeScale(handle: unknown, scale: unknown): void;
  isCameraShakePlaying(handle: unknown): boolean;
  isCameraShakePaused(handle: unknown): boolean;
  /** Stop Sound: stops the handle's voice at once. */
  stopSoundHandle(handle: unknown): void;
  /** Set Sound Volume: the voice's play-call volume, 0..1, cancelling a fade. */
  setSoundVolume(handle: unknown, volume: unknown): void;
  /** Set Sound Pitch: the voice's pitch multiplier on its Audio's pitch. */
  setSoundPitch(handle: unknown, pitch: unknown): void;
  /** Fade In Sound: from silent to `volume` over `seconds`. */
  fadeInSound(handle: unknown, seconds: unknown, volume: unknown): void;
  /** Fade Out Sound: to silent over `seconds`, then stops the voice. */
  fadeOutSound(handle: unknown, seconds: unknown): void;
  isSoundPlaying(handle: unknown): boolean;
  /** Get Physics Linear Velocity, or Angular Velocity In Degrees (`angular`): the body's, zero without one. */
  physicsVelocity(actor: unknown, angular: boolean): Vec3;
  /** Set Physics Linear Velocity, or Angular Velocity In Degrees (`angular`), optionally added to the current one. */
  setPhysicsVelocity(actor: unknown, angular: boolean, velocity: unknown, addToCurrent: unknown): void;
  /** Add Force: an impulse of force × `deltaSeconds` (this tick's game time). */
  addForce(actor: unknown, force: unknown, deltaSeconds: unknown): void;
  /** Add Torque: an angular impulse of torque × `deltaSeconds`, applied as an impulse couple about the center of mass. */
  addTorque(actor: unknown, torque: unknown, deltaSeconds: unknown): void;
  /** Set Motion Type: the actor's first Rigid Body's Motion Type, from a Motion Type enum member. */
  setMotionType(actor: unknown, motionType: unknown): void;
  /** Set Actor Enable Collision: while off, the actor's shapes block and overlap nothing and queries skip it. */
  setActorCollisionEnabled(actor: unknown, enabled: unknown): void;
  isActorCollisionEnabled(actor: unknown): boolean;
  /** Set Timer By Event: a timer owned by this context's object; `{ Id: 0 }` when Time is not above 0. */
  setTimer(delegate: unknown, time: unknown, looping: unknown, firstDelay: unknown): { Id: number };
  clearTimer(handle: unknown): void;
  setTimerPaused(handle: unknown, paused: boolean): void;
  timerExists(handle: unknown): boolean;
  isTimerActive(handle: unknown): boolean;
  isTimerPaused(handle: unknown): boolean;
  /** Seconds until the timer fires, or -1 for no timer. */
  timerRemaining(handle: unknown): number;
  /** Seconds since the timer's running interval began, or -1 for no timer. */
  timerElapsed(handle: unknown): number;
  clampToRange(kind: RangeKind, value: unknown, range: unknown): unknown;
  isInRange(kind: "int" | "float", value: unknown, range: unknown): boolean;
  lerpFloatRange(range: unknown, alpha: unknown): number;
  mapFloatRange(value: unknown, from: unknown, to: unknown, clamp: unknown): number;
  /** Evaluate <Type> Curve: keys in any order, Before and After extrapolation (`evaluateCurve` in core). */
  evaluateCurve(kind: CurveKind, curve: unknown, time: unknown): unknown;
  curveTimeRange(curve: unknown): { Min: number; Max: number };
  floatCurveValueRange(curve: unknown): { Min: number; Max: number };
  /**
   * Get <Type> Curve Object: the session's read-only object for a loaded curve asset of that kind, or
   * null while the asset is not loaded (or is another kind). One object per asset, never collected.
   */
  getCurveObject(kind: CurveKind, asset: unknown): EngineObject | null;
  /** Curve Object reads; a missing or other target reads as an empty curve of `kind`. */
  curveObjectValue(kind: CurveKind, target: unknown, time: unknown): unknown;
  curveObjectTimeRange(target: unknown): { Min: number; Max: number };
  curveObjectValueRange(target: unknown): { Min: number; Max: number };
  curveObjectKeyCount(target: unknown): number;
  /** Timeline Clip control nodes; they wait while the clip's Scene or Scene Layer cannot run. */
  timelineClipControl(target: unknown, action: string, args: Record<string, unknown>): void;
  /** Timeline Clip reads: Position, Length, Play Rate, Playing, Reversed. */
  timelineClipState(target: unknown, field: string): number | boolean;
  /** A Timeline Asset's Timeline object for the session, or null for no asset. */
  getTimeline(asset: unknown): EngineObject | null;
  /** One document's clip of the Timeline's asset, while that Scene or Scene Layer is loaded. */
  getTimelineClip(target: unknown, documentGuid: string, clipId: string): EngineObject | null;
  /** The Timeline's loaded scene clips. */
  getLoadedTimelineClips(target: unknown): EngineObject[];
  /** A new instance of one of the Timeline's clip assets, its connected proxies bound Relative; null when the asset is not in the game. */
  createTimelineClip(target: unknown, assetGuid: string, inputs: Record<string, unknown>): EngineObject | null;
  /** Bind (`args.object`, `args.absolute`), Unbind or Unbind All on a clip asset instance's proxies. */
  timelineProxy(target: unknown, action: string, proxyId: string, args: Record<string, unknown>): void;
  /** The objects bound to a clip asset instance's proxy, in bind order; empty while it is unbound. */
  timelineProxyGet(target: unknown, proxyId: string): EngineObject[];
  /** A copy of the asset's curve as a curve Structure value. */
  curveObjectCurve(kind: CurveKind, target: unknown): unknown;
  getAllActorsOfClass(classId: string): Actor[];
  getActorOfClass(classId: string): Actor | null;
  /** Live world components, including SceneLayers, in actor/component order. */
  getFirstComponentOfType(classId: string): ActorComponent | null;
  getAllComponentsOfType(classId: string): ActorComponent[];
  attachActor(
    child: EngineObject | null | undefined,
    parent: EngineObject | null | undefined,
  ): void;
  detachActor(child: EngineObject | null | undefined): void;
  attachToBone(
    actor: EngineObject | null | undefined,
    target: EngineObject | null | undefined,
    boneName: string,
  ): void;
  getParent(actor: EngineObject | null | undefined): Actor | null;
  /** The actor's `name` variable (an Actor has no `name` property); "" for a missing or non-actor target. */
  getActorName(actor: EngineObject | null | undefined): string;
  setOwner(
    actor: EngineObject | null | undefined,
    owner: EngineObject | null | undefined,
  ): void;
  getOwner(actor: EngineObject | null | undefined): Actor | null;
  executeConsoleCommand(command: string): { success: boolean; output: string };
  executeConsoleCommandAsync(command: string): Promise<{ success: boolean; output: string }>;
  delay(seconds: number): PromiseLike<void>;
  delayOneTick(): PromiseLike<void>;
  /** Waits `seconds` after this node's latest call for `self`; an earlier waiting call ends. */
  retriggerableDelay(nodeId: string, seconds: number): PromiseLike<void>;
  commandArgs: Record<string, unknown>;
  /** Alias of `commandArgs` so function Input nodes can read `ctx.args`. */
  args: Record<string, unknown>;
  reportCommand(success: boolean, output: string): void;
  callInterface(
    target: EngineObject | null | undefined,
    interfaceGuid: string,
    method: string,
    args?: Record<string, unknown>,
  ): unknown;
  getComponent(actor: EngineObject | null | undefined, classId: string): unknown;
  getComponentById(
    actor: EngineObject | null | undefined,
    componentId: string,
  ): unknown;
  /**
   * Get <Actor> in a SceneScript / SceneLayerScript: the live actor this Scene
   * or Scene Layer instance placed under the authored `actorId`, else null.
   */
  getOwnedActor(actorId: string): Actor | null;
  /** Get <Component> (<Actor>): that actor's component with the authored `componentId`, else null. */
  getOwnedComponent(actorId: string, componentId: string): ActorComponent | null;
  /** This Scene or Scene Layer copy's Timeline Clip with the authored clip id. */
  getOwnedTimelineClip(clipId: string): TimelineClipObject | null;
  callComponentFunction(
    target: EngineObject | null | undefined,
    name: string,
    args?: Record<string, unknown>,
  ): Record<string, unknown>;
  addComponent(
    actor: EngineObject | null | undefined,
    classId: string,
    transform?: unknown,
  ): unknown;
  spawnActor(classId: string, transform?: unknown): Actor | null;
  spawnActorAsync(classId: string, transform?: unknown, options?: SpawnActorOptions): Promise<Actor | null>;
  beginDeferredSpawnActorAsync(classId: string, transform?: unknown, options?: SpawnActorOptions): Promise<Actor | null>;
  finishDeferredSpawnActor(actor: unknown): Actor | null;
  isA(instance: unknown, classId: string): boolean;
  getSceneLoadingProgress(): number;
  getTargetSceneName(target: unknown): string;
  loadSceneAsync(target: unknown): void;
  unloadSceneAsync(target: unknown): void;
  loadSceneBlocking(target: unknown): Promise<void>;
  unloadSceneBlocking(target: unknown): Promise<void>;
  /**
   * Load handles (opaque strings) owned by the calling object, else the current
   * Scene, else the session (`sessionWide`). `requestAssetLoad` and
   * `requestClassLoad` return at once; the handle is Loading until the host
   * reports the required closure prepared. Defaults: Normal priority, not
   * session wide.
   */
  requestAssetLoad(assets: readonly string[], options?: RuntimeAssetPreloadOptions): string;
  requestClassLoad(classId: string, options?: RuntimeAssetPreloadOptions): string;
  /** Settles when the handle is Loaded or Failed; `blocking` holds the simulation until then. */
  waitForAssetLoad(handle: string, options?: { blocking?: boolean }): Promise<ScriptAssetLoadResult>;
  /** Cancels pending work and drops this handle's ownership; the handle then reads Released. */
  releaseAssetLoad(handle: string): void;
  /** Releases the calling owner's (or the session's) load handles that include the asset. */
  unloadAsset(asset: string, options?: Pick<RuntimeAssetPreloadOptions, "sessionWide">): void;
  getAssetLoadHandleState(handle: string): AssetLoadHandleState;
  /** 0 to 1, monotonic; 1 only when Loaded. */
  getAssetLoadHandleProgress(handle: string): number;
  getAssetLoadState(asset: string): AssetLoadStateName;
  isSceneLoaded(target: unknown): boolean;
  getSceneLoadProgress(target: unknown): number;
  getSceneState(target: unknown): SceneStreamingState;
  getProjectName(): string;
  getProjectVersion(): string;
  /** Get Delta Seconds: the current simulation step (fixed step × time dilation); 0 outside a simulation. */
  getDeltaSeconds(): number;
  /** Get Current Frame Count: frames finished since Play started; 0 outside a simulation. */
  getFrameCount(): number;
  /** Get Time Now: the engine Time Structure for the wall clock in UTC. */
  getTimeNow(): TimeOfDay;
  /** Get Date Now: the engine Date Structure for the wall clock in UTC. */
  getDateNow(): CalendarDate;
  /** Get Time In Milliseconds: Unix time in milliseconds. */
  getTimeMs(): number;
  /** Get Time Dilation: 1 is normal speed; 1 outside a simulation. */
  getTimeDilation(): number;
  /** Set Time Dilation: clamped to 0..8 like `slomo`; applies from the next tick. A non-number does nothing. */
  setTimeDilation(rate: unknown): void;
  /** Get Game Time In Seconds: dilated steps since the session started, including the current one. */
  getGameTimeSeconds(): number;
  /** Get Real Time In Seconds: the same steps without time dilation. */
  getRealTimeSeconds(): number;
  /** Get Local Time Now: the engine Time Structure in the device's time zone. */
  getLocalTimeNow(): TimeOfDay;
  /** Get Local Date Now: the engine Date Structure in the device's time zone. */
  getLocalDateNow(): CalendarDate;
  /** Set Game Paused: from the next step only what ticks on pause runs; the session keeps ticking. */
  setGamePaused(paused: unknown): void;
  /** Is Game Paused: the last Set Game Paused, even before the next step applies it. */
  isGamePaused(): boolean;
  /** Quit Game: ends the session after the current step, as the `quit` console command does. */
  quitGame(): void;
  getPlatform(): DevicePlatform;
  isTouchDevice(): boolean;
  isInEditor(): boolean;
  isDevelopmentBuild(): boolean;
  /** Get Viewport Size: the game view in CSS pixels; 0 × 0 where there is none. */
  getViewportSize(): { x: number; y: number };
  /** Get Locale: a BCP 47 tag such as `en-US` and its language, `en`. */
  getLocale(): { locale: string; language: string };
  /** Copy To Clipboard: best effort; the host may refuse. */
  copyToClipboard(text: unknown): void;
  /** Open URL: http and https only, anything else logs a warning; best effort, the host may refuse. */
  openUrl(url: unknown): void;
  /** New GUID: a new random identifier. */
  newGuid(): string;
  /** Get Third-Party Notices: the notices text, or an error message when they cannot be read. */
  getThirdPartyNotices(): Promise<{ success: boolean; text: string; errorMessage: string }>;
  getSceneReference(): Scene | null;
  /** Live subsystem whose class isA `classId`, or null (`Get <Subsystem>`). */
  getSubsystem(classId: string): EngineObject | null;
  /** The session Game Instance, or null in hosts without one. */
  getGameInstance(): EngineObject | null;
  getAnimGraphVariable(target: unknown, name: string): unknown;
  setAnimGraphVariable(target: unknown, name: string, value: unknown): void;
  getAnimGraphCurrentState(target: unknown): { id: string; name: string } | null;
  jumpAnimGraphState(target: unknown, state: string): void;
  invokeCustomEvent(
    target: EngineObject | null | undefined,
    eventName: string,
    args?: Record<string, unknown>,
  ): void;
  /**
   * Create Event and a custom event's Output Delegate: a delegate running the
   * custom event (`kind` "event") or function export `name` on `object`, whose
   * parameters are `params` in signature order. One value per object and
   * member, so Unbind finds what Bind added. Null without an object.
   */
  eventDelegate(
    object: unknown,
    name: string,
    kind: "event" | "function",
    params: readonly string[],
  ): EventDelegate | null;
  /** Bind Event To <Dispatcher>: adds `delegate` once to `owner`'s dispatcher `name`. */
  bindDispatcher(owner: unknown, name: string, delegate: unknown): void;
  /** Unbind Event From <Dispatcher>. */
  unbindDispatcher(owner: unknown, name: string, delegate: unknown): void;
  /** Unbind All Events From <Dispatcher>. */
  unbindAllDispatcher(owner: unknown, name: string): void;
  /**
   * Call <Dispatcher>: runs every event bound to `owner`'s dispatcher `name`
   * in bind order, each with `values` keyed by its own parameter names, in the
   * caller's frame like Call Custom Event. Latent work in a listener does not
   * hold the caller.
   */
  callDispatcher(owner: unknown, name: string, values: readonly unknown[]): void;
  /**
   * Run a compiled entry point on a specific classId (Call Parent Event).
   * Uses `self` as the receiver so parent graphs see the child instance.
   */
  invokeEvent(
    classId: string,
    eventName: string,
    args?: Record<string, unknown>,
  ): void;
  invokeFunction(
    target: EngineObject | string | null | undefined,
    functionName: string,
    args?: Record<string, unknown>,
  ): Record<string, unknown> | PromiseLike<Record<string, unknown>>;
  getPressedKeys?(): readonly InputKey[];
  getCursorPosition(): { x: number; y: number; pressed: boolean };
  /** This tick's contacts in Finger order, including those lifted this tick. */
  getTouches?(): readonly TouchInput[];
  /** This tick's Began, Moved, Ended and Cancelled records in input order. */
  getTouchEvents?(): readonly TouchInput[];
  /** Reading it starts the device's motion input (once per session). */
  getDeviceMotion?(): DeviceMotionState;
  calibrateTilt?(): void;
  setCursorVisible(visible: boolean): void;
  setGamepadRumble?(
    gamepadIndex: number,
    intensity: number,
    durationMs: number,
  ): void;
  vibrateDevice?(durationMs: number): void;
  gamepadConnections?: ReadonlyArray<{
    gamepadIndex: number;
    connected: boolean;
  }>;
  sampleWater(position: Vec3, waterActor?: Actor | null): WaterSample & { actor: Actor | null };
  lineTrace(
    start: Vec3,
    end: Vec3,
    channel?: string,
    options?: { drawDebug?: boolean; actorsToIgnore?: readonly (Actor | null)[] },
  ): {
    hit: boolean;
    location: Vec3 | null;
    normal: Vec3 | null;
    distance: number;
    actor: Actor | null;
  };
  projectCursorToScene(
    channel?: string,
    options?: { drawDebug?: boolean; duration?: number },
  ): ScreenProjection;
  projectTouchToScene(
    finger: number,
    channel?: string,
    options?: { drawDebug?: boolean; duration?: number },
  ): ScreenProjection;
  sphereOverlap(
    center: Vec3,
    radius: number,
    channel?: string,
  ): OverlapResult & { actors: Actor[] };
  shapeSweep(
    shape: ColliderShape,
    start: PhysicsTransform,
    end: PhysicsTransform,
    channel?: string,
    actorsToIgnore?: readonly (Actor | null)[],
  ): {
    hit: boolean;
    location: Vec3 | null;
    normal: Vec3 | null;
    distance: number;
    actor: Actor | null;
  };
  /** Multi Line Trace (`shape` null) and Multi Sphere Trace: Hit Result structures, nearest first, one per actor. */
  multiTrace(
    shape: ColliderShape | null,
    start: PhysicsTransform,
    end: PhysicsTransform,
    channel?: string,
    actorsToIgnore?: readonly (Actor | null)[],
  ): { Hit: boolean; Location: Vec3; Normal: Vec3; Actor: Actor | null; Distance: number }[];
  /** Box and Capsule Overlap Actors: the live actors `shape` at `pose` overlaps. */
  shapeOverlap(shape: ColliderShape, pose: PhysicsTransform, channel?: string): Actor[];
  addImpulse(
    actor: EngineObject | null | undefined,
    impulse: Vec3,
    strength?: number,
  ): void;
  moveCharacter(
    actor: EngineObject | null | undefined,
    translation: Vec3,
    offset?: number,
  ): void;
  /** Play Sound: a Sound Handle naming the new voice (`script:<Id>`). */
  playSound(asset: string, volume?: number): { Id: number };
  /** Play Sound At Location: a voice at a fixed world position (spatial when its Audio has Sound Attenuation). */
  playSoundAtLocation(asset: string, location: unknown, volume?: number, pitch?: unknown): { Id: number };
  spawnParticlesAtLocation(system: unknown, location: unknown, rotation: unknown, scale: unknown, autoDestroy?: unknown): Actor | null;
  spawnParticlesAttached(system: unknown, attachTo: unknown, bone: unknown, locationOffset: unknown, rotationOffset: unknown,
    autoDestroy?: unknown): Actor | null;
  setChannelVolume(channelGuid: string, volume: number): void;
  setGlobalVolume(volume: number): void;
  changeScene(scene: string): void;
  createSceneLayer(assetGuid: string, zOrder?: number): SceneLayer | null;
  createSceneLayerAsync(assetGuid: string, zOrder?: number): Promise<SceneLayer | null>;
  removeSceneLayer(layer: EngineObject | string | null | undefined): void;
  clearSceneLayers(): void;
  /** The new pass's Material Object, or null when nothing was registered. */
  registerSceneLayerPostProcess(
    layer: EngineObject | string | null | undefined,
    materialGuid: string,
  ): PostProcessMaterialObject | null;
  unregisterSceneLayerPostProcess(
    layer: EngineObject | string | null | undefined,
    materialGuid: string,
  ): void;
  /** The new pass's Material Object, or null when nothing was registered. */
  registerScenePostProcess(materialGuid: string): PostProcessMaterialObject | null;
  unregisterScenePostProcess(materialGuid: string): void;
  getOwningSceneLayer(target: unknown): SceneLayer | null;
  getScalability(): ScalabilitySnapshot | null;
  requestScalability(request: ScalabilityRequest): ScalabilityResult;
  setMaterialFloatParameter(
    material: unknown,
    name: string,
    value: number,
  ): void;
  /** Set Global Float / Vector / Color Parameter: the session value of `name` in Global Parameter Collection `collection`. */
  setGlobalFloatParameter(collection: unknown, name: string, value: number): void;
  /** A Vector2 parameter takes X and Y. */
  setGlobalVectorParameter(collection: unknown, name: string, value: Vec3): void;
  setGlobalColorParameter(collection: unknown, name: string, value: ScriptColor): void;
  getGlobalFloatParameter(collection: unknown, name: string): { found: boolean; value: number };
  /** A Vector2 parameter reads with Z 0. */
  getGlobalVectorParameter(collection: unknown, name: string): { found: boolean; value: Vec3 };
  getGlobalColorParameter(collection: unknown, name: string): { found: boolean; value: ScriptColor };
  setMaterialColorParameter(
    material: unknown,
    name: string,
    value: ScriptColor,
  ): void;
  /** A Vector2 parameter takes X and Y. */
  setMaterialVectorParameter(material: unknown, name: string, value: Vec3): void;
  setMaterialTextureParameter(
    material: unknown,
    name: string,
    value: string | null,
  ): void;
  setMaterialTextureParameterAsync(material: unknown, name: string, value: string | null): Promise<void>;
  getPostProcessEntry(owner: unknown, entryId: string): PostProcessMaterialObject | null;
  getMaterialFloatParameter(material: unknown, name: string): { found: boolean; value: number };
  getMaterialColorParameter(material: unknown, name: string): { found: boolean; value: ScriptColor };
  /** A Vector2 parameter reads with Z 0. */
  getMaterialVectorParameter(material: unknown, name: string): { found: boolean; value: Vec3 };
  getMaterialTextureParameter(material: unknown, name: string): { found: boolean; value: string | null };
  resetMaterialFloatParameter(material: unknown, name: string): boolean;
  resetMaterialColorParameter(material: unknown, name: string): boolean;
  resetMaterialVectorParameter(material: unknown, name: string): boolean;
  resetMaterialTextureParameter(material: unknown, name: string): boolean;
  setMeshMaterial(component: unknown, materialGuid: string | null): MaterialObject | null;
  setMeshMaterialAsync(component: unknown, materialGuid: string | null): Promise<MaterialObject | null>;
  getMaterialAsset(material: unknown): string | null;
  /** View through `target`'s first Camera component; None (or an actor without one) returns the view to the Scene's Layer Camera. */
  possessCamera(target: unknown): void;
  /** Possess Camera With Blend: Possess Camera, easing the view over `seconds` along an Easing Curve member. */
  possessCameraWithBlend(target: unknown, seconds: unknown, curve: unknown): void;
  /** The session's Scene Camera Manager. */
  getSceneCameraManager(): EngineObject | null;
  getRenderTargetMode(guid: string | null): RenderTargetMode;
  getRenderTargetTextureTarget(guid: string | null): string | null;
  captureRenderTarget(target: unknown): void;
  /** Recapture every reflection probe once the play world settles. */
  recaptureReflectionProbes(): void;
  getRenderTargetCaptureProperty(target: unknown, key: RenderTargetCaptureProperty): unknown;
  setRenderTargetCaptureProperty(target: unknown, key: RenderTargetCaptureProperty, value: unknown): void;
  getCameraFieldOfView(target: unknown): number;
  setCameraFieldOfView(target: unknown, fov: number): void;
  getCameraOrthographicSize(target: unknown): number;
  setCameraOrthographicSize(target: unknown, size: number): void;
  setLightEnabled(target: unknown, enabled: boolean): void;
  setLightColor(
    target: unknown,
    color: { x: number; y: number; z: number; w?: number },
  ): void;
  setLightIntensity(target: unknown, intensity: number): void;
  btFinish(result: "success" | "failure"): void;
  btEvaluate(value: boolean): void;
  getBlackboard(key: string): unknown;
  setBlackboard(key: string, value: unknown): void;
  findPathTo(from: Vec3, to: Vec3): Vec3[];
  moveTo(actor: EngineObject | null | undefined, destination: Vec3): void;
  stopMovement(actor: EngineObject | null | undefined): void;
  isPathValid(from: Vec3, to: Vec3): boolean;
  getClosestNavigablePoint(point: Vec3): Vec3 | null;
  getRandomPointInRadius(center: Vec3, radius: number): Vec3 | null;
  addObstacle(kind: string, pose: Vec3, size: Vec3): string;
  removeObstacle(id: string): void;
  animFacts?: AnimStateFacts;
  /** Exit Time Reached: whether this tick's `animFacts` crossed `exitTime`. */
  animExitTimeReached(exitTime: number): boolean;
  /**
   * Per-script-instance / per-node mutable state for Do Once, Do N, Flip Flop,
   * Gate. Never module-global — keyed by the receiving Object, or by the
   * calling object for a static Function Library call.
   */
  flowState(nodeId: string): Record<string, unknown>;
}

export type VariableStore = {
  getVariable(name: string): unknown;
  setVariable(name: string, value: unknown): void;
};

export type BtScriptExtras = Pick<
  ScriptContext,
  "btFinish" | "btEvaluate" | "getBlackboard" | "setBlackboard"
>;

export type ScriptExtras = Partial<BtScriptExtras> & {
  commandResult?: { success: boolean; output: string };
  /** Staged migration state follows nested function/library calls. */
  saveMigrationData?: SaveGameMigrationData;
  animFacts?: AnimStateFacts;
  variableStore?: VariableStore;
  /**
   * Static library contexts have no Self; their tweens and stateful flow nodes
   * (Do Once, Do N, Flip Flop, Gate) belong to the calling owner.
   */
  callerOwner?: EngineObject | null;
};

/** The calling frame a nested dispatch inherits: delta and tick index. */
export type CallerFrame = { deltaSeconds: number; tickIndex: number };

export type CompiledScript = ScriptBundleEntry;

export type LoadedScript = {
  script: CompiledScript;
  exports: CompiledModuleExports;
};

/**
 * The `ScriptContext` members that capture only host-lifetime state: `this`, the host services, the
 * seeded RNG and module-level helpers, never the calling object, tick, arguments or extras. The host
 * builds them once and every context inherits them; none reads the context's `this`. Every other member
 * is a value set per call or a method reading the call from its context (`createScriptContextClass`).
 */
export type HostContextKey =
  | "getSaveData" | "getSaveField" | "setSaveField" | "registerSaveActor" | "assetRegistry" | "breakpoints" | "formatValue" | "checkInfiniteLoop" | "log" | "nullAccess" | "holdFrame" | "createObject" | "collectGarbage" | "assertFailed" | "assertEqual" | "print"
  | "eventDelegate" | "bindDispatcher" | "unbindDispatcher" | "unbindAllDispatcher"
  | "setGlobalFloatParameter" | "setGlobalVectorParameter" | "setGlobalColorParameter"
  | "getGlobalFloatParameter" | "getGlobalVectorParameter" | "getGlobalColorParameter"
  | "drawDebug" | "getPostProcessEntry" | "getMaterialFloatParameter" | "getMaterialColorParameter"
  | "getMaterialVectorParameter" | "getMaterialTextureParameter" | "resetMaterialFloatParameter"
  | "resetMaterialColorParameter" | "resetMaterialVectorParameter" | "resetMaterialTextureParameter"
  | "setMeshMaterial" | "getMaterialAsset" | "setMaterialFloatParameter"
  | "setMaterialColorParameter" | "setMaterialVectorParameter" | "setMaterialTextureParameter" | "rotatorToQuat" | "quatToRotator"
  | "combineRotators" | "inverseRotator" | "deltaRotator" | "lerpRotator" | "rotatorForward" | "rotatorRight"
  | "rotatorUp" | "lookAtRotator" | "multiplyQuats" | "inverseQuat" | "slerpQuats" | "quatRotateVector"
  | "normalizeQuat" | "randomInRange" | "randomDraw" | "seededRandomDraw" | "getGlobalRandomSeed" | "setGlobalRandomSeed"
  | "randomSeedStep" | "setActorHidden" | "isActorHidden" | "setComponentVisible" | "isComponentVisible" | "componentTransform"
  | "setComponentTransform" | "actorDistance" | "addActorLocalOffset" | "addActorLocalRotation" | "addActorWorldRotation"
  | "teleportActor" | "getActorTags" | "setActorTags" | "getObjectClass" | "classIsChildOf" | "getDisplayName"
  | "playCameraShake" | "playCameraShakeOnSceneLayer" | "playWorldCameraShake" | "stopCameraShake" | "stopAllCameraShakes"
  | "setCameraShakePaused" | "setCameraShakeScale" | "isCameraShakePlaying" | "isCameraShakePaused"
  | "stopSoundHandle" | "setSoundVolume" | "setSoundPitch" | "fadeInSound" | "fadeOutSound" | "isSoundPlaying"
  | "easeAlpha" | "physicsVelocity" | "setPhysicsVelocity" | "addForce" | "addTorque" | "setMotionType" | "setActorCollisionEnabled"
  | "isActorCollisionEnabled"
  | "clearTimer" | "setTimerPaused" | "timerExists" | "isTimerActive" | "isTimerPaused" | "timerRemaining" | "timerElapsed" | "clampToRange" | "isInRange" | "lerpFloatRange"
  | "mapFloatRange" | "evaluateCurve" | "curveTimeRange" | "floatCurveValueRange" | "getCurveObject"
  | "curveObjectValue" | "curveObjectTimeRange" | "curveObjectValueRange" | "curveObjectKeyCount" | "curveObjectCurve" | "timelineClipControl" | "timelineClipState" | "getTimeline" | "getTimelineClip" | "getLoadedTimelineClips" | "createTimelineClip" | "timelineProxy" | "timelineProxyGet" | "getAllActorsOfClass" | "getActorOfClass" | "attachActor"
  | "detachActor" | "getParent" | "getActorName" | "setOwner" | "getOwner" | "executeConsoleCommand" | "getFirstComponentOfType"
  | "getAllComponentsOfType" | "getSceneLoadingProgress" | "getTargetSceneName" | "releaseAssetLoad"
  | "getAssetLoadHandleState" | "getAssetLoadHandleProgress" | "getAssetLoadState" | "loadSceneAsync"
  | "unloadSceneAsync" | "isSceneLoaded" | "getSceneLoadProgress" | "getSceneState" | "getProjectName"
  | "getProjectVersion" | "getDeltaSeconds" | "getFrameCount" | "getTimeNow" | "getDateNow" | "getTimeMs"
  | "getTimeDilation" | "setTimeDilation" | "getGameTimeSeconds" | "getRealTimeSeconds" | "getLocalTimeNow"
  | "getLocalDateNow" | "setGamePaused" | "isGamePaused" | "quitGame" | "getPlatform" | "isTouchDevice" | "isInEditor" | "isDevelopmentBuild"
  | "getViewportSize" | "getLocale" | "copyToClipboard" | "openUrl" | "newGuid" | "getSubsystem" | "getGameInstance" | "isA" | "getAnimGraphVariable"
  | "setAnimGraphVariable" | "getAnimGraphCurrentState" | "jumpAnimGraphState" | "setChannelVolume"
  | "setGlobalVolume" | "changeScene" | "createSceneLayer" | "removeSceneLayer" | "clearSceneLayers"
  | "registerSceneLayerPostProcess" | "unregisterSceneLayerPostProcess"
  | "registerScenePostProcess" | "unregisterScenePostProcess"
  | "getOwningSceneLayer"
  | "getScalability" | "requestScalability" | "possessCamera" | "possessCameraWithBlend" | "getSceneCameraManager" | "getRenderTargetMode"
  | "getRenderTargetTextureTarget" | "captureRenderTarget" | "recaptureReflectionProbes" | "getRenderTargetCaptureProperty"
  | "setRenderTargetCaptureProperty" | "getCameraFieldOfView" | "setCameraFieldOfView" | "getCameraOrthographicSize"
  | "setCameraOrthographicSize" | "setLightEnabled" | "setLightColor" | "setLightIntensity" | "findPathTo"
  | "isPathValid" | "getClosestNavigablePoint" | "getRandomPointInRadius" | "addObstacle" | "removeObstacle";
export type HostContextMembers = Pick<ScriptContext, HostContextKey>;

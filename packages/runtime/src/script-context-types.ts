import type {
  AssetLoadHandleState,
  AssetLoadStateName,
  DeviceMotionState,
  InputKey,
  InputTypeValue,
  InputValueState,
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
  TickContext,
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
import type { ScriptAssetLoadResult, ScriptColor } from "./script-host-services";
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
  getSaveField(fieldId: string, type?: string, array?: boolean): unknown;
  setSaveField(fieldId: string, value: unknown, type?: string, array?: boolean): void;
  newGame(): Promise<SaveGameResult<Record<string, SaveGameValue>>>;
  saveGame(options?: SaveGameOptions): Promise<SaveGameResult<SaveGameInfo>>;
  loadGame(options?: SaveGameOptions): Promise<SaveGameResult<SaveGameInfo>>;
  listSaves(options?: { profile?: string }): Promise<SaveGameResult<SaveGameInfo[]>>;
  deleteSave(options?: SaveGameOptions): Promise<SaveGameResult<void>>;
  registerSaveActor(actor: EngineObject | null, persistentId?: string): void;
  registerSaveMigration(fromVersion: number, migrate: SaveGameMigration | string): void;
  getSaveMigrationField(fieldId: string, type?: string, array?: boolean): unknown;
  setSaveMigrationField(fieldId: string, value: unknown, type?: string, array?: boolean): void;
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
  tweenValue(reference: TweenReference | null, type: TweenValueType, a: unknown, b: unknown, duration: number, curve: unknown): Promise<boolean>;
  tweenProperty(target: unknown, property: string, type: TweenValueType, a: unknown, b: unknown, duration: number, curve: unknown, space?: unknown): Promise<boolean>;
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
  /** @deprecated Prefer `ctx.random.float()`. */
  randomFloat(): number;
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
  delay(seconds: number): Promise<void>;
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
  spawnActorAsync(classId: string, transform?: unknown): Promise<Actor | null>;
  isA(instance: unknown, classId: string): boolean;
  getSceneLoadingProgress(): number;
  getTargetSceneName(target: unknown): string;
  loadSceneAsync(target: unknown): void;
  unloadSceneAsync(target: unknown): void;
  loadSceneBlocking(target: unknown): Promise<void>;
  unloadSceneBlocking(target: unknown): Promise<void>;
  prepareAssets(assets: readonly string[]): Promise<void>;
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
  ): Record<string, unknown> | Promise<Record<string, unknown>>;
  isActionHeld(action: string): boolean;
  wasActionPressed?(action: string): boolean;
  wasActionReleased?(action: string): boolean;
  getPressedKeys?(): readonly InputKey[];
  getAxis(axis: string): number;
  getAxis2D(axis: string): { x: number; y: number };
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
  ): {
    hit: boolean;
    location: Vec3 | null;
    normal: Vec3 | null;
    distance: number;
    actor: Actor | null;
  };
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
  playSound(asset: string, volume?: number): void;
  playParticles(actor?: EngineObject | null): void;
  stopParticles(actor?: EngineObject | null): void;
  setChannelVolume(channelGuid: string, volume: number): void;
  setGlobalVolume(volume: number): void;
  changeScene(scene: string): void;
  createSceneLayer(assetGuid: string, zOrder?: number): SceneLayer | null;
  createSceneLayerAsync(assetGuid: string, zOrder?: number): Promise<SceneLayer | null>;
  removeSceneLayer(layer: EngineObject | string | null | undefined): void;
  clearSceneLayers(): void;
  setFocusTarget(target: unknown): boolean;
  clearFocusTarget(target: unknown): void;
  registerSceneLayerPostProcess(
    layer: EngineObject | string | null | undefined,
    materialGuid: string,
  ): void;
  unregisterSceneLayerPostProcess(
    layer: EngineObject | string | null | undefined,
    materialGuid: string,
  ): void;
  setSceneLayerCameraLocation(layer: EngineObject | string | null | undefined, location: unknown): void;
  addSceneLayerCameraOffset(layer: EngineObject | string | null | undefined, delta: unknown): void;
  getSceneLayerCameraLocation(layer: EngineObject | string | null | undefined): { x: number; y: number };
  setSceneLayerCameraRotation(layer: EngineObject | string | null | undefined, degrees: unknown): void;
  getSceneLayerCameraRotation(layer: EngineObject | string | null | undefined): number;
  setSceneLayerCameraZoom(layer: EngineObject | string | null | undefined, zoom: unknown): void;
  getSceneLayerCameraZoom(layer: EngineObject | string | null | undefined): number;
  getOwningSceneLayer(target: unknown): SceneLayer | null;
  getScalability(): ScalabilitySnapshot | null;
  requestScalability(request: ScalabilityRequest): ScalabilityResult;
  setMaterialFloatParameter(
    material: unknown,
    name: string,
    value: number,
  ): void;
  setMaterialColorParameter(
    material: unknown,
    name: string,
    value: ScriptColor,
  ): void;
  setMaterialTextureParameter(
    material: unknown,
    name: string,
    value: string | null,
  ): void;
  setMaterialTextureParameterAsync(material: unknown, name: string, value: string | null): Promise<void>;
  getPostProcessEntry(owner: unknown, entryId: string): PostProcessMaterialObject | null;
  getMaterialFloatParameter(material: unknown, name: string): { found: boolean; value: number };
  getMaterialColorParameter(material: unknown, name: string): { found: boolean; value: ScriptColor };
  getMaterialTextureParameter(material: unknown, name: string): { found: boolean; value: string | null };
  resetMaterialFloatParameter(material: unknown, name: string): boolean;
  resetMaterialColorParameter(material: unknown, name: string): boolean;
  resetMaterialTextureParameter(material: unknown, name: string): boolean;
  setMeshMaterial(component: unknown, materialGuid: string | null): MaterialObject | null;
  setMeshMaterialAsync(component: unknown, materialGuid: string | null): Promise<MaterialObject | null>;
  getMaterialAsset(material: unknown): string | null;
  possessCamera(target: unknown): void;
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

/** The calling frame a nested dispatch inherits: delta, tick index and input. */
export type CallerFrame = { deltaSeconds: number; tickIndex: number; tick?: TickContext };

export type CompiledScript = ScriptBundleEntry;

export type LoadedScript = {
  script: CompiledScript;
  exports: CompiledModuleExports;
};

/**
 * The `ScriptContext` members that capture only host-lifetime state: `this`, the host services, the
 * seeded RNG and module-level helpers, never the calling object, tick, arguments or extras. The host
 * builds them once and every context inherits them, so none may read the context's `this` (compiled and
 * user code detaches them: `const { log } = ctx`). Every other member is built per call by `createContext`.
 */
export type HostContextKey =
  | "getSaveData" | "getSaveField" | "setSaveField" | "newGame" | "saveGame" | "loadGame" | "listSaves"
  | "deleteSave" | "registerSaveActor" | "assetRegistry" | "breakpoints" | "formatValue" | "checkInfiniteLoop" | "log" | "nullAccess" | "assertFailed" | "assertEqual" | "print"
  | "drawDebug" | "getPostProcessEntry" | "getMaterialFloatParameter" | "getMaterialColorParameter"
  | "getMaterialTextureParameter" | "resetMaterialFloatParameter" | "resetMaterialColorParameter"
  | "resetMaterialTextureParameter" | "setMeshMaterial" | "getMaterialAsset" | "setMaterialFloatParameter"
  | "setMaterialColorParameter" | "setMaterialTextureParameter" | "rotatorToQuat" | "quatToRotator"
  | "combineRotators" | "inverseRotator" | "deltaRotator" | "lerpRotator" | "rotatorForward" | "rotatorRight"
  | "rotatorUp" | "lookAtRotator" | "multiplyQuats" | "inverseQuat" | "slerpQuats" | "quatRotateVector"
  | "normalizeQuat" | "randomFloat" | "getAllActorsOfClass" | "getActorOfClass" | "attachActor"
  | "detachActor" | "getParent" | "getActorName" | "setOwner" | "getOwner" | "executeConsoleCommand" | "getFirstComponentOfType"
  | "getAllComponentsOfType" | "getSceneLoadingProgress" | "getTargetSceneName" | "releaseAssetLoad"
  | "getAssetLoadHandleState" | "getAssetLoadHandleProgress" | "getAssetLoadState" | "loadSceneAsync"
  | "unloadSceneAsync" | "isSceneLoaded" | "getSceneLoadProgress" | "getSceneState" | "getProjectName"
  | "getProjectVersion" | "getThirdPartyNotices" | "getSubsystem" | "getGameInstance" | "isA" | "getAnimGraphVariable"
  | "setAnimGraphVariable" | "getAnimGraphCurrentState" | "jumpAnimGraphState" | "setChannelVolume"
  | "setGlobalVolume" | "changeScene" | "createSceneLayer" | "removeSceneLayer" | "clearSceneLayers"
  | "setFocusTarget" | "clearFocusTarget" | "registerSceneLayerPostProcess" | "unregisterSceneLayerPostProcess"
  | "setSceneLayerCameraLocation" | "addSceneLayerCameraOffset" | "getSceneLayerCameraLocation" | "setSceneLayerCameraRotation"
  | "getSceneLayerCameraRotation" | "setSceneLayerCameraZoom" | "getSceneLayerCameraZoom" | "getOwningSceneLayer"
  | "getScalability" | "requestScalability" | "possessCamera" | "getRenderTargetMode"
  | "getRenderTargetTextureTarget" | "captureRenderTarget" | "recaptureReflectionProbes" | "getRenderTargetCaptureProperty"
  | "setRenderTargetCaptureProperty" | "getCameraFieldOfView" | "setCameraFieldOfView" | "getCameraOrthographicSize"
  | "setCameraOrthographicSize" | "setLightEnabled" | "setLightColor" | "setLightIntensity" | "findPathTo"
  | "isPathValid" | "getClosestNavigablePoint" | "getRandomPointInRadius" | "addObstacle" | "removeObstacle";
export type HostContextMembers = Pick<ScriptContext, HostContextKey>;

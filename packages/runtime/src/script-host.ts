import { createUnavailableEditorDataApi, type EditorDataApi } from "@babylonslate/scripting";
import type { RuntimeAssetLoadState, RuntimeAssetPreloadOptions, RuntimeAssetPreloadResult } from "@babylonslate/core";
import { RuntimeDataCatalog, type RuntimeDataApi } from "./data-catalog";
import { emptyWaterSample, parseDeformerProperties, updateDeformerProperties, DEFORMER_PROPERTY_KEYS, DEFORMER_MAX_COORDINATE, type WaterSample } from "@babylonslate/core";
import { createDefaultRenderTargetCaptureProperties, type RenderTargetMode, type RenderTargetCaptureProperty } from "@babylonslate/core";
import { captureActorReferences, captureComponent, captureProperties, setCaptureProperty } from "./render-targets";
import type { ScalabilityRequest, ScalabilityResult, ScalabilitySnapshot, InputKey, InputTypeValue, InputValueState, SceneStreamingState } from "@babylonslate/core";
import {
  combineRotators,
  createSeededRng,
  deltaRotator,
  formatValue,
  inverseQuat,
  inverseRotator,
  isSceneLayerAnchorActor,
  lerpRotator,
  lookAtRotator,
  multiplyQuats,
  normalizeQuat,
  quatRotateVector,
  quatToRotator,
  rotatorForward,
  rotatorRight,
  rotatorToQuat,
  rotatorUp,
  slerpQuats,
  type Rng,
} from "@babylonslate/core";
import type { MaterialParameterValue, ScriptBundleEntry } from "@babylonslate/bridge";
import {
  Actor,
  ActorComponent,
  BObject,
  MaterialObject,
  PostProcessMaterialObject,
  type MaterialInstanceObject,
  Scene,
  SceneLayer,
  dispatchInterface,
  interfaceHandlerKey,
  isLockedEngineClassId,
  SUBSYSTEM_CLASS_ID,
  type ClassRegistry,
  type InterfaceDispatchTarget,
  type InterfaceRegistry,
  type LifecycleHooks,
  type TickContext,
} from "@babylonslate/object-model";
import type {
  ColliderShape,
  HitResult,
  LineTraceOptions,
  OverlapResult,
  PhysicsTransform,
  TeleportOptions,
  Vec3,
} from "@babylonslate/physics";
import {
  animExitTimeReached,
  type AnimStateFacts,
  type AnimTransitionDecision,
} from "@babylonslate/anim-graph";
import { loadCompiledModule, type CompiledModuleExports } from "./module-loader";
import type { LogSeverity } from "./log-ring";
import { actorLabel } from "./actor-world-transform";
import { isInfiniteLoopError, type ScriptLoopLocation } from "@babylonslate/debugger";
import type { InputBindingControls } from "@babylonslate/input";
import type { TweenValueType } from "@babylonslate/core";
import type { TweenReference, TweenRequest } from "./tween-runtime";
import { tweenOwnerAlive } from "./tween-runtime";
import { isReadOnlyTweenProperty, propertyTweenReference, tweenStorageValue } from "./tween-targets";
import { cloneSaveGameValue, SaveGameError, type SaveGameService, type SaveGameValue,
  type SaveGameOptions, type SaveGameResult, type SaveGameInfo, type SaveGameMigration,
  type SaveGameMigrationData } from "@babylonslate/core";
import { isUIControl2DClass } from "@babylonslate/core";

const EMPTY_DATA = new RuntimeDataCatalog();
const UNAVAILABLE_EDITOR_DATA = createUnavailableEditorDataApi();

export type AnimGraphControl = {
  getVariable(name: string): unknown;
  setVariable(name: string, value: unknown): void;
  getCurrentState(): { id: string; name: string } | null;
  jumpToState(state: string): void;
};

export type ScriptColor = { x: number; y: number; z: number; w: number };

/**
 * Engine services a compiled graph calls through `ctx`. The host implements the
 * subsystems that exist today; the rest are inert stubs so a graph that uses a
 * node from a later phase runs instead of throwing.
 */
export interface ScriptHostServices {
  saveGame?: SaveGameService;
  registerSaveActor?(actor: BObject, persistentId?: string): void;
  getSaveActorId?(actor: Actor): string;
  resolveSaveActor?(id: string): Actor | undefined;
  /** Read-only session data, shared by runtime and editor utility graphs. */
  data?: RuntimeDataApi;
  /** Explicit editor-only capability; absent in every game runtime. */
  editorData?: EditorDataApi;
  /** Session seed shared with the world and trace metadata. */
  seed?: number;
  /** Whether an object may receive authored calls during its owner's load. */
  canRunOwner?(owner: BObject): boolean;
  inputBindings?: InputBindingControls;
  getInputState?: (input: InputTypeValue) => InputValueState | null;
  getProjectName?(): string;
  getProjectVersion?(): string;
  /** When set, `ctx.callInterface` uses P3 dispatch (pin defaults on miss). */
  interfaceRegistry?: InterfaceRegistry;
  /** Live-object `ctx.isA` uses ClassRegistry ancestry, not string equality. */
  classRegistry?: ClassRegistry;
  /** World actors in deterministic spawn order for class queries. */
  getActors?(): readonly Actor[];
  /** Live Scene instance for the active Play scene, if any. */
  getSceneReference?(owner?: BObject | null): Scene | null;
  /**
   * `Get <Subsystem>`: the live (never ended) GameSubsystem, or the current
   * main Scene's SceneSubsystem, whose class isA `classId`. Compiled graphs
   * call it at every use, so it must be cheap and side-effect free. Hosts
   * without subsystems (Editor Utility) omit it and the node reads null.
   */
  getSubsystem?(classId: string): BObject | null;
  /** `Get Game Instance`: the session Game Instance, if the host has one. */
  getGameInstance?(): BObject | null;
  getTargetSceneName?(target: unknown): string;
  loadScene?(target: unknown, blocking: boolean): Promise<void>;
  unloadScene?(target: unknown, blocking: boolean): Promise<void>;
  preloadAssets?(assets: readonly string[], owner: BObject | null, options?: RuntimeAssetPreloadOptions): Promise<RuntimeAssetPreloadResult>;
  prepareAssets?(assets: readonly string[], owner: BObject | null): Promise<void>;
  releasePreload?(preloadId: string): void;
  getAssetLoadState?(assetGuid: string): RuntimeAssetLoadState;
  isSceneLoaded?(target: unknown): boolean;
  getSceneLoadProgress?(target: unknown): number;
  getSceneState?(target: unknown): SceneStreamingState;
  resolveInstanceId?(owner: BObject | null, id: string): string;
  waitForSimulation?(owner: BObject | null): Promise<void>;
  /** Scene load progress in 0..1. */
  getSceneLoadingProgress?(): number;
  log(severity: LogSeverity, category: string, message: string): void;
  addComponent?(
    actor: Actor | null | undefined,
    classId: string,
    transform?: unknown,
  ): unknown;
  animGraphControl?(target: unknown): AnimGraphControl | null;
  spawnActor?(classId: string, transform?: unknown, owner?: BObject | null): Actor | null;
  spawnActorAsync?(classId: string, transform?: unknown, owner?: BObject | null): Promise<Actor | null>;
  attachToBone?(actor: Actor, target: Actor | null, boneName: string): void;
  print(
    message: string,
    key: string,
    duration: number,
    color: ScriptColor,
  ): void;
  drawDebug?(payload: Record<string, unknown>): void;
  setCursorVisible?(visible: boolean): void;
  destroyActor(actor: Actor | null | undefined): void;
  executeConsoleCommand(command: string): { success: boolean; output: string };
  executeConsoleCommandAsync?(command: string): Promise<{ success: boolean; output: string }>;
  delay(seconds: number, owner?: BObject | null): Promise<void>;
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
  sampleWater?(position: Vec3, actorId: string | null): WaterSample & { actorId: string | null };
  lineTrace?(start: Vec3, end: Vec3, options?: LineTraceOptions & { channel?: string }): HitResult;
  projectCursorToScene?(
    channel?: string,
    options?: { drawDebug?: boolean; duration?: number },
  ): HitResult & {
    worldOrigin: Vec3;
    worldDirection: Vec3;
  };
  sphereOverlap?(center: Vec3, radius: number, channel?: string): OverlapResult;
  shapeSweep?(
    shape: ColliderShape,
    start: PhysicsTransform,
    end: PhysicsTransform,
    channel?: string,
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
  createSceneLayerAsync?(assetGuid: string, zOrder: number, owner: BObject | null): Promise<SceneLayer | null>;
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
  setRenderResolution?(width: number, height: number): void;
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

export interface ScriptContext {
  getSaveData<TData extends object = Record<string, SaveGameValue>>(): TData;
  getSaveField(fieldId: string, type?: string, array?: boolean): unknown;
  setSaveField(fieldId: string, value: unknown, type?: string, array?: boolean): void;
  newGame(): Promise<SaveGameResult<Record<string, SaveGameValue>>>;
  saveGame(options?: SaveGameOptions): Promise<SaveGameResult<SaveGameInfo>>;
  loadGame(options?: SaveGameOptions): Promise<SaveGameResult<SaveGameInfo>>;
  listSaves(options?: { profile?: string }): Promise<SaveGameResult<SaveGameInfo[]>>;
  deleteSave(options?: SaveGameOptions): Promise<SaveGameResult<void>>;
  registerSaveActor(actor: BObject | null, persistentId?: string): void;
  registerSaveMigration(fromVersion: number, migrate: SaveGameMigration | string): void;
  getSaveMigrationField(fieldId: string, type?: string, array?: boolean): unknown;
  setSaveMigrationField(fieldId: string, value: unknown, type?: string, array?: boolean): void;
  data: RuntimeDataApi;
  /** Cold data reads prepare their owner-scoped source before returning copied values. */
  readDataEntryAsync(tree: string, path: string, definitionGuid?: string): Promise<Record<string, unknown> | null>;
  editorData: EditorDataApi;
  inputBindings?: InputBindingControls;
  getInputState?: (input: InputTypeValue) => InputValueState | null;
  self: BObject | null;
  deltaSeconds: number;
  tickIndex: number;
  formatValue(value: unknown): string;
  checkInfiniteLoop(location?: ScriptLoopLocation): void;
  log(severity: LogSeverity, category: string, message: string): void;
  print(
    message: string,
    key: string,
    duration: number,
    color: ScriptColor,
  ): void;
  drawDebug(payload: Record<string, unknown>): void;
  getVariable(name: string): unknown;
  setVariable(name: string, value: unknown): void;
  variableReference(target: BObject | null | undefined, name: string, implicitSelf?: boolean): TweenReference | null;
  tweenValue(reference: TweenReference | null, type: TweenValueType, a: unknown, b: unknown, duration: number, curve: unknown): Promise<boolean>;
  tweenProperty(target: unknown, property: string, type: TweenValueType, a: unknown, b: unknown, duration: number, curve: unknown, space?: unknown): Promise<boolean>;
  getVariableFrom(target: BObject | null | undefined, name: string): unknown;
  setVariableOn(
    target: BObject | null | undefined,
    name: string,
    value: unknown,
  ): void;
  destroyActor(actor: BObject | null | undefined): void;
  setActorLocation(
    actor: BObject | null | undefined,
    location: { x: number; y: number; z: number },
  ): void;
  addActorWorldOffset(
    actor: BObject | null | undefined,
    offset: { x: number; y: number; z: number },
  ): void;
  setActorRotation(
    actor: BObject | null | undefined,
    rotation: { pitch: number; yaw: number; roll: number },
  ): void;
  setActorScale(
    actor: BObject | null | undefined,
    scale: { x: number; y: number; z: number },
  ): void;
  setActorTransform(
    actor: BObject | null | undefined,
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
    child: BObject | null | undefined,
    parent: BObject | null | undefined,
  ): void;
  detachActor(child: BObject | null | undefined): void;
  attachToBone(
    actor: BObject | null | undefined,
    target: BObject | null | undefined,
    boneName: string,
  ): void;
  getParent(actor: BObject | null | undefined): Actor | null;
  setOwner(
    actor: BObject | null | undefined,
    owner: BObject | null | undefined,
  ): void;
  getOwner(actor: BObject | null | undefined): Actor | null;
  executeConsoleCommand(command: string): { success: boolean; output: string };
  executeConsoleCommandAsync(command: string): Promise<{ success: boolean; output: string }>;
  delay(seconds: number): Promise<void>;
  commandArgs: Record<string, unknown>;
  /** Alias of `commandArgs` so function Input nodes can read `ctx.args`. */
  args: Record<string, unknown>;
  reportCommand(success: boolean, output: string): void;
  callInterface(
    target: BObject | null | undefined,
    interfaceGuid: string,
    method: string,
    args?: Record<string, unknown>,
  ): unknown;
  getComponent(actor: BObject | null | undefined, classId: string): unknown;
  getComponentById(
    actor: BObject | null | undefined,
    componentId: string,
  ): unknown;
  callComponentFunction(
    target: BObject | null | undefined,
    name: string,
    args?: Record<string, unknown>,
  ): Record<string, unknown>;
  addComponent(
    actor: BObject | null | undefined,
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
  preloadAssets(assets: readonly string[], options?: RuntimeAssetPreloadOptions): Promise<RuntimeAssetPreloadResult>;
  prepareAssets(assets: readonly string[]): Promise<void>;
  releasePreload(preloadId: string): void;
  getAssetLoadState(assetGuid: string): RuntimeAssetLoadState;
  isSceneLoaded(target: unknown): boolean;
  getSceneLoadProgress(target: unknown): number;
  getSceneState(target: unknown): SceneStreamingState;
  getProjectName(): string;
  getProjectVersion(): string;
  getSceneReference(): Scene | null;
  /** Live subsystem whose class isA `classId`, or null (`Get <Subsystem>`). */
  getSubsystem(classId: string): BObject | null;
  /** The session Game Instance, or null in hosts without one. */
  getGameInstance(): BObject | null;
  getAnimGraphVariable(target: unknown, name: string): unknown;
  setAnimGraphVariable(target: unknown, name: string, value: unknown): void;
  getAnimGraphCurrentState(target: unknown): { id: string; name: string } | null;
  jumpAnimGraphState(target: unknown, state: string): void;
  invokeCustomEvent(
    target: BObject | null | undefined,
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
    target: BObject | string | null | undefined,
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
  setCursorVisible(visible: boolean): void;
  setGamepadRumble?(
    gamepadIndex: number,
    intensity: number,
    durationMs: number,
  ): void;
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
  ): {
    hit: boolean;
    location: Vec3 | null;
    normal: Vec3 | null;
    distance: number;
    actor: Actor | null;
    worldOrigin: Vec3;
    worldDirection: Vec3;
  };
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
    actor: BObject | null | undefined,
    impulse: Vec3,
    strength?: number,
  ): void;
  moveCharacter(
    actor: BObject | null | undefined,
    translation: Vec3,
    offset?: number,
  ): void;
  playSound(asset: string, volume?: number): void;
  playParticles(actor?: BObject | null): void;
  stopParticles(actor?: BObject | null): void;
  setChannelVolume(channelGuid: string, volume: number): void;
  setGlobalVolume(volume: number): void;
  changeScene(scene: string): void;
  createSceneLayer(assetGuid: string, zOrder?: number): SceneLayer | null;
  createSceneLayerAsync(assetGuid: string, zOrder?: number): Promise<SceneLayer | null>;
  removeSceneLayer(layer: BObject | string | null | undefined): void;
  clearSceneLayers(): void;
  setFocusTarget(target: unknown): boolean;
  clearFocusTarget(target: unknown): void;
  registerSceneLayerPostProcess(
    layer: BObject | string | null | undefined,
    materialGuid: string,
  ): void;
  unregisterSceneLayerPostProcess(
    layer: BObject | string | null | undefined,
    materialGuid: string,
  ): void;
  setRenderResolution(width: number, height: number): void;
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
  moveTo(actor: BObject | null | undefined, destination: Vec3): void;
  stopMovement(actor: BObject | null | undefined): void;
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
   * Gate. Never module-global — keyed by the receiving BObject.
   */
  flowState(nodeId: string): Record<string, unknown>;
}

export type VariableStore = {
  getVariable(name: string): unknown;
  setVariable(name: string, value: unknown): void;
};

type BtScriptExtras = Pick<
  ScriptContext,
  "btFinish" | "btEvaluate" | "getBlackboard" | "setBlackboard"
>;

export type ScriptExtras = Partial<BtScriptExtras> & {
  commandResult?: { success: boolean; output: string };
  /** Staged migration state follows nested function/library calls. */
  saveMigrationData?: SaveGameMigrationData;
  animFacts?: AnimStateFacts;
  variableStore?: VariableStore;
  /** Static library contexts have no Self; their tweens retain the calling owner's lifetime. */
  tweenOwner?: BObject | null;
};

export type CompiledScript = ScriptBundleEntry;

/** An AnimationGraph asset may own several independently compiled Class modules. */
export function compiledScriptKey(script: Pick<CompiledScript, "assetGuid" | "classId">): string {
  return JSON.stringify([script.assetGuid, script.classId]);
}

export function compiledScriptSourceLabel(script: Pick<CompiledScript, "assetGuid" | "classId">): string {
  return `${script.assetGuid}~${encodeURIComponent(script.classId)}`;
}

type LoadedScript = {
  script: CompiledScript;
  exports: CompiledModuleExports;
};

/**
 * Loads compiled graph modules and binds their entry points to actor
 * lifecycle hooks. One host per runtime session.
 */
export class ScriptHost {
  private readonly materialReplacements = new WeakMap<BObject, Map<string, number>>();
  private readonly materialPreloads = new WeakMap<BObject, Map<string, string>>();
  private readonly boundInterfaceKeys = new WeakMap<BObject, Set<string>>();
  private readonly byClassId = new Map<string, LoadedScript[]>();
  private sourceGeneration = 0;
  /**
   * `scriptLineage` per class id. `hooksFor` resolves it on every tick for
   * every component and actor, so it is cached; `load` clears it, and the
   * runtime only changes the ClassRegistry immediately before a `load`.
   */
  private readonly lineageByClassId = new Map<string, readonly LoadedScript[][]>();
  private readonly pending = new WeakMap<BObject, Set<string>>();
  private readonly flowStates = new WeakMap<
    BObject,
    Map<string, Record<string, unknown>>
  >();
  private readonly orphanFlowStates = new Map<
    string,
    Record<string, unknown>
  >();
  private readonly services: ScriptHostServices;
  private invokingOwner: BObject | null = null;
  private finalizingOwner: BObject | null = null;
  private commandResult = { success: true, output: "" };
  private readonly rng: Rng;

  constructor(services: ScriptHostServices) {
    this.services = services;
    this.rng = createSeededRng(services.seed ?? 1);
  }

  /** The driver installs persistence before authored Init/Begin Play hooks run. */
  setSaveGameService(service: SaveGameService | undefined): void {
    this.services.saveGame = service;
  }

  private saveGameService(): SaveGameService {
    if (!this.services.saveGame) throw new SaveGameError("unavailable", "Select a default Save Game in Project Settings before using save data.");
    return this.services.saveGame;
  }

  /** Migration exceptions must propagate to the transaction, unlike ordinary events. */
  private async invokeSaveMigration(self: BObject, event: string, snapshot: SaveGameMigrationData): Promise<void> {
    if (self.destroyed) throw new SaveGameError("incompatible", "The registered save migration owner no longer exists.");
    const loaded = this.eventScriptsFor(self.classId, event, self);
    if (!loaded) throw new SaveGameError("incompatible", `Save migration event “${event}” is missing.`);
    for (const entry of loaded) {
      for (const point of entry.script.entryPoints) {
        if (point.event !== event) continue;
        const handler = entry.exports[point.name];
        if (typeof handler !== "function") continue;
        const context = this.createContext(self, 0, 0, { saveMigrationData: snapshot }, undefined, { saveMigrationData: snapshot }, entry.script.assetGuid);
        await this.invokeOwned(self, () => (handler as (ctx: ScriptContext) => unknown)(context));
      }
    }
  }

  async load(script: CompiledScript): Promise<void> {
    const scripts = [...this.byClassId.values()].flatMap((entries) => entries.map((entry) => entry.script));
    await this.replaceScripts([...scripts.filter((entry) => compiledScriptKey(entry) !== compiledScriptKey(script)), script]);
  }

  /** Prepare a complete owned union, retaining the previous valid modules on failure. */
  async replaceScripts(scripts: readonly CompiledScript[]): Promise<void> {
    const generation = ++this.sourceGeneration;
    const existing = new Map([...this.byClassId.values()].flat().map((entry) => [compiledScriptKey(entry.script), entry]));
    const prepared = new Map<string, LoadedScript[]>();
    for (const script of scripts) {
      const previous = existing.get(compiledScriptKey(script));
      const exports = previous?.script.source === script.source
        ? previous.exports : await loadCompiledModule(script.source, compiledScriptSourceLabel(script));
      if (generation !== this.sourceGeneration) throw new Error("Script preparation was superseded or disposed.");
      const entries = prepared.get(script.classId) ?? [];
      entries.push({ script, exports });
      prepared.set(script.classId, entries);
    }
    if (generation !== this.sourceGeneration) throw new Error("Script preparation was superseded or disposed.");
    this.byClassId.clear();
    for (const [classId, entries] of prepared) this.byClassId.set(classId, entries);
    this.lineageByClassId.clear();
    const retained = new Set(scripts.map((script) => script.assetGuid));
    for (const key of this.orphanFlowStates.keys()) if (!retained.has(key.split("\0", 1)[0]!)) this.orphanFlowStates.delete(key);
  }

  dispose(): void {
    ++this.sourceGeneration;
    this.byClassId.clear();
    this.lineageByClassId.clear();
    this.orphanFlowStates.clear();
  }

  classIds(): string[] {
    return [...this.byClassId.keys()];
  }

  scriptsFor(classId: string): CompiledScript[] {
    return (this.byClassId.get(classId) ?? []).map((entry) => entry.script);
  }

  /**
   * Loaded scripts of `classId`, then of each user-class ancestor, nearest
   * first. Scripts keyed by a locked engine id answer only for that exact id
   * and are never inherited.
   */
  private scriptLineage(classId: string): readonly LoadedScript[][] {
    const cached = this.lineageByClassId.get(classId);
    if (cached) return cached;
    const lineage: LoadedScript[][] = [];
    const own = this.byClassId.get(classId);
    if (own && own.length > 0) lineage.push(own);
    const ancestry = this.services.classRegistry?.ancestry(classId) ?? [];
    for (const ancestorId of ancestry.slice(1)) {
      const loaded = this.byClassId.get(ancestorId);
      if (!loaded || loaded.length === 0) continue;
      // Engine bases only have engine ancestors.
      if (isLockedEngineClassId(ancestorId)) break;
      lineage.push(loaded);
    }
    this.lineageByClassId.set(classId, lineage);
    return lineage;
  }

  /**
   * The nearest class in `classId`'s lineage that implements `event`. A class
   * that implements an event replaces its ancestors' implementation; Call
   * Parent (`ctx.invokeEvent`) reaches an ancestor explicitly.
   */
  private eventScriptsFor(
    classId: string,
    event: string,
    self: BObject | null,
    componentId?: string,
  ): LoadedScript[] | undefined {
    return this.scriptLineage(classId).find((loaded) =>
      loaded.some((entry) =>
        entry.script.entryPoints.some(
          (point) =>
            point.event === event &&
            typeof entry.exports[point.name] === "function" &&
            entryMatchesComponentInvoke(point.componentId, componentId, self),
        ),
      ),
    );
  }

  /** The nearest class in `classId`'s lineage that exports function `exportName`. */
  private functionScriptsFor(
    classId: string,
    exportName: string,
  ): LoadedScript[] | undefined {
    return this.scriptLineage(classId).find((loaded) =>
      loaded.some((entry) => typeof entry.exports[exportName] === "function"),
    );
  }

  /**
   * Lifecycle hooks for `classId`. Each event runs the nearest implementation
   * in the class lineage, so a child inherits its parent's events. Creation is
   * On Init for the Game Instance and subsystems, Begin Play for the rest.
   */
  hooksFor(classId: string): LifecycleHooks<BObject> | undefined {
    if (this.scriptLineage(classId).length === 0) return undefined;
    const ancestry = this.services.classRegistry?.ancestry(classId) ?? [classId];
    const creationEvent =
      ancestry.includes("GameInstance") || ancestry.includes(SUBSYSTEM_CLASS_ID)
        ? "onInit"
        : "onBeginPlay";
    return {
      onCreation: (self) => {
        const loaded = this.eventScriptsFor(classId, creationEvent, self);
        if (loaded) this.dispatchEvent(loaded, creationEvent, self, 0, 0);
      },
      onTick: (self, ctx: TickContext) => {
        const loaded = this.eventScriptsFor(classId, "onTick", self);
        if (!loaded) return;
        this.dispatchEvent(
          loaded,
          "onTick",
          self,
          ctx.dt,
          ctx.tickIndex,
          {},
          ctx,
        );
      },
      onDestroyed: (self) => {
        this.clearFlowState(self);
        const loaded = this.eventScriptsFor(classId, "onDestroyed", self);
        if (loaded) this.dispatchFinalEvent(loaded, "onDestroyed", self);
      },
    };
  }

  invokeCommand(
    classId: string,
    args: Record<string, unknown>,
  ): { success: boolean; output: string } {
    const loaded = this.byClassId.get(classId);
    this.commandResult = { success: true, output: "" };
    if (!loaded || loaded.length === 0) {
      return { success: false, output: `unknown command class ${classId}` };
    }
    this.dispatchEvent(loaded, "onCommandRun", null, 0, 0, args);
    return this.commandResult;
  }

  async invokeCommandAsync(classId: string, args: Record<string, unknown>, signal: AbortSignal): Promise<{ success: boolean; output: string }> {
    const loaded = this.byClassId.get(classId);
    if (!loaded?.length) return { success: false, output: `Unknown command class ${classId}` };
    const result = { success: true, output: "" };
    for (const entry of loaded) for (const point of entry.script.entryPoints) {
      if (point.event !== "onCommandRun") continue;
      const fn = entry.exports[point.name];
      if (typeof fn !== "function") continue;
      signal.throwIfAborted();
      const ctx = this.createContext(null, 0, 0, args, undefined, { commandResult: result }, entry.script.assetGuid);
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason ?? new Error("Console command cancelled"));
        signal.addEventListener("abort", abort, { once: true });
        Promise.resolve().then(() => {
          signal.throwIfAborted();
          return this.invokeOwned(null, () => (fn as (ctx: ScriptContext) => unknown)(ctx));
        }).then(() => resolve(), reject).finally(() => signal.removeEventListener("abort", abort));
      });
    }
    return result;
  }

  /**
   * Final-lifecycle dispatch: the driver calls this only for the Game
   * Instance's shutdown events and a subsystem's On End. Only the dying
   * object's synchronous calls into itself bypass owner admission.
   */
  invokeGameShutdownEvent(classId: string, event: "onEnd" | "onSceneExit", self: BObject, args: Record<string, unknown> = {}): void {
    const loaded = this.eventScriptsFor(classId, event, self);
    if (loaded) this.dispatchFinalEvent(loaded, event, self, args);
  }

  private dispatchFinalEvent(loaded: readonly LoadedScript[], event: string, self: BObject, args: Record<string, unknown> = {}): void {
    const previous = this.finalizingOwner;
    this.finalizingOwner = self;
    try {
      this.dispatchEvent(loaded, event, self, 0, 0, args);
    } finally {
      this.finalizingOwner = previous;
    }
  }

  private canInvokeOwner(owner: BObject): boolean {
    // Only synchronous calls from the finalizing object itself inherit its final
    // lifecycle. Calling through another object must reapply normal admission.
    if (owner === this.finalizingOwner && owner === this.invokingOwner) return true;
    return !owner.destroyed && this.services.canRunOwner?.(owner) !== false;
  }

  private invokeOwned<T>(owner: BObject | null, invoke: () => T): T {
    const previous = this.invokingOwner;
    this.invokingOwner = owner;
    try {
      return invoke();
    } finally {
      this.invokingOwner = previous;
    }
  }

  /** Fire a compiled entry point (Begin Play, Tick, or a custom event name). */
  invokeEvent(
    classId: string,
    event: string,
    self: BObject | null = null,
    args: Record<string, unknown> = {},
    componentId?: string,
  ): void {
    const loaded = this.eventScriptsFor(classId, event, self, componentId);
    if (!loaded) return;
    if (self && !this.canInvokeOwner(self)) return;
    this.dispatchEvent(loaded, event, self, 0, 0, args, undefined, undefined, componentId);
  }

  hasClass(classId: string): boolean {
    return (this.byClassId.get(classId)?.length ?? 0) > 0;
  }

  invokeBtEvent(
    classId: string,
    event: string,
    self: Actor | null,
    deltaSeconds: number,
    extras: BtScriptExtras,
  ): void {
    const loaded = this.byClassId.get(classId);
    if (!loaded || loaded.length === 0) return;
    this.dispatchEvent(loaded, event, self, deltaSeconds, 0, {}, undefined, extras);
  }

  invokeAnimEvent(
    classId: string,
    event: string,
    self: Actor | null,
    deltaSeconds: number,
    extras: ScriptExtras = {},
  ): void {
    const loaded = this.byClassId.get(classId);
    if (!loaded || loaded.length === 0) return;
    this.dispatchEvent(loaded, event, self, deltaSeconds, 0, {}, undefined, extras);
  }

  invokeAnimRule(
    classId: string,
    self: Actor | null,
    extras: ScriptExtras = {},
  ): AnimTransitionDecision | undefined {
    const loaded = this.byClassId.get(classId);
    if (!loaded || loaded.length === 0) return undefined;
    const evaluate = loaded[0]?.exports.evaluate;
    if (typeof evaluate !== "function") return undefined;
    const ctx = this.createContext(
      self,
      0,
      0,
      {},
      undefined,
      extras,
      loaded[0]!.script.assetGuid,
    );
    try {
      const result = this.invokeOwned(self, () => (evaluate as (context: ScriptContext) => unknown)(ctx));
      if (!result || typeof result !== "object") return undefined;
      const row = result as { enter?: unknown; exit?: unknown };
      return {
        enter: row.enter !== false,
        exit: row.exit !== false,
      };
    } catch (error) {
      this.services.reportError(error);
      return undefined;
    }
  }

  /**
   * Register compiled function implementations as interface handlers on `object`.
   * Keys match `interfaceHandlerKey` (`guid:method`). Implementations declared by
   * user ancestors are inherited; the nearest declaring class wins.
   */
  bindInterfaceHandlers(object: BObject): void {
    for (const key of this.boundInterfaceKeys.get(object) ?? []) object.interfaceHandlers.delete(key);
    const owned = new Set<string>();
    this.boundInterfaceKeys.set(object, owned);
    const lineage = this.scriptLineage(object.classId);
    if (lineage.length === 0) return;
    for (const iface of object.implementedInterfaces) {
      // Farthest ancestor first so nearer declarations replace its handlers.
      for (const loaded of [...lineage].reverse()) {
        for (const entry of loaded) {
          for (const impl of entry.script.interfaceImplementations ?? []) {
            if (impl.interfaceGuid !== iface) continue;
            const exportName = impl.exportName;
            const key = interfaceHandlerKey(iface, impl.method);
            owned.add(key);
            object.interfaceHandlers.set(key, this.boundInterfaceHandler(object, entry.script.assetGuid, entry.script.classId, exportName));
          }
        }
      }
    }
  }

  private boundInterfaceHandler(object: BObject, assetGuid: string, classId: string, exportName: string): (args: Record<string, unknown>) => Record<string, unknown> {
    // Keep only identities in the live object's callback; a revised module
    // must not stay rooted through an older interface binding.
    return (args) => {
      for (const loaded of this.scriptLineage(object.classId)) {
        const entry = loaded.find((candidate) => candidate.script.assetGuid === assetGuid && candidate.script.classId === classId);
        if (entry) return this.invokeInterfaceHandler(object, loaded, entry, exportName, args);
      }
      return {};
    };
  }

  /**
   * Run an interface implementation on `object`. A class between `object` and
   * the declaring class that overrides the implementing function runs instead.
   */
  private invokeInterfaceHandler(
    object: BObject,
    declaringScripts: readonly LoadedScript[],
    declaringEntry: LoadedScript,
    exportName: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    if (!this.canInvokeOwner(object)) return {};
    let entry = declaringEntry;
    for (const loaded of this.scriptLineage(object.classId)) {
      if (loaded === declaringScripts) break;
      const override = loaded.find(
        (candidate) => typeof candidate.exports[exportName] === "function",
      );
      if (override) {
        entry = override;
        break;
      }
    }
    const fn = entry.exports[exportName];
    if (typeof fn !== "function") return {};
    const ctx = this.createContext(
      object,
      0,
      0,
      args,
      undefined,
      undefined,
      entry.script.assetGuid,
    );
    try {
      const result = this.invokeOwned(object, () => (fn as (ctx: ScriptContext) => unknown)(ctx));
      if (result instanceof Promise) {
        void result.catch((error) => this.services.reportError(error));
        return {};
      }
      return (
        result && typeof result === "object" && !Array.isArray(result)
          ? result
          : {}
      ) as Record<string, unknown>;
    } catch (error) {
      this.services.reportError(error);
      return {};
    }
  }

  private dispatchEvent(
    loaded: readonly LoadedScript[],
    event: string,
    self: BObject | null,
    deltaSeconds: number,
    tickIndex: number,
    commandArgs: Record<string, unknown> = {},
    tick?: TickContext,
    extras?: ScriptExtras,
    componentId?: string,
  ): void {
    for (const entry of loaded) {
      for (const point of entry.script.entryPoints) {
        if (point.event !== event) continue;
        if (!entryMatchesComponentInvoke(point.componentId, componentId, self)) {
          continue;
        }
        const fn = entry.exports[point.name];
        if (typeof fn !== "function") continue;
        const key = `${entry.script.assetGuid}:${point.name}`;
        if (self && point.isAsync && this.isPending(self, key)) continue;
        const ctx = this.createContext(
          self,
          deltaSeconds,
          tickIndex,
          commandArgs,
          tick,
          extras,
          entry.script.assetGuid,
        );
        try {
          const result = this.invokeOwned(self, () => (fn as (ctx: ScriptContext) => unknown)(ctx));
          if (result instanceof Promise) {
            if (self) this.markPending(self, key);
            void result
              .catch((error) => this.services.reportError(error))
              .finally(() => {
                if (self) this.clearPending(self, key);
              });
          }
        } catch (error) {
          this.services.reportError(error);
          if (isInfiniteLoopError(error)) throw error;
        }
      }
    }
  }

  private isPending(self: BObject, key: string): boolean {
    return this.pending.get(self)?.has(key) ?? false;
  }

  private markPending(self: BObject, key: string): void {
    const set = this.pending.get(self) ?? new Set<string>();
    set.add(key);
    this.pending.set(self, set);
  }

  private clearPending(self: BObject, key: string): void {
    this.pending.get(self)?.delete(key);
  }

  clearFlowState(self: BObject | null | undefined): void {
    if (self) this.flowStates.delete(self);
  }

  private flowStateFor(
    self: BObject | null,
    nodeId: string,
    namespace = "",
  ): Record<string, unknown> {
    const key = namespace ? `${namespace}\0${nodeId}` : nodeId;
    if (!self) {
      let row = this.orphanFlowStates.get(key);
      if (!row) {
        row = {};
        this.orphanFlowStates.set(key, row);
      }
      return row;
    }
    let byNode = this.flowStates.get(self);
    if (!byNode) {
      byNode = new Map();
      this.flowStates.set(self, byNode);
    }
    let row = byNode.get(key);
    if (!row) {
      row = {};
      byNode.set(key, row);
    }
    return row;
  }

  createContext(
    self: BObject | null,
    deltaSeconds: number,
    tickIndex: number,
    commandArgs: Record<string, unknown> = {},
    tick?: TickContext,
    extras?: ScriptExtras,
    flowNamespace = "",
  ): ScriptContext {
    const services = this.services;
    const store = extras?.variableStore ?? self;
    const tweenOwner = self ?? extras?.tweenOwner ?? null;
    const unavailable = async <T>(): Promise<SaveGameResult<T>> => ({ ok: false, error: {
      code: "unavailable", message: "Select a default Save Game in Project Settings before using saves.",
    } });
    const readField = (value: SaveGameValue, type?: string, array?: boolean): unknown => {
      if (array && Array.isArray(value)) return value.map((entry) => readField(entry, type));
      return type === "actor" && typeof value === "string" ? (services.resolveSaveActor?.(value) ?? services.findActor?.(value) ?? null) : value;
    };
    const writeField = (value: unknown, type?: string, array?: boolean): SaveGameValue => {
      if (array && Array.isArray(value)) return value.map((entry) => writeField(entry, type));
      return cloneSaveGameValue(type === "actor" && value instanceof Actor ? services.getSaveActorId?.(value) ?? value.guid : value);
    };
    const migrationData = (): SaveGameMigrationData => {
      const data = extras?.saveMigrationData ?? commandArgs.saveMigrationData as SaveGameMigrationData | undefined;
      if (!data) throw new SaveGameError("invalid", "Migration fields are available only inside Event Save Migration.");
      return data;
    };
    const context: ScriptContext = {
      getSaveData: <TData extends object>() => this.saveGameService().getSaveData() as TData,
      getSaveField: (id, type, array) => readField(this.saveGameService().getField(id), type, array),
      setSaveField: (id, value, type, array) => this.saveGameService().setField(id, writeField(value, type, array)),
      newGame: () => services.saveGame?.newGame() ?? unavailable(),
      saveGame: (options) => services.saveGame?.saveGame(options) ?? unavailable(),
      loadGame: (options) => services.saveGame?.loadGame(options) ?? unavailable(),
      listSaves: (options) => services.saveGame?.listSaves(options) ?? unavailable(),
      deleteSave: (options) => services.saveGame?.deleteSave(options) ?? unavailable(),
      registerSaveActor: (actor, persistentId) => {
        if (!(actor instanceof Actor) || actor.destroyed) throw new SaveGameError("invalid", "Register Save Actor requires a live actor.");
        if (!services.registerSaveActor) throw new SaveGameError("unavailable", "Actor persistence is not available in this host.");
        services.registerSaveActor(actor, persistentId);
      },
      registerSaveMigration: (fromVersion, migrate) => {
        const service = this.saveGameService();
        if (typeof migrate === "function") service.registerMigration(fromVersion, migrate);
        else {
          if (!self) throw new SaveGameError("invalid", "Visual save migrations require an owning object.");
          service.registerMigration(fromVersion, (snapshot) => this.invokeSaveMigration(self, migrate, snapshot));
        }
      },
      // Actor identities remain IDs here: staged actors do not exist yet.
      getSaveMigrationField: (id) => migrationData().fields[id] ?? null,
      setSaveMigrationField: (id, value) => {
        const fields = cloneSaveGameValue({ [id]: value }) as Record<string, SaveGameValue>;
        Object.assign(migrationData().fields, fields);
      },
      data: services.data ?? EMPTY_DATA,
      readDataEntryAsync: async (tree, path, definitionGuid) => {
        if (services.prepareAssets) await services.prepareAssets([tree, ...(definitionGuid ? [definitionGuid] : [])], self);
        else if (!services.data?.hasTree(tree)) throw new Error(`Data Tree ${tree} is not prepared; this host cannot load cold data.`);
        if (self?.destroyed) throw Object.assign(new Error("The data reader was destroyed"), { name: "AbortError" });
        return services.data?.readEntry(tree, path, definitionGuid) ?? null;
      },
      editorData: services.editorData ?? UNAVAILABLE_EDITOR_DATA,
      self,
      deltaSeconds,
      tickIndex,
      commandArgs,
      args: commandArgs,
      animFacts: extras?.animFacts,
      animExitTimeReached: (exitTime) =>
        extras?.animFacts ? animExitTimeReached(extras.animFacts, Number(exitTime)) : false,
      flowState: (nodeId: string) =>
        this.flowStateFor(self, String(nodeId), flowNamespace),
      reportCommand: (success, output) => {
        if (extras?.commandResult) Object.assign(extras.commandResult, { success: Boolean(success), output: String(output) });
        else this.commandResult = { success: Boolean(success), output: String(output) };
      },
      formatValue: (value) => formatValue(value),
      checkInfiniteLoop: (location) => {
        try {
          services.checkInfiniteLoop?.();
        } catch (error) {
          if (isInfiniteLoopError(error) && location) error.scriptLocation = location;
          throw error;
        }
      },
      log: (severity, category, message) =>
        services.log(severity, category, message),
      print: (message, key, duration, color) =>
        services.print(message, key, duration, color),
      drawDebug: (payload) => {
        services.drawDebug?.(payload);
      },
      getVariable: (name) => store?.getVariable(name),
      variableReference: (target, name, implicitSelf = false) => {
        const object = implicitSelf ? store : target;
        if (!object || typeof name !== "string" || !name ||
          (object instanceof BObject && (object.destroyed || isReadOnlyTweenProperty(object, name)))) return null;
        return {
          identity: object, property: `variable:${name}`,
          owner: object instanceof BObject ? object : tweenOwner ?? undefined,
          set: (value) => {
            if (object instanceof BObject) context.setVariableOn(object, name, tweenStorageValue(object, name, value));
            else object.setVariable(name, value);
          },
        };
      },
      tweenValue: (reference, type, a, b, duration, curve) => {
        if (!reference) return Promise.resolve(false);
        if (!services.tween) return Promise.reject(new Error("Tween actions are unavailable in this script host."));
        return services.tween({ reference, type, a, b, duration, curve, owner: tweenOwner }).then(completed =>
          completed && tweenOwnerAlive(tweenOwner) && tweenOwnerAlive(reference.owner) && services.isTweenSessionActive?.() !== false);
      },
      tweenProperty: (target, property, type, a, b, duration, curve, space) => {
        const reference = propertyTweenReference(target, property, type, space, services);
        return context.tweenValue(reference, type, a, b, duration, curve);
      },
      setVariable: (name, value) => {
        if (store instanceof Actor && name === "parentId") {
          writeParentId(services, store, value);
          return;
        }
        store?.setVariable(name, value);
      },
      getVariableFrom: (target, name) => {
        const object = target ?? self;
        if (object instanceof ActorComponent && object.classId === "2DRichTextComponent" &&
          (name === "appearProgress" || name === "isRevealed")) {
          const progress = services.text2DAppearProgress?.(object) ?? 1;
          return name === "isRevealed" ? progress === 1 : progress;
        }
        if (object instanceof ActorComponent && object.classId === "RenderTargetCaptureComponent" && name === "actorIds") {
          return this.canInvokeOwner(object) ? captureActorReferences(object, (id) => services.findActor?.(id)) : [];
        }
        return object?.getVariable(name);
      },
      setVariableOn: (target, name, value) => {
        const object = target ?? self;
        if (object instanceof ActorComponent && object.classId === "DeformerComponent" &&
          (DEFORMER_PROPERTY_KEYS as readonly string[]).includes(name)) {
          if (!this.canInvokeOwner(object)) return;
          const next = updateDeformerProperties(Object.fromEntries(DEFORMER_PROPERTY_KEYS.map((key) => [key, object.getVariable(key)])), name, value);
          for (const key of DEFORMER_PROPERTY_KEYS) object.setVariable(key, next[key]);
          this.applyComponentVariable(object, name, next[name as keyof typeof next]);
          return;
        }
        if (object instanceof ActorComponent && object.classId === "RenderTargetCaptureComponent") {
          if (this.canInvokeOwner(object) && setCaptureProperty(object, name as RenderTargetCaptureProperty, value, (id) => services.findActor?.(id))) {
            this.applyComponentVariable(object, name, value);
          }
          return;
        }
        if (object instanceof Scene && String(name ?? "") === "gravity") {
          const gravity = asScriptVec3(value);
          if (!gravity) return;
          object.setVariable("gravity", gravity);
          services.setWorldGravity?.(gravity);
          return;
        }
        if (object instanceof Actor && name === "parentId") {
          writeParentId(services, object, value);
          return;
        }
        object?.setVariable(name, value);
        if (object instanceof ActorComponent) {
          this.applyComponentVariable(object, String(name ?? ""), value);
        }
      },
      getPostProcessEntry: (owner, entryId) => {
        if (!(owner instanceof Scene || owner instanceof SceneLayer) || !this.canInvokeOwner(owner) || typeof entryId !== "string" || !entryId.trim()) return null;
        return services.getPostProcessEntry?.(owner, entryId.trim()) ?? null;
      },
      getMaterialFloatParameter: (material, name) => {
        const result = this.getMaterialParameter(material, name, "float");
        return { found: result?.kind === "float", value: result?.kind === "float" ? result.value : 0 };
      },
      getMaterialColorParameter: (material, name) => {
        const result = this.getMaterialParameter(material, name, "color");
        const [x, y, z, w] = result?.kind === "color" ? result.value : [0, 0, 0, 1];
        return { found: result?.kind === "color", value: { x: x!, y: y!, z: z!, w: w! } };
      },
      getMaterialTextureParameter: (material, name) => {
        const result = this.getMaterialParameter(material, name, "texture");
        return { found: result?.kind === "texture", value: result?.kind === "texture" ? result.textureAssetGuid : null };
      },
      resetMaterialFloatParameter: (material, name) => this.resetMaterialParameter(material, name, "float"),
      resetMaterialColorParameter: (material, name) => this.resetMaterialParameter(material, name, "color"),
      resetMaterialTextureParameter: (material, name) => this.resetMaterialParameter(material, name, "texture"),
      setMeshMaterial: (component, materialGuid) => {
        const target = asActorComponent(component);
        if (!target || (target.classId !== "MeshComponent" && target.classId !== "DynamicRuntimeMeshComponent") ||
          !this.canInvokeOwner(target)) return null;
        const guid = typeof materialGuid === "string" ? materialGuid.trim() : "";
        if (guid && services.prepareAssets && services.getAssetLoadState?.(guid) !== "ready") {
          throw new Error(`Material ${guid} is not prepared; await ctx.setMeshMaterialAsync or Preload Assets first`);
        }
        this.beginMaterialReplacement(target, "material");
        this.retainMaterialPreload(target, "material", "");
        // Re-applying the current asset keeps the runtime parameter values.
        if (target.getVariable("materialGuid") !== guid) {
          const previous = target.getVariable("materialObject");
          if (previous instanceof MaterialObject) this.releaseMaterialPreloads(previous);
          target.setVariable("materialGuid", guid);
          this.applyComponentVariable(target, "materialGuid", guid);
        }
        return (target.getVariable("materialObject") as MaterialObject | null) ?? null;
      },
      setMeshMaterialAsync: async (component, materialGuid) => {
        const target = asActorComponent(component);
        if (!target || (target.classId !== "MeshComponent" && target.classId !== "DynamicRuntimeMeshComponent") || !this.canInvokeOwner(target)) return null;
        const version = this.beginMaterialReplacement(target, "material");
        const guid = typeof materialGuid === "string" ? materialGuid.trim() : "";
        let preload = "";
        try {
          if (guid && services.prepareAssets) preload = await this.prepareMaterialAsset(guid, target);
          if (self?.destroyed || !this.canInvokeOwner(target) || !this.isMaterialReplacementCurrent(target, "material", version)) {
            throw Object.assign(new Error("The material replacement was cancelled or superseded"), { name: "AbortError" });
          }
          const material = context.setMeshMaterial(target, guid);
          this.retainMaterialPreload(target, "material", preload);
          preload = "";
          return material;
        } finally {
          if (preload) services.releasePreload?.(preload);
        }
      },
      getMaterialAsset: (material) =>
        (material instanceof MaterialObject || material instanceof PostProcessMaterialObject) && !material.destroyed
          ? material.materialAssetGuid
          : null,
      setMaterialFloatParameter: (material, name, value) => {
        if (typeof value !== "number" || !Number.isFinite(value)) return;
        this.setMaterialParameter(material, name, { kind: "float", value });
      },
      setMaterialColorParameter: (material, name, value) => {
        if (!value || typeof value !== "object") return;
        const rgba: [number, number, number, number] = [
          value.x,
          value.y,
          value.z,
          value.w,
        ];
        if (
          !rgba.every(
            (channel) =>
              typeof channel === "number" && Number.isFinite(channel),
          )
        )
          return;
        this.setMaterialParameter(material, name, {
          kind: "color",
          value: rgba,
        });
      },
      setMaterialTextureParameter: (material, name, value) => {
        if (value !== null && typeof value !== "string") return;
        if (value && services.prepareAssets && services.getAssetLoadState?.(value.trim()) !== "ready") {
          throw new Error(`Texture ${value} is not prepared; await ctx.setMaterialTextureParameterAsync or Preload Assets first`);
        }
        if (material instanceof MaterialObject || material instanceof PostProcessMaterialObject) {
          this.beginMaterialReplacement(material, `texture:${name.trim()}`);
          this.retainMaterialPreload(material, `texture:${name.trim()}`, "");
        }
        this.setMaterialParameter(material, name, {
          kind: "texture",
          textureAssetGuid: value?.trim() || null,
        });
      },
      setMaterialTextureParameterAsync: async (material, name, value) => {
        if (!this.materialAvailable(material) || typeof name !== "string" || !name.trim()) return;
        const key = `texture:${name.trim()}`;
        const version = this.beginMaterialReplacement(material, key);
        const guid = typeof value === "string" ? value.trim() : "";
        let preload = "";
        try {
          if (guid && services.prepareAssets) preload = await this.prepareMaterialAsset(guid, material instanceof MaterialObject ? material.component : self);
          if (self?.destroyed || !this.materialAvailable(material) || !this.isMaterialReplacementCurrent(material, key, version)) {
            throw Object.assign(new Error("The texture replacement was cancelled or superseded"), { name: "AbortError" });
          }
          context.setMaterialTextureParameter(material, name, guid || null);
          this.retainMaterialPreload(material, key, preload);
          preload = "";
        } finally {
          if (preload) services.releasePreload?.(preload);
        }
      },
      destroyActor: (actor) => {
        const target = asActor(actor ?? self);
        if (target) services.destroyActor(target);
      },
      setActorLocation: (actor, location) => {
        const target = asActor(actor ?? self);
        if (!target || !location || isSceneLayerAnchorActor(target)) return;
        target.transform.position.x = Number(location.x ?? 0);
        target.transform.position.y = Number(location.y ?? 0);
        target.transform.position.z = Number(location.z ?? 0);
        services.teleportActor?.(target);
      },
      addActorWorldOffset: (actor, offset) => {
        const target = asActor(actor ?? self);
        if (!target || !offset || isSceneLayerAnchorActor(target)) return;
        target.transform.position.x += Number(offset.x ?? 0);
        target.transform.position.y += Number(offset.y ?? 0);
        target.transform.position.z += Number(offset.z ?? 0);
        services.teleportActor?.(target);
      },
      setActorRotation: (actor, rotation) => {
        const target = asActor(actor ?? self);
        if (!target || isSceneLayerAnchorActor(target)) return;
        const quat = rotatorToQuat(rotation);
        target.transform.rotation.x = quat.x;
        target.transform.rotation.y = quat.y;
        target.transform.rotation.z = quat.z;
        target.transform.rotation.w = quat.w;
        services.teleportActor?.(target);
      },
      setActorScale: (actor, scale) => {
        const target = asActor(actor ?? self);
        if (!target || !scale || isSceneLayerAnchorActor(target)) return;
        target.transform.scale.x = Number(scale.x ?? 1);
        target.transform.scale.y = Number(scale.y ?? 1);
        target.transform.scale.z = Number(scale.z ?? 1);
        services.teleportActor?.(target);
      },
      setActorTransform: (actor, transform, options) => {
        const target = asActor(actor ?? self);
        if (!target || !transform || isSceneLayerAnchorActor(target)) return;
        if (transform.position) {
          target.transform.position.x = Number(transform.position.x ?? 0);
          target.transform.position.y = Number(transform.position.y ?? 0);
          target.transform.position.z = Number(transform.position.z ?? 0);
        }
        if (transform.rotation) {
          target.transform.rotation.x = Number(transform.rotation.x ?? 0);
          target.transform.rotation.y = Number(transform.rotation.y ?? 0);
          target.transform.rotation.z = Number(transform.rotation.z ?? 0);
          target.transform.rotation.w = Number(transform.rotation.w ?? 1);
        }
        if (transform.scale) {
          target.transform.scale.x = Number(transform.scale.x ?? 1);
          target.transform.scale.y = Number(transform.scale.y ?? 1);
          target.transform.scale.z = Number(transform.scale.z ?? 1);
        }
        services.teleportActor?.(target, options);
      },
      rotatorToQuat,
      quatToRotator,
      combineRotators,
      inverseRotator,
      deltaRotator,
      lerpRotator,
      rotatorForward,
      rotatorRight,
      rotatorUp,
      lookAtRotator,
      multiplyQuats,
      inverseQuat,
      slerpQuats,
      quatRotateVector,
      normalizeQuat,
      random: {
        float: () => this.rng.nextFloat(),
        int: (min, max) => {
          const a = Number(min) | 0;
          const b = Number(max) | 0;
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          if (hi === lo) return lo;
          return lo + (this.rng.next() % (hi - lo + 1));
        },
        bool: () => this.rng.nextFloat() < 0.5,
      },
      randomFloat: () => this.rng.nextFloat(),
      getAllActorsOfClass: (classId) => {
        const target = String(classId ?? "");
        const actors = services.getActors?.() ?? [];
        if (!target) return [];
        return actors.filter((actor) => {
          const id = actor.classId;
          if (!id) return false;
          return services.classRegistry?.isA(id, target) ?? id === target;
        });
      },
      getActorOfClass: (classId) => {
        const target = String(classId ?? "");
        const actors = services.getActors?.() ?? [];
        if (!target) return null;
        return (
          actors.find((actor) => {
            const id = actor.classId;
            if (!id) return false;
            return services.classRegistry?.isA(id, target) ?? id === target;
          }) ?? null
        );
      },
      attachActor: (child, parent) => {
        const actor = asActor(child);
        const target = asActor(parent);
        // Refuse before the bone detach so a rejected link changes nothing.
        // Attaching an actor to itself keeps its documented Detach behavior.
        if (actor && !actor.destroyed && target && !target.destroyed &&
          target.guid !== actor.guid &&
          refuseParentCycle(services, actor, target, "Attach Actor")) return;
        if (actor && !actor.destroyed) services.attachToBone?.(actor, null, "");
        setActorLink(child, "parentId", parent);
      },
      detachActor: (child) => {
        const actor = asActor(child);
        if (actor && !actor.destroyed) services.attachToBone?.(actor, null, "");
        setActorLink(child, "parentId", null);
      },
      attachToBone: (actor, target, boneName) => {
        const child = asActor(actor ?? self);
        const parent = asActor(target);
        if (!child || child.destroyed || !parent || parent.destroyed ||
          typeof boneName !== "string" || !boneName.trim()) return;
        if (refuseParentCycle(services, child, parent, "Attach To Bone")) return;
        child.setVariable("parentId", parent.guid);
        child.transform.position = { x: 0, y: 0, z: 0 };
        child.transform.rotation = { x: 0, y: 0, z: 0, w: 1 };
        services.attachToBone?.(child, parent, boneName);
      },
      getParent: (actor) => readActorLink(services, actor, "parentId"),
      setOwner: (actor, owner) => {
        setActorLink(actor, "ownerId", owner);
      },
      getOwner: (actor) => readActorLink(services, actor, "ownerId"),
      executeConsoleCommand: (command) =>
        services.executeConsoleCommand(command),
      executeConsoleCommandAsync: async (command) => {
        const result = await (services.executeConsoleCommandAsync?.(String(command ?? "")) ?? services.executeConsoleCommand(String(command ?? "")));
        if (self?.destroyed) throw Object.assign(new Error("The console command caller was destroyed"), { name: "AbortError" });
        return result;
      },
      delay: (seconds) => services.delay(seconds, self),
      callInterface: (target, interfaceGuid, method, args) => {
        const receiver = (target ?? self) as InterfaceDispatchTarget | null;
        const registry = services.interfaceRegistry;
        if (!registry || !receiver) return {};
        const admitted = !(receiver instanceof BObject) || this.canInvokeOwner(receiver);
        return dispatchInterface(
          registry,
          admitted ? receiver : {
            guid: receiver.guid,
            classId: receiver.classId,
            implementedInterfaces: receiver.implementedInterfaces,
          },
          String(interfaceGuid),
          String(method),
          args ?? {},
        );
      },
      getComponent: (actor, classId) =>
        asActor(actor ?? self)?.components.find((c) => c.classId === classId) ??
        null,
      getFirstComponentOfType: (classId) =>
        componentsOfType(services, classId).next().value ?? null,
      getAllComponentsOfType: (classId) =>
        [...componentsOfType(services, classId)],
      getComponentById: (actor, componentId) => {
        const target = actor ?? self;
        // Spawned prefabs resolve their own sourceId before an authored scene
        // component with the same id can claim the stream-wide translation.
        const local = findComponentById(asActor(target), componentId);
        if (local) return local;
        return findComponentByIdFromTarget(
          target,
          services.resolveInstanceId?.(target, componentId) ?? componentId,
          services.getActors?.(),
          services.getSceneReference?.(target) ?? null,
        );
      },
      callComponentFunction: (target, name, args) =>
        this.callNativeComponentFunction(target ?? self, String(name ?? ""), args ?? {}),
      addComponent: (actor, classId, transform) => {
        const target = asActor(actor ?? self);
        if (!target) return null;
        return services.addComponent?.(target, classId, transform) ?? null;
      },
      spawnActor: (classId, transform) =>
        services.spawnActor?.(String(classId), transform, self) ?? null,
      spawnActorAsync: async (classId, transform) => {
        if (!services.spawnActorAsync) throw new Error("This host cannot prepare a cold actor; use a runtime with asset loading");
        const actor = await services.spawnActorAsync(String(classId), transform, self);
        if (self?.destroyed) throw Object.assign(new Error("The spawn caller was destroyed"), { name: "AbortError" });
        return actor;
      },
      getSceneLoadingProgress: () =>
        clamp01(services.getSceneLoadingProgress?.() ?? 1),
      getTargetSceneName: (target) => services.getTargetSceneName?.(target) ?? "",
      preloadAssets: async (assets, options) => {
        const result = await services.preloadAssets?.(assets, self, options) ?? {
          preloadId: "", success: false, progress: 0, errorMessage: "Asset preloading is unavailable in this host",
        };
        if (self?.destroyed) throw Object.assign(new Error("The asset preload caller was destroyed"), { name: "AbortError" });
        return result;
      },
      releasePreload: (preloadId) => services.releasePreload?.(preloadId),
      prepareAssets: async (assets) => {
        if (self?.destroyed) throw Object.assign(new Error("The asset consumer was destroyed"), { name: "AbortError" });
        if (!services.prepareAssets) throw new Error("This host cannot prepare cold assets");
        await services.prepareAssets(assets, self);
        if (self?.destroyed) throw Object.assign(new Error("The asset consumer was destroyed"), { name: "AbortError" });
      },
      getAssetLoadState: (assetGuid) => services.getAssetLoadState?.(assetGuid) ?? "unloaded",
      loadSceneAsync: (target) => { void services.loadScene?.(target, false).catch((error) => services.reportError(error)); },
      unloadSceneAsync: (target) => { void services.unloadScene?.(target, false).catch((error) => services.reportError(error)); },
      loadSceneBlocking: async (target) => {
        await services.loadScene?.(target, true);
        await services.waitForSimulation?.(self);
        if (self?.destroyed) throw Object.assign(new Error("The streaming caller was destroyed."), { name: "AbortError" });
      },
      unloadSceneBlocking: async (target) => {
        await services.unloadScene?.(target, true);
        await services.waitForSimulation?.(self);
        if (self?.destroyed) throw Object.assign(new Error("The streaming caller was destroyed."), { name: "AbortError" });
      },
      isSceneLoaded: (target) => services.isSceneLoaded?.(target) ?? false,
      getSceneLoadProgress: (target) => clamp01(services.getSceneLoadProgress?.(target) ?? 0),
      getSceneState: (target) => services.getSceneState?.(target) ?? "Unloaded",
      getProjectName: () => services.getProjectName?.() ?? "",
      getProjectVersion: () => services.getProjectVersion?.() ?? "",
      getSceneReference: () => {
        const scene = services.getSceneReference?.(self) ?? null;
        return scene && !scene.destroyed ? scene : null;
      },
      getSubsystem: (classId) => {
        const id = typeof classId === "string" ? classId.trim() : "";
        return id ? (services.getSubsystem?.(id) ?? null) : null;
      },
      getGameInstance: () => services.getGameInstance?.() ?? null,
      isA: (instance, classId) => {
        if (instance == null || typeof instance !== "object") return false;
        const id = (instance as { classId?: unknown }).classId;
        if (typeof id !== "string" || !id) return false;
        const target = String(classId ?? "");
        if (!target) return false;
        return services.classRegistry?.isA(id, target) ?? id === target;
      },
      getAnimGraphVariable: (target, name) =>
        animationGraphComponentOf(target)?.getVariable(String(name ?? "")),
      setAnimGraphVariable: (target, name, value) => {
        animationGraphComponentOf(target)?.setVariable(
          String(name ?? ""),
          value,
        );
      },
      getAnimGraphCurrentState: (target) =>
        services.animGraphControl?.(target)?.getCurrentState() ?? null,
      jumpAnimGraphState: (target, state) => {
        services.animGraphControl?.(target)?.jumpToState(String(state ?? ""));
      },
      invokeCustomEvent: (target, eventName, eventArgs) => {
        const receiver = (target ?? self) as BObject | null;
        if (!receiver || !this.canInvokeOwner(receiver) || typeof eventName !== "string" || !eventName) return;
        const loaded = this.eventScriptsFor(receiver.classId, eventName, receiver);
        if (loaded) {
          this.dispatchEvent(
            loaded,
            eventName,
            receiver,
            0,
            0,
            eventArgs ?? {},
          );
        }
        if (receiver instanceof ActorComponent && receiver.owner) {
          this.invokeEvent(
            receiver.owner.classId,
            eventName,
            receiver.owner,
            eventArgs ?? {},
            receiver.guid,
          );
        }
      },
      invokeEvent: (classId, eventName, eventArgs) => {
        if (self && !this.canInvokeOwner(self)) return;
        if (typeof classId !== "string" || !classId.trim()) return;
        if (typeof eventName !== "string" || !eventName) return;
        // Call Parent passes the parent class; resolve from there, never from self.
        const loaded = this.eventScriptsFor(classId.trim(), eventName, self);
        if (!loaded) return;
        this.dispatchEvent(
          loaded,
          eventName,
          self,
          deltaSeconds,
          tickIndex,
          eventArgs ?? {},
          tick,
          extras,
        );
      },
      invokeFunction: (target, functionName, fnArgs) => {
        if (typeof functionName !== "string" || !functionName) {
          if (extras?.saveMigrationData) throw new SaveGameError("incompatible", "A save migration called an invalid function.");
          return {};
        }
        let loaded: LoadedScript[] | undefined;
        let receiver: BObject | null = null;
        if (typeof target === "string") {
          loaded = this.functionScriptsFor(target, functionName);
        } else {
          const object = (target ?? self) as BObject | null;
          if (!object || !this.canInvokeOwner(object)) {
            if (extras?.saveMigrationData) throw new SaveGameError("incompatible", "A save migration function's owner is unavailable.");
            return {};
          }
          receiver = object;
          loaded = this.functionScriptsFor(object.classId, functionName);
        }
        if (!loaded) {
          if (extras?.saveMigrationData) throw new SaveGameError("incompatible", `Save migration function “${functionName}” is missing.`);
          return {};
        }
        let result: unknown = {};
        for (const entry of loaded) {
          const fn = entry.exports[functionName];
          if (typeof fn !== "function") continue;
          const nested = this.createContext(
            receiver,
            deltaSeconds,
            tickIndex,
            fnArgs ?? {},
            tick,
            receiver ? extras : { ...extras, tweenOwner },
            entry.script.assetGuid,
          );
          try {
            const value = this.invokeOwned(receiver, () => (fn as (ctx: ScriptContext) => unknown)(nested));
            if (value instanceof Promise) {
              return value.then(
                (resolved) =>
                  resolved &&
                  typeof resolved === "object" &&
                  !Array.isArray(resolved)
                    ? (resolved as Record<string, unknown>)
                    : {},
                (error) => {
                  if (extras?.saveMigrationData || isInfiniteLoopError(error)) throw error;
                  this.services.reportError(error);
                  return {};
                },
              );
            }
            result = value ?? {};
          } catch (error) {
            if (extras?.saveMigrationData || isInfiniteLoopError(error)) throw error;
            this.services.reportError(error);
          }
        }
        return (
          result && typeof result === "object" && !Array.isArray(result)
            ? result
            : {}
        ) as Record<string, unknown>;
      },
      isActionHeld: (action) => tick?.isActionHeld?.(action) ?? false,
      inputBindings: services.inputBindings,
      getInputState: services.getInputState,
      wasActionPressed: (action) => tick?.wasActionPressed?.(action) ?? false,
      wasActionReleased: (action) =>
        tick?.wasActionReleased?.(action) ?? false,
      getPressedKeys: () => tick?.getPressedKeys?.() ?? [],
      getAxis: (axis) => tick?.getAxis?.(axis) ?? 0,
      getAxis2D: (axis) => tick?.getAxis2D?.(axis) ?? { x: 0, y: 0 },
      getCursorPosition: () =>
        tick?.getCursorPosition?.() ?? { x: 0, y: 0, pressed: false },
      setCursorVisible: (visible) => {
        if (services.setCursorVisible) {
          services.setCursorVisible(visible === true);
        } else {
          tick?.setCursorVisible?.(visible === true);
        }
      },
      setGamepadRumble: (gamepadIndex, intensity, durationMs) => {
        tick?.setGamepadRumble?.(gamepadIndex, intensity, durationMs);
      },
      gamepadConnections: tick?.gamepadConnections ?? [],
      sampleWater: (position, waterActor) => {
        if (waterActor?.destroyed) return { ...emptyWaterSample(), actor: null };
        const sample = services.sampleWater?.(position, waterActor?.guid ?? null);
        return sample ? { ...sample, actor: resolveLiveActor(services, sample.actorId) } : { ...emptyWaterSample(), actor: null };
      },
      lineTrace: (start, end, channel, options) => {
        const ignoreActorIds = [
          ...new Set(
            (options?.actorsToIgnore ?? [])
              .filter((actor): actor is Actor => actor instanceof Actor && !actor.destroyed)
              .map((actor) => actor.guid),
          ),
        ];
        const hit = services.lineTrace?.(start, end, { ignoreActorIds, ...(channel ? { channel } : {}) }) ?? {
          hit: false,
          location: null,
          actorId: null,
          normal: null,
          distance: 0,
          bodyId: null,
        };
        if (options?.drawDebug !== false) {
          const location = hit.hit === true ? hit.location : null;
          services.drawDebug?.({
            kind: "line",
            start,
            end: location ?? end,
            thickness: 1,
            color: location
              ? { x: 0, y: 1, z: 0, w: 1 }
              : { x: 1, y: 0, z: 0, w: 1 },
            duration: 0,
          });
          if (location) {
            services.drawDebug?.({
              kind: "circle",
              center: location,
              radius: 0.08,
              rotation: lookAtRotator({ x: 0, y: 0, z: 0 }, hit.normal),
              color: { x: 1, y: 0, z: 0, w: 1 },
              duration: 0,
            });
          }
        }
        return {
          hit: hit.hit === true,
          location: hit.location ?? null,
          normal: hit.normal ?? null,
          distance: hit.distance ?? 0,
          actor: resolveLiveActor(services, hit.actorId),
        };
      },
      projectCursorToScene: (channel, options) => {
        const hit = services.projectCursorToScene?.(channel, options) ?? {
          hit: false,
          location: null,
          normal: null,
          distance: 0,
          actorId: null,
          bodyId: null,
          worldOrigin: { x: 0, y: 0, z: 0 },
          worldDirection: { x: 0, y: 0, z: 0 },
        };
        return {
          hit: hit.hit === true,
          location: hit.location ?? null,
          normal: hit.normal ?? null,
          distance: hit.distance ?? 0,
          actor: resolveLiveActor(services, hit.actorId),
          worldOrigin: hit.worldOrigin ?? { x: 0, y: 0, z: 0 },
          worldDirection: hit.worldDirection ?? { x: 0, y: 0, z: 0 },
        };
      },
      sphereOverlap: (center, radius, channel) => {
        const overlap = services.sphereOverlap?.(center, radius, channel) ?? {
          actorIds: [],
          bodyIds: [],
        };
        return {
          actorIds: overlap.actorIds,
          bodyIds: overlap.bodyIds,
          actors: resolveLiveActors(services, overlap.actorIds),
        };
      },
      shapeSweep: (shape, start, end, channel) => {
        const hit = services.shapeSweep?.(shape, start, end, channel) ?? {
          hit: false,
          location: null,
          normal: null,
          distance: 0,
          actorId: null,
          bodyId: null,
        };
        return {
          hit: hit.hit === true,
          location: hit.location ?? null,
          normal: hit.normal ?? null,
          distance: hit.distance ?? 0,
          actor: resolveLiveActor(services, hit.actorId),
        };
      },
      addImpulse: (actor, impulse, strength) => {
        const target = asActor(actor ?? self);
        if (!target) return;
        services.addImpulse?.(target, impulse, strength);
      },
      moveCharacter: (actor, translation, offset) => {
        const target = asActor(actor ?? self);
        if (!target) return;
        services.moveCharacter?.(
          target,
          translation,
          deltaSeconds,
          offset,
        );
      },
      playSound: (asset, volume) => {
        services.playSound?.(String(asset ?? ""), Number(volume ?? 1), {
          emitterActorGuid: self?.guid ?? null,
        });
      },
      playParticles: (actor) => {
        const target = asActor(actor ?? self);
        if (!target) return;
        services.setParticlePlaying?.(target.guid, true);
      },
      stopParticles: (actor) => {
        const target = asActor(actor ?? self);
        if (!target) return;
        services.setParticlePlaying?.(target.guid, false);
      },
      setChannelVolume: (channelGuid, volume) => {
        services.setChannelVolume?.(
          String(channelGuid ?? ""),
          Number(volume ?? 1),
        );
      },
      setGlobalVolume: (volume) => {
        services.setGlobalVolume?.(Number(volume ?? 1));
      },
      changeScene: (scene) => {
        services.changeScene?.(scene);
      },
      createSceneLayer: (assetGuid, zOrder) =>
        services.createSceneLayer?.(String(assetGuid ?? ""), Number(zOrder) || 0) ??
        null,
      createSceneLayerAsync: async (assetGuid, zOrder) => {
        if (!services.createSceneLayerAsync) throw new Error("This host cannot prepare a cold SceneLayer");
        const layer = await services.createSceneLayerAsync(String(assetGuid ?? ""), Number(zOrder) || 0, self);
        if (self?.destroyed) throw Object.assign(new Error("The SceneLayer caller was destroyed"), { name: "AbortError" });
        return layer;
      },
      removeSceneLayer: (layer) => {
        const guid = sceneLayerGuidOf(layer);
        if (guid) services.removeSceneLayer?.(guid);
      },
      clearSceneLayers: () => {
        services.clearSceneLayers?.();
      },
      setFocusTarget: (target) => services.setFocusTarget?.(target) ?? false,
      clearFocusTarget: (target) => { services.clearFocusTarget?.(target); },
      registerSceneLayerPostProcess: (layer, materialGuid) => {
        const guid = sceneLayerGuidOf(layer);
        if (guid) {
          services.registerSceneLayerPostProcess?.(
            guid,
            String(materialGuid ?? ""),
          );
        }
      },
      unregisterSceneLayerPostProcess: (layer, materialGuid) => {
        const guid = sceneLayerGuidOf(layer);
        if (guid) {
          services.unregisterSceneLayerPostProcess?.(
            guid,
            String(materialGuid ?? ""),
          );
        }
      },
      setRenderResolution: (width, height) => {
        services.setRenderResolution?.(Number(width), Number(height));
      },
      getScalability: () => services.getScalability?.() ?? null,
      requestScalability: (request) => services.requestScalability?.(request) ?? {
        revision: 0, status: "unsupported", message: "Scalability requires an active Play or player session.",
      },
      possessCamera: (target) => {
        services.possessCamera?.(target);
      },
      getRenderTargetMode: (guid) => typeof guid === "string" ? services.getRenderTargetMode?.(guid) ?? "SceneColor" : "SceneColor",
      getRenderTargetTextureTarget: (guid) => typeof guid === "string" ? services.getRenderTargetTextureTarget?.(guid) ?? null : null,
      captureRenderTarget: (target) => {
        const component = captureComponent(target);
        if (component?.owner && this.canInvokeOwner(component)) services.captureRenderTarget?.(component.owner);
      },
      getRenderTargetCaptureProperty: (target, key) => {
        const component = captureComponent(target);
        if (!component || !this.canInvokeOwner(component)) return createDefaultRenderTargetCaptureProperties()[key];
        return key === "actorIds" ? captureActorReferences(component, (id) => services.findActor?.(id)) : captureProperties(component)[key];
      },
      setRenderTargetCaptureProperty: (target, key, value) => {
        const component = captureComponent(target);
        if (component && this.canInvokeOwner(component) && setCaptureProperty(component, key, value, (id) => services.findActor?.(id))) {
          this.applyComponentVariable(component, key, value);
        }
      },
      getCameraFieldOfView: (target) =>
        Number(cameraComponentOf(target)?.getVariable("fieldOfView") ?? 60),
      setCameraFieldOfView: (target, fov) => {
        cameraComponentOf(target)?.setVariable("fieldOfView", Number(fov));
        services.updateIllumination?.(target);
      },
      getCameraOrthographicSize: (target) =>
        Number(
          cameraComponentOf(target)?.getVariable("orthographicSize") ?? 5,
        ),
      setCameraOrthographicSize: (target, size) => {
        cameraComponentOf(target)?.setVariable("orthographicSize", Number(size));
        services.updateIllumination?.(target);
      },
      setLightEnabled: (target, enabled) => {
        lightComponentOf(target)?.setVariable("enabled", Boolean(enabled));
        services.updateIllumination?.(target);
      },
      setLightColor: (target, color) => {
        lightComponentOf(target)?.setVariable("color", [
          Number(color?.x ?? 1),
          Number(color?.y ?? 1),
          Number(color?.z ?? 1),
        ]);
        services.updateIllumination?.(target);
      },
      setLightIntensity: (target, intensity) => {
        lightComponentOf(target)?.setVariable("intensity", Number(intensity));
        services.updateIllumination?.(target);
      },
      findPathTo: (from, to) => services.findPathTo?.(from, to) ?? [],
      moveTo: (actor, destination) => {
        const target = asActor(actor ?? self);
        if (!target) return;
        services.moveTo?.(target, destination);
      },
      stopMovement: (actor) => {
        const target = asActor(actor ?? self);
        if (!target) return;
        services.stopMovement?.(target);
      },
      isPathValid: (from, to) => services.isPathValid?.(from, to) ?? false,
      getClosestNavigablePoint: (point) =>
        services.getClosestNavigablePoint?.(point) ?? null,
      getRandomPointInRadius: (center, radius) =>
        services.getRandomPointInRadius?.(center, radius) ?? null,
      addObstacle: (kind, pose, size) =>
        services.addObstacle?.(kind, pose, size) ?? "",
      removeObstacle: (id) => {
        services.removeObstacle?.(id);
      },
      btFinish: extras?.btFinish ?? (() => undefined),
      btEvaluate: extras?.btEvaluate ?? (() => undefined),
      getBlackboard: extras?.getBlackboard ?? (() => undefined),
      setBlackboard: extras?.setBlackboard ?? (() => undefined),
    };
    return context;
  }

  private beginMaterialReplacement(owner: BObject, key: string): number {
    let versions = this.materialReplacements.get(owner);
    if (!versions) { versions = new Map(); this.materialReplacements.set(owner, versions); }
    const version = (versions.get(key) ?? 0) + 1;
    versions.set(key, version);
    return version;
  }

  private async prepareMaterialAsset(guid: string, owner: BObject | null): Promise<string> {
    if (!this.services.preloadAssets) { await this.services.prepareAssets?.([guid], owner); return ""; }
    const result = await this.services.preloadAssets([guid], owner);
    if (!result.success) throw new Error(`Asset ${guid}, requested by ${owner?.guid ?? "scene"}: ${result.errorMessage}`);
    return result.preloadId;
  }

  private retainMaterialPreload(owner: BObject, key: string, preloadId: string): void {
    let scopes = this.materialPreloads.get(owner);
    const previous = scopes?.get(key);
    if (preloadId) {
      if (!scopes) { scopes = new Map(); this.materialPreloads.set(owner, scopes); }
      scopes.set(key, preloadId);
    } else scopes?.delete(key);
    if (previous && previous !== preloadId) this.services.releasePreload?.(previous);
  }

  private releaseMaterialPreloads(owner: BObject): void {
    const scopes = this.materialPreloads.get(owner);
    this.materialPreloads.delete(owner);
    for (const id of scopes?.values() ?? []) this.services.releasePreload?.(id);
  }

  private isMaterialReplacementCurrent(owner: BObject, key: string, version: number): boolean {
    return this.materialReplacements.get(owner)?.get(key) === version;
  }

  private setMaterialParameter(
    material: unknown,
    name: string,
    parameter: MaterialParameterValue,
  ): void {
    if (!this.materialAvailable(material) || typeof name !== "string" || !name.trim()) return;
    this.services.setMaterialParameter?.(material, name.trim(), parameter);
  }

  private materialAvailable(material: unknown): material is MaterialInstanceObject {
    if (!(material instanceof MaterialObject || material instanceof PostProcessMaterialObject) || !this.canInvokeOwner(material)) return false;
    return material instanceof PostProcessMaterialObject ? material.isCurrent() : material.component.getVariable("materialObject") === material;
  }

  private getMaterialParameter(material: unknown, name: string, kind: MaterialParameterValue["kind"]): MaterialParameterValue | null {
    if (!this.materialAvailable(material) || typeof name !== "string" || !name.trim()) return null;
    return this.services.getMaterialParameter?.(material, name.trim(), kind) ?? null;
  }

  private resetMaterialParameter(material: unknown, name: string, kind: MaterialParameterValue["kind"]): boolean {
    if (!this.materialAvailable(material) || typeof name !== "string" || !name.trim()) return false;
    return this.services.resetMaterialParameter?.(material, name.trim(), kind) ?? false;
  }

  private applyComponentVariable(
    component: ActorComponent,
    name: string,
    value: unknown,
  ): void {
    this.services.refreshComponent?.(component, name);
    if (name === "text" && isTextComponent(component)) {
      this.fireComponentOwnerEvent(component, "onTextChanged", {
        text: value,
      });
    }
  }

  private callNativeComponentFunction(
    target: BObject | null | undefined,
    name: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    if (target instanceof Actor && name === "switchSceneLayerActor") {
      return { actor: this.canInvokeOwner(target) ? this.services.switchSceneLayerActor?.(target, args.index) ?? null : null };
    }
    if (target instanceof Actor && name === "getCurrentSceneLayerActor") {
      return { actor: this.services.getCurrentSceneLayerActor?.(target) ?? null };
    }
    const component = asActorComponent(target);
    if (!component || !name) return {};
    if (component.classId === "2DRichTextComponent" &&
      (name === "triggerAppear" || name === "play" || name === "playReverse")) {
      if (this.canInvokeOwner(component)) this.services.text2DAppear?.(component, name);
      return {};
    }
    if (name === "setFocusTarget") return { success: this.canInvokeOwner(component) && this.services.setFocusTarget?.(component) === true };
    if (name === "clearFocusTarget") {
      if (this.canInvokeOwner(component)) this.services.clearFocusTarget?.(component);
      return {};
    }
    if (name.startsWith("painter")) return { success: this.canInvokeOwner(component) && this.services.paint2D?.(component, name, args) === true };
    if (isUIControl2DClass(component.classId)) return { success: this.canInvokeOwner(component) && this.services.uiControlFunction?.(component, name, args) === true };
    if (component.classId === "DynamicRuntimeMeshComponent") {
      if (!this.canInvokeOwner(component)) return { success: false };
      return this.services.dynamicMeshFunction?.(component, name, args) ?? { success: false };
    }
    if (component.classId === "DeformerComponent" &&
      (name === "setDeformerControlPointOffset" || name === "resetDeformerControlPoints")) {
      if (!this.canInvokeOwner(component)) return { success: false };
      const properties = parseDeformerProperties({ resolution: component.getVariable("resolution"), offsets: component.getVariable("offsets") });
      if (name === "resetDeformerControlPoints") properties.offsets.fill(0);
      else {
        const index = args.index;
        const value = args.offset;
        const offset = Array.isArray(value) ? value : value && typeof value === "object"
          ? [(value as Record<string, unknown>).x, (value as Record<string, unknown>).y, (value as Record<string, unknown>).z] : [];
        if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= properties.offsets.length / 3 ||
          ![0, 1, 2].every((axis) => typeof offset[axis] === "number" && Number.isFinite(offset[axis]) && Math.abs(offset[axis]) <= DEFORMER_MAX_COORDINATE)) return { success: false };
        for (const axis of [0, 1, 2]) properties.offsets[index * 3 + axis] = offset[axis] as number;
      }
      component.setVariable("offsets", properties.offsets);
      this.applyComponentVariable(component, "offsets", properties.offsets);
      return { success: true };
    }
    if (component.classId === "MovementComponent") {
      if (!this.canInvokeOwner(component)) return {};
      return this.services.movementFunction?.(component, name, args) ?? {};
    }
    if (name === "setText") {
      const text = String(args.text ?? "");
      component.setVariable("text", text);
      this.applyComponentVariable(component, "text", text);
      return {};
    }
    if (name === "playAudio") {
      const owner = component.owner;
      const assetGuid =
        (typeof component.getVariable("audioAssetGuid") === "string"
          ? component.getVariable("audioAssetGuid")
          : null) ?? component.assetGuid;
      if (typeof assetGuid === "string" && assetGuid && owner) {
        this.services.playSound?.(assetGuid, Number(component.getVariable("volume") ?? 1), {
          emitterActorGuid: owner.guid,
          loop: component.getVariable("loop") === true,
          voiceId: component.guid,
        });
      }
      return {};
    }
    if (name === "stopAudio") {
      this.services.stopSound?.(component.guid);
      return {};
    }
    if (name === "playParticles" && component.owner) {
      this.services.setParticlePlaying?.(
        component.owner.guid,
        true,
        component.guid,
      );
      return {};
    }
    if (name === "stopParticles" && component.owner) {
      this.services.setParticlePlaying?.(
        component.owner.guid,
        false,
        component.guid,
      );
      return {};
    }
    if (name === "possessCamera" && component.owner) {
      this.services.possessCamera?.(component.owner);
      return {};
    }
    if (name === "addImpulse" && component.owner) {
      const impulse = vec3Arg(args.impulse);
      this.services.addImpulse?.(
        component.owner,
        impulse,
        Number(args.strength ?? 1),
      );
      return {};
    }
    if (name === "setConstraintTarget" && component.classId === "PhysicsConstraintComponent") {
      const actor = asActor(args.actor);
      if (args.actor != null && (!actor || actor.destroyed)) return {};
      const targetActorId = actor?.guid ?? "";
      component.setVariable("targetActorId", targetActorId);
      this.applyComponentVariable(component, "targetActorId", targetActorId);
      return {};
    }
    if (name === "moveTo" && component.owner) {
      this.services.moveTo?.(component.owner, vec3Arg(args.destination));
      return {};
    }
    if (name === "stopMovement" && component.owner) {
      this.services.stopMovement?.(component.owner);
      return {};
    }
    return {};
  }

  private fireComponentOwnerEvent(
    component: ActorComponent,
    event: string,
    args: Record<string, unknown>,
  ): void {
    const owner = component.owner;
    if (!owner) return;
    this.invokeEvent(owner.classId, event, owner, args, component.guid);
  }
}

function* componentsOfType(
  services: ScriptHostServices,
  classId: string,
): Generator<ActorComponent, undefined, unknown> {
  const target = String(classId ?? "");
  if (!target) return;
  for (const actor of services.getActors?.() ?? []) {
    if (actor.destroyed) continue;
    for (const component of actor.components) {
      if (component.destroyed) continue;
      if (services.classRegistry?.isA(component.classId, target) ??
        component.classId === target) {
        yield component;
      }
    }
  }
}

function asActor(target: unknown): Actor | null {
  return target instanceof Actor ? target : null;
}

function asScriptVec3(
  value: unknown,
): { x: number; y: number; z: number } | null {
  if (Array.isArray(value) && value.length >= 3) {
    const x = Number(value[0]);
    const y = Number(value[1]);
    const z = Number(value[2]);
    if (![x, y, z].every(Number.isFinite)) return null;
    return { x, y, z };
  }
  if (!value || typeof value !== "object") return null;
  const record = value as { x?: unknown; y?: unknown; z?: unknown };
  const x = Number(record.x);
  const y = Number(record.y);
  const z = Number(record.z);
  if (![x, y, z].every(Number.isFinite)) return null;
  return { x, y, z };
}

function asActorComponent(target: unknown): ActorComponent | null {
  return target instanceof ActorComponent ? target : null;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function findComponentByIdFromTarget(
  target: unknown,
  componentId: string,
  actors: readonly Actor[] | undefined,
  currentScene: Scene | null,
): ActorComponent | null {
  if (target instanceof Scene) {
    if (target.destroyed || currentScene !== target) return null;
    if (!actors) return null;
    for (const actor of actors) {
      if (actor.destroyed) continue;
      const found = findComponentById(actor, componentId);
      if (found) return found;
    }
    return null;
  }
  return findComponentById(asActor(target), componentId);
}

function findComponentById(
  actor: Actor | null,
  componentId: string,
): ActorComponent | null {
  if (!actor || typeof componentId !== "string" || !componentId) return null;
  return (
    actor.components.find(
      (component) =>
        !component.destroyed && componentMatchesId(component, componentId),
    ) ?? null
  );
}

function componentMatchesId(
  component: ActorComponent,
  componentId: string,
): boolean {
  return component.guid === componentId || component.sourceId === componentId;
}

/**
 * Host invokes (Begin Play / Tick / Destroyed) run unbound entries.
 * Component invokes run the entry whose compiled id matches the live guid or
 * the prefab `sourceId` after instance remapping. Leftover unbound Hit/Click
 * does not run for every component.
 */
function entryMatchesComponentInvoke(
  entryComponentId: string | undefined,
  invokeComponentId: string | undefined,
  self: BObject | null,
): boolean {
  const bound =
    typeof entryComponentId === "string" ? entryComponentId.trim() : "";
  const invoked =
    typeof invokeComponentId === "string" ? invokeComponentId.trim() : "";
  if (!invoked) return !bound;
  if (!bound) return false;
  if (bound === invoked) return true;
  if (!(self instanceof Actor)) return false;
  const component = findComponentById(self, invoked);
  return component ? componentMatchesId(component, bound) : false;
}

function isTextComponent(component: ActorComponent): boolean {
  return (
    component.classId === "Text3DComponent" ||
    component.classId === "2DTextComponent" ||
    component.classId === "2DRichTextComponent"
  );
}

function setActorLink(
  actor: unknown,
  key: "parentId" | "ownerId",
  other: unknown,
): void {
  const target = asActor(actor);
  if (!target || target.destroyed) return;
  const linked = asActor(other);
  if (!linked || linked.destroyed || linked.guid === target.guid) {
    target.setVariable(key, null);
    return;
  }
  target.setVariable(key, linked.guid);
}

/**
 * Scripts may not close a parent cycle. Walk the proposed parent's ancestors
 * (a seen-set stops at loops already present) and refuse with a warning when
 * `child` is `parent` itself or one of `parent`'s ancestors, or the chain
 * already loops.
 */
function refuseParentCycle(
  services: ScriptHostServices,
  child: Actor,
  parent: Actor,
  operation: string,
): boolean {
  const seen = new Set<string>();
  for (let ancestor: Actor | null = parent; ancestor; ancestor = readActorLink(services, ancestor, "parentId")) {
    if (ancestor.guid === child.guid) {
      services.log("warning", "actor", `${operation} refused: parenting ${actorLabel(child)} to ${actorLabel(parent)} would create a parent cycle.`);
      return true;
    }
    if (seen.has(ancestor.guid)) {
      services.log("warning", "actor", `${operation} refused: ${actorLabel(child)} cannot be parented to ${actorLabel(parent)} because that parent chain already contains a cycle.`);
      return true;
    }
    seen.add(ancestor.guid);
  }
  return false;
}

/**
 * Scripted `parentId` writes get Attach Actor's cycle refusal; the actor's own
 * guid is a cycle too and is refused. Other values are stored unchanged.
 */
function writeParentId(
  services: ScriptHostServices,
  child: Actor,
  value: unknown,
): void {
  const parent = value === child.guid ? child
    : typeof value === "string" ? resolveLiveActor(services, value) : null;
  if (parent && refuseParentCycle(services, child, parent, "Set parentId")) return;
  child.setVariable("parentId", value);
}

function readActorLink(
  services: ScriptHostServices,
  actor: unknown,
  key: "parentId" | "ownerId",
): Actor | null {
  const target = asActor(actor);
  if (!target || target.destroyed) return null;
  const id = target.getVariable(key);
  return typeof id === "string" ? resolveLiveActor(services, id) : null;
}

function resolveLiveActor(
  services: ScriptHostServices,
  actorId: string | null | undefined,
): Actor | null {
  if (!actorId) return null;
  const actor = services.findActor?.(actorId);
  if (!actor || actor.destroyed) return null;
  return actor;
}

function resolveLiveActors(
  services: ScriptHostServices,
  actorIds: readonly string[],
): Actor[] {
  const seen = new Set<string>();
  const actors: Actor[] = [];
  for (const id of actorIds) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const actor = resolveLiveActor(services, id);
    if (actor) actors.push(actor);
  }
  return actors;
}

function vec3Arg(value: unknown): Vec3 {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    x: Number(record.x ?? 0) || 0,
    y: Number(record.y ?? 0) || 0,
    z: Number(record.z ?? 0) || 0,
  };
}

function actorOf(target: unknown): Actor | null {
  if (target instanceof Actor) return target;
  if (target instanceof ActorComponent) return target.owner;
  return null;
}

function animationGraphComponentOf(target: unknown): ActorComponent | null {
  if (
    target instanceof ActorComponent &&
    target.classId === "AnimationGraphComponent" &&
    !target.destroyed
  ) {
    return target;
  }
  return null;
}

function cameraComponentOf(target: unknown): ActorComponent | null {
  if (target instanceof ActorComponent && target.classId === "CameraComponent") {
    return target;
  }
  return (
    actorOf(target)?.components.find(
      (component) => component.classId === "CameraComponent" && !component.destroyed,
    ) ?? null
  );
}

function lightComponentOf(target: unknown): ActorComponent | null {
  if (
    target instanceof ActorComponent &&
    (target.classId === "LightComponent" ||
      target.classId === "AreaRectLightComponent" ||
      target.classId === "HemisphericFillLightComponent")
  ) {
    return target;
  }
  return (
    actorOf(target)?.components.find(
      (component) =>
        (component.classId === "LightComponent" ||
          component.classId === "AreaRectLightComponent" ||
          component.classId === "HemisphericFillLightComponent") &&
        !component.destroyed,
    ) ?? null
  );
}

function sceneLayerGuidOf(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value instanceof SceneLayer && !value.destroyed) return value.guid;
  if (value && typeof value === "object" && "guid" in value) {
    const guid = (value as { guid?: unknown }).guid;
    return typeof guid === "string" && guid.trim() ? guid.trim() : null;
  }
  return null;
}

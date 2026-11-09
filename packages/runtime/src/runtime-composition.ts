import type { RuntimeGlobalParameters } from "./runtime-global-parameters";
import type { TimelineRuntime } from "./timeline-runtime";
import type { CameraShakeCatalogEntry, CurveAssetCatalogEntry } from "@haptic/core";
import type { CommandMessage, GameSessionMode, SessionPauseReason } from "@haptic/bridge";
import type {
  RenderTargetPayload,
  RenderTargetTexturePayload,
  ScalabilitySession,
  SerializedScene,
  SerializedSceneLayer,
} from "@haptic/core";
import type { InfiniteLoopGuard, UserCommandDef } from "@haptic/debugger";
import type { InputResolver, InputRingBuffer, ResolvedInputTick } from "@haptic/input";
import type { Actor, EngineObject, World } from "@haptic/object-model";
import type { ActorRealization, ScriptedActorSpawn } from "./actor-realization";
import type { AnimGraphRuntime } from "./anim-graph-runtime";
import type { RuntimeAssetPreloads } from "./asset-preloads";
import type { AudioParticleEmitter } from "./audio-particle-emitter";
import type { BehaviourTreeRuntime } from "./behaviour-tree-runtime";
import type { CableWorldSync } from "./cable-sync";
import type { SpringArmProbeSync } from "./spring-arm-probe";
import type { RuntimeDataCatalog } from "./data-catalog";
import type { SessionDiagnosticAggregator } from "./diagnostics";
import type { RuntimeDriver } from "./driver-types";
import type { DynamicRuntimeMeshSync } from "./dynamic-runtime-mesh";
import type { LatentDelays } from "./latent-delays";
import type { ScriptTimers } from "./script-timers";
import type { CameraShakes } from "./camera-shakes";
import type { LogRingBuffer } from "./log-ring";
import type { MovementWorldSync } from "./movement";
import type { OwnerAdmission } from "./owner-admission";
import type { Painter2DRuntime } from "./painter2d-runtime";
import type { RagdollWorldSync } from "./ragdoll-sync";
import type { RenderCommandEmitter } from "./render-command-emitter";
import type { RenderSlots } from "./render-slots";
import type { RuntimeCamera } from "./runtime-camera";
import type { RuntimeConsole } from "./runtime-console";
import type { RuntimeInspectorService } from "./runtime-inspector-service";
import type { RuntimeMaterialParameters } from "./runtime-material-parameters";
import type { RuntimeNavigation } from "./runtime-navigation";
import type { RuntimePhysicsWorlds } from "./runtime-physics-worlds";
import type { RuntimePropertyWrites } from "./runtime-property-writes";
import type { RuntimeSubsystems } from "./runtime-subsystems";
import type { RuntimeVoices } from "./runtime-voices";
import type { RuntimeParticles } from "./runtime-particles";
import type { RuntimeParticleEffects } from "./runtime-particle-effects";
import type { SceneLayerOverlay } from "./scene-layer-overlay";
import type { GamePauseVoices } from "./runtime-game-pause";
import type { SceneLayers } from "./scene-layers";
import type { CooperativeSceneLoadingOptions } from "./scene-realization-work";
import type { SceneRealizer } from "./scene-realizer";
import type { AcquireRuntimeScene } from "./scene-source";
import type { SceneStreams } from "./scene-streams";
import type { ScriptBreakpoints } from "./script-breakpoints";
import type { ScriptDebugObserver } from "./script-debug";
import type { ScriptHost } from "./script-host";
import type { ScriptRuntime } from "./script-runtime";
import type { SessionBoundaries } from "./session-boundaries";
import type { SimulationBlocks } from "./simulation-blocks";
import type { SimulationSession } from "./simulation-session";
import type { SimulationWaits } from "./simulation-waits";
import type { SnapshotPublisher } from "./snapshot-publisher";
import type { SpriteClipState, SpriteClipTrace } from "./sprite-clip-trace";
import type { AnchorEntry } from "./stack-map";
import type { Text2DAppearRuntime } from "./text2d-appear-runtime";
import type { TickPipeline } from "./tick-pipeline";
import type { TweenRuntime } from "./tween-runtime";
import type { UIControls2DRuntime } from "./ui-controls2d-runtime";
import type { WaterClock } from "./water-world";
import type { RuntimeObjectLifetime } from "./object-lifetime";

/**
 * What the session's subsystem wiring (`runtime-composition-*.ts`), tick
 * phases (`runtime-tick-phases.ts`) and error reporting
 * (`runtime-error-reporting.ts`) read and write on the in-process runtime
 * driver, which passes itself. Host callbacks read these members when called,
 * not when built, because most subsystems do not exist yet when the factories
 * run. Only the members those modules write are mutable.
 */
export interface RuntimeComposition extends Pick<RuntimeDriver,
  "stop" | "pause" | "resume" | "tick" | "setTimeDilation" | "setGamePaused" | "reportError" | "reportLog" | "registerAnchors" |
  "registerSaveActor" | "inspectWorld" | "removeSceneLayer" | "requestScalability" | "getScalability"> {
  // Session configuration, fixed at construction.
  readonly sessionGeneration: number;
  readonly sessionMode: GameSessionMode;
  readonly demandAssetCatalog: boolean;
  readonly dt: number;
  readonly seed: number;
  readonly acquireScene?: AcquireRuntimeScene;
  readonly deferSceneModelsReady: boolean;
  readonly deferSceneLoadingPaint: boolean;
  readonly cooperativeSceneLoading: CooperativeSceneLoadingOptions | null;

  // Session state.
  readonly running: boolean;
  readonly stopped: boolean;
  readonly bootLoading: boolean;
  readonly paused: boolean;
  readonly pauseReasons: Set<SessionPauseReason>;
  readonly pendingPauseChanges: Map<SessionPauseReason, boolean>;
  /** Advanced by the tick phases and the inspector. */
  frameId: number;
  readonly commandRevision: number;
  readonly lifecycleId: number;
  readonly timeDilation: number;
  /** Set Game Paused's requested state; `GamePauseVoices.sync` applies it to the World before a tick. */
  readonly gamePaused: boolean;
  readonly gamePauseVoices: GamePauseVoices;
  liveVoiceOwners(): Iterable<[voiceId: string, ownerGuid: string | null]>;
  /** Get Game Time In Seconds: the dilated steps since the session started, advanced by the tick phases. */
  gameTimeSeconds: number;
  /** Get Real Time Seconds: the same steps without time dilation. */
  realTimeSeconds: number;
  /** Reset by the Scene realizer's `startWorld`, advanced by the tick phases; the driver's `registerTileContent` re-sends it. */
  tilemapAnimationTimeMs: number;
  readonly hasAnimatedTiles: boolean;
  readonly waterClock: WaterClock;
  navFrameActors: Map<string, Actor> | null;
  guidIndexCache: { revision: number; index: Map<string, Actor> } | null;

  // Scene documents and render target sources.
  /** Replaced by the Scene realizer's `enterScene` and by `setWorldGravity`. */
  playScene: SerializedScene | undefined;
  playSceneGuid: string;
  readonly sceneLibrary: Map<string, SerializedScene>;
  readonly sceneGuidByKey: Map<string, string>;
  readonly sceneLayerLibrary: Map<string, SerializedSceneLayer>;
  readonly sourceRenderTargets: Map<string, RenderTargetPayload>;
  readonly sourceRenderTargetTextures: Map<string, RenderTargetTexturePayload>;

  // Input.
  readonly input: InputRingBuffer;
  readonly resolver: InputResolver;
  resolvedInput: ResolvedInputTick;
  readonly bindingsUseDeviceMotion: boolean;
  deviceMotionRequested: boolean;
  readonly connectionBox: { current: ResolvedInputTick["gamepadConnections"] };

  // Logs and diagnostics.
  readonly logs: LogRingBuffer;
  readonly diagnostics: SessionDiagnosticAggregator;
  readonly pauseOnErrors: boolean;
  readonly pausedErrorSources: Set<string>;
  readonly breakpoints: ScriptBreakpoints;
  breakpointReported: boolean;
  readonly anchors: Map<string, readonly AnchorEntry[]>;
  readonly loopGuard: InfiniteLoopGuard;

  // Subsystems.
  readonly voices: RuntimeVoices;
  readonly particles: RuntimeParticles;
  readonly globalParameters: RuntimeGlobalParameters;
  readonly particleEffects: RuntimeParticleEffects;
  readonly spriteClips: SpriteClipTrace;
  readonly assetPreloads: RuntimeAssetPreloads;
  readonly blocks: SimulationBlocks;
  readonly painters: Painter2DRuntime;
  readonly textAppear: Text2DAppearRuntime;
  readonly tweens: TweenRuntime;
  readonly timelines: TimelineRuntime;
  readonly subsystems: RuntimeSubsystems;
  readonly admission: OwnerAdmission;
  readonly renderSlots: RenderSlots;
  readonly renderEmitter: RenderCommandEmitter;
  readonly audioParticles: AudioParticleEmitter;
  readonly delays: LatentDelays;
  readonly timers: ScriptTimers;
  readonly cameraShakes: CameraShakes;
  readonly navigation: RuntimeNavigation;
  readonly streams: SceneStreams;
  readonly sceneRealizer: SceneRealizer;
  readonly boundaries: SessionBoundaries;
  readonly animGraphs: AnimGraphRuntime;
  readonly behaviourTrees: BehaviourTreeRuntime;
  readonly objectLifetime: RuntimeObjectLifetime;
  readonly actors: ActorRealization;
  readonly camera: RuntimeCamera;
  readonly waits: SimulationWaits;
  readonly simulation: SimulationSession;
  readonly scriptRuntime: ScriptRuntime;
  readonly inspector: RuntimeInspectorService;
  readonly materialParameters: RuntimeMaterialParameters;
  readonly propertyWrites: RuntimePropertyWrites;
  readonly scalability: ScalabilitySession;
  readonly physics: RuntimePhysicsWorlds;
  readonly console: RuntimeConsole;
  readonly world: World;
  readonly snapshots: SnapshotPublisher;
  readonly ticks: TickPipeline;
  readonly dynamicMeshes: DynamicRuntimeMeshSync;
  readonly movement: MovementWorldSync;
  readonly cables: CableWorldSync;
  readonly springArmProbes: SpringArmProbeSync;
  readonly ragdolls: RagdollWorldSync;
  readonly uiControls: UIControls2DRuntime;
  readonly overlay: SceneLayerOverlay;
  readonly layers: SceneLayers;
  readonly dataCatalog: RuntimeDataCatalog;
  readonly curveCatalog: ReadonlyMap<string, CurveAssetCatalogEntry>;
  readonly cameraShakeCatalog: ReadonlyMap<string, CameraShakeCatalogEntry>;
  readonly scriptHost: ScriptHost;
  readonly scriptDebug: ScriptDebugObserver;

  // Driver operations.
  emit(command: CommandMessage): void;
  actorSlot(actor: Actor): number | undefined;
  guidSlot(guid: string): number | undefined;
  setActorSpriteClip(actor: Actor, clip: SpriteClipState | null): void;
  setPauseReason(reason: SessionPauseReason, paused: boolean): void;
  resetInputState(): void;
  settlePauseChanges(): void;
  bindUserCommand(def: Omit<UserCommandDef, "run"> & { classId: string }): void;
  spawnScriptedActor(options: ScriptedActorSpawn): Actor | null;
  prepareScriptedActor(options: ScriptedActorSpawn): Actor | null;
  finishScriptedActor(actor: Actor): Actor | null;
  createScriptedObject(classId: string): EngineObject | null;
}

export function setWorldGravity(rt: RuntimeComposition, gravity: { x: number; y: number; z: number }): void {
  const next = rt.physics.setGravity(gravity);
  if (rt.playScene) {
    // Prepared authoring content is also the immutable Simulation baseline.
    rt.playScene = { ...rt.playScene, settings: { ...rt.playScene.settings, gravity: next } };
  }
  const scene = rt.world.currentScene;
  if (scene && !scene.destroyed) {
    scene.setVariable("gravity", { x: next[0], y: next[1], z: next[2] });
  }
}

/**
 * Stop order: Delays resume in phase 1, then every scene stream retires;
 * physics-owning syncs release before the physics worlds, then the crowd
 * and the remaining debug overlays. Actor removal first retires a stream
 * the actor owns, then ragdolls, cables, spring arm probes, dynamic meshes and
 * animation graphs; a released slot then drops its ragdoll/cable/probe/mesh and BT state,
 * its owner's text reveal, its sent component-command state and, last,
 * a `RuntimeCamera` possession that targeted it. Scene Layers register next to
 * last: phase 1 cancels independent layer creation and removes its layers,
 * then the Scene realizer cancels the main Scene's realization and cleans
 * up what it acquired.
 */
export function registerRuntimeSubsystems(rt: RuntimeComposition): void {
  rt.subsystems.register(rt.delays);
  rt.subsystems.register(rt.timers);
  rt.subsystems.register(rt.cameraShakes);
  rt.subsystems.register(rt.streams);
  rt.subsystems.register(rt.ragdolls);
  rt.subsystems.register(rt.cables);
  rt.subsystems.register(rt.springArmProbes);
  rt.subsystems.register(rt.dynamicMeshes);
  rt.subsystems.register(rt.movement);
  rt.subsystems.register(rt.physics);
  rt.subsystems.register(rt.navigation);
  rt.subsystems.register(rt.animGraphs);
  rt.subsystems.register(rt.behaviourTrees);
  rt.subsystems.register(rt.particleEffects);
  rt.subsystems.register(rt.textAppear);
  rt.subsystems.register(rt.renderEmitter);
  rt.subsystems.register(rt.camera);
  rt.subsystems.register(rt.layers);
  rt.subsystems.register(rt.sceneRealizer);
  rt.subsystems.register(rt.objectLifetime);
}

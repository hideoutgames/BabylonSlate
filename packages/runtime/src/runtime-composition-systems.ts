import type { TilemapPayload, TilesetPayload } from "@haptic/assets";
import { ScalabilitySession } from "@haptic/core";
import { World, type Actor, type ClassRegistry } from "@haptic/object-model";
import { AnimGraphRuntime } from "./anim-graph-runtime";
import { AudioParticleEmitter } from "./audio-particle-emitter";
import { BehaviourTreeRuntime } from "./behaviour-tree-runtime";
import { CableWorldSync } from "./cable-sync";
import type { RuntimeDriverOptions } from "./driver-types";
import { DynamicRuntimeMeshSync } from "./dynamic-runtime-mesh";
import { MovementWorldSync } from "./movement";
import { RagdollWorldSync } from "./ragdoll-sync";
import { RenderCommandEmitter } from "./render-command-emitter";
import { RenderSlots } from "./render-slots";
import { RuntimeCamera } from "./runtime-camera";
import type { RuntimeComposition } from "./runtime-composition";
import { RuntimeConsole } from "./runtime-console";
import { recordDiagnostic } from "./runtime-error-reporting";
import { createWorldInputProvider } from "./runtime-host-input";
import { RuntimeInspectorService } from "./runtime-inspector-service";
import { RuntimeNavigation } from "./runtime-navigation";
import { RuntimePhysicsWorlds } from "./runtime-physics-worlds";
import { RuntimePropertyWrites } from "./runtime-property-writes";
import { requestDeviceMotion, runTick } from "./runtime-tick-phases";
import { ScriptDebugObserver } from "./script-debug";
import { ScriptRuntime } from "./script-runtime";
import { SnapshotPublisher } from "./snapshot-publisher";
import { TickPipeline } from "./tick-pipeline";
import { UIControls2DRuntime } from "./ui-controls2d-runtime";

export function createRenderSlots(rt: RuntimeComposition): RenderSlots {
  return new RenderSlots(rt.subsystems, {
    ensureCapacity: (required) => rt.snapshots.ensureCapacity(required),
    findActor: (guid) => rt.world.findActor(guid),
  });
}

export function createRenderEmitter(rt: RuntimeComposition): RenderCommandEmitter {
  return new RenderCommandEmitter({
    world: () => rt.world,
    isStreamActor: (actor) => rt.streams.isStreamActor(actor),
    playScene: () => rt.playScene,
    slot: (actor) => rt.actorSlot(actor),
    cables: () => rt.cables,
    dynamicMeshes: () => rt.dynamicMeshes,
    uiControls: () => rt.uiControls,
    painters: () => rt.painters,
    textAppear: () => rt.textAppear,
    materialParameters: () => rt.materialParameters,
    emit: (command) => rt.emit(command),
  });
}

export function createAudioParticles(rt: RuntimeComposition): AudioParticleEmitter {
  return new AudioParticleEmitter(rt.admission, {
    slot: (actor) => rt.actorSlot(actor),
    frameId: () => rt.frameId,
    emit: (command) => rt.emit(command),
  });
}

export function createNavigation(rt: RuntimeComposition): RuntimeNavigation {
  return new RuntimeNavigation({
    world: () => rt.world,
    worldKind: () => rt.physics.kind,
    physics: () => rt.physics.main,
    streamActorReady: (actor) => rt.streams.actorReady(actor),
    isStreamActor: (actor) => rt.streams.isStreamActor(actor),
    actorName: (actor) => debugActorName(actor),
    emit: (command) => rt.emit(command),
    warn: (message) => rt.reportLog(message, "warning", "Navigation"),
  }, nowMs);
}

export function createAnimGraphs(rt: RuntimeComposition): AnimGraphRuntime {
  return new AnimGraphRuntime({
    world: () => rt.world,
    stopped: () => rt.stopped,
    canTick: (actor) => rt.admission.canTickActor(actor),
    slot: (actor) => rt.actorSlot(actor),
    hasRenderSlot: (actor) => rt.renderSlots.recordedSlot(actor) !== undefined,
    playAnimationOwns: (slotId) => rt.behaviourTrees.playAnimationOwns(slotId),
    scripts: () => rt.scriptHost,
    setSpriteClip: (actor, clip) => rt.setActorSpriteClip(actor, clip),
    breakpoints: () => rt.breakpoints,
    emit: (command) => rt.emit(command),
  });
}

export function createBehaviourTrees(rt: RuntimeComposition): BehaviourTreeRuntime {
  return new BehaviourTreeRuntime({
    world: () => rt.world,
    frameActors: () => rt.navFrameActors ?? undefined,
    stopped: () => rt.stopped,
    canTick: (actor) => rt.admission.canTickActor(actor),
    slot: (actor) => rt.actorSlot(actor),
    navigation: () => rt.navigation,
    worldKind: () => rt.physics.kind,
    seed: () => rt.seed,
    frameId: () => rt.frameId,
    tickIndex: () => rt.world.clock.tickIndex,
    scripts: () => rt.scriptHost,
    setSpriteClip: (actor, clip) => rt.setActorSpriteClip(actor, clip),
    actorName: (actor) => debugActorName(actor),
    recordDiagnostic: (diagnostic) => recordDiagnostic(rt, diagnostic),
    breakpoints: () => rt.breakpoints,
    emit: (command) => rt.emit(command),
  }, nowMs);
}

export function createCamera(rt: RuntimeComposition, options: RuntimeDriverOptions): RuntimeCamera {
  return new RuntimeCamera({
    traceDebugDraw: options.traceDebugDraw,
    world: () => rt.world,
    playScene: () => rt.playScene,
    frameId: () => rt.frameId,
    slot: (actor) => rt.actorSlot(actor),
    slotOwner: (slotId) => rt.renderSlots.owner(slotId),
    guidSlot: (guid) => rt.guidSlot(guid),
    streams: () => rt.streams,
    cursor: () => rt.resolvedInput.cursor,
    touches: () => rt.resolvedInput.touches,
    overlay: () => rt.overlay,
    physics: () => rt.physics,
    emit: (command) => rt.emit(command),
  });
}

export function createScriptRuntime(rt: RuntimeComposition, options: RuntimeDriverOptions): ScriptRuntime {
  return new ScriptRuntime(rt.admission, {
    gameInstanceClass: options.gameInstanceClass ?? "GameInstance",
    classAssetGuids: options.classAssetGuids ?? {},
  }, {
    world: () => rt.world,
    stopped: () => rt.stopped,
    scriptHost: () => rt.scriptHost,
    streams: () => rt.streams,
    registerAnchors: (label, anchors) => rt.registerAnchors(label, anchors),
    deleteAnchors: (label) => { rt.anchors.delete(label); },
    bindUserCommand: (def) => rt.bindUserCommand(def),
    reportLog: (message, severity, category) => rt.reportLog(message, severity, category),
  });
}

export function createInspector(rt: RuntimeComposition, options: RuntimeDriverOptions): RuntimeInspectorService {
  return new RuntimeInspectorService({
    deferMaterialEdits: options.deferMaterialEdits === true,
    demandAssetCatalog: rt.demandAssetCatalog,
  }, {
    world: () => rt.world,
    sessionGeneration: () => rt.sessionGeneration,
    sessionMode: () => rt.sessionMode,
    stopped: () => rt.stopped,
    frameId: () => rt.frameId,
    advanceFrameId: () => ++rt.frameId,
    commandRevision: () => rt.commandRevision,
    playSceneGuid: () => rt.playSceneGuid,
    simulation: () => rt.simulation,
    materialParameters: () => rt.materialParameters,
    renderSlots: () => rt.renderSlots,
    renderEmitter: () => rt.renderEmitter,
    streams: () => rt.streams,
    layers: () => rt.layers,
    sceneRealizer: () => rt.sceneRealizer,
    physics: () => rt.physics,
    ragdolls: () => rt.ragdolls,
    assetPreloads: () => rt.assetPreloads,
    refreshComponent: (component, propertyName) => rt.propertyWrites.refreshComponent(component, propertyName),
    setMaterialParameter: (material, name, value) => rt.propertyWrites.setMaterialParameter(material, name, value, true),
    publishSnapshot: () => rt.snapshots.publish(),
    emit: (command) => rt.emit(command),
  });
}

export function createPropertyWrites(rt: RuntimeComposition, options: RuntimeDriverOptions): RuntimePropertyWrites {
  return new RuntimePropertyWrites(rt.admission, {
    validateLegacyMeshParameters: options.materialParameterCatalog !== undefined,
  }, {
    world: () => rt.world,
    simulation: () => rt.simulation,
    materialParameters: () => rt.materialParameters,
    renderSlots: () => rt.renderSlots,
    renderEmitter: () => rt.renderEmitter,
    uiControls: () => rt.uiControls,
    overlay: () => rt.overlay,
    textAppear: () => rt.textAppear,
    ticks: () => rt.ticks,
    audioParticles: () => rt.audioParticles,
    navigation: () => rt.navigation,
    physics: () => rt.physics,
    ragdolls: () => rt.ragdolls,
    layers: () => rt.layers,
    sceneRealizer: () => rt.sceneRealizer,
    emit: (command) => rt.emit(command),
  });
}

export function createScalability(rt: RuntimeComposition, options: RuntimeDriverOptions): ScalabilitySession {
  return new ScalabilitySession(options.renderSettings, options.frameCap, options.playScene?.settings,
    (transaction) => rt.emit({ type: "setScalability", transaction }));
}

export function createPhysics(
  rt: RuntimeComposition,
  options: RuntimeDriverOptions,
  tilemaps: Map<string, TilemapPayload>,
  tilesets: Map<string, TilesetPayload>,
): RuntimePhysicsWorlds {
  return new RuntimePhysicsWorlds({
    world: () => rt.world,
    stopped: () => rt.stopped,
    lifecycleId: () => rt.lifecycleId,
    mainActorReady: (actor) => rt.streams.actorReady(actor),
    overlayActorReady: (actor) => rt.admission.canTickActor(actor, true),
    hasPhysicsSceneLayers: () => [...rt.sceneLayerLibrary.values()].some((layer) => layer.settings?.physicsEnabled === true),
    canTickActor: (actor) => rt.admission.canTickActor(actor),
    scripts: () => rt.scriptHost,
    frameId: () => rt.frameId,
    recordDiagnostic: (diagnostic) => recordDiagnostic(rt, diagnostic),
    emit: (command) => rt.emit(command),
  }, {
    kind: options.physicsWorld ?? options.playScene?.settings.physicsWorld ?? "3d",
    gravity: options.gravity ?? [0, -9.81, 0],
    havokWasmUrl: options.havokWasmUrl,
    preferSoftware: options.preferSoftwarePhysics ?? false,
    pixelsPerUnit: options.pixelsPerUnit,
    tilemaps,
    tilesets,
    waterBlendDistance: options.renderSettings?.water?.blendDistance,
    collisionPresets: options.collisionPresets,
  });
}

export function createConsole(rt: RuntimeComposition, options: RuntimeDriverOptions): RuntimeConsole {
  return new RuntimeConsole({
    includeDebug: options.includeDebugCommands ?? true,
    demandAssetCatalog: rt.demandAssetCatalog,
  }, {
    world: () => rt.world,
    stopped: () => rt.stopped,
    sessionMode: () => rt.sessionMode,
    classAssetGuid: (classId) => rt.scriptRuntime.classAssetGuid(classId),
    scriptHost: () => rt.scriptHost,
    assetPreloads: () => rt.assetPreloads,
    sceneRealizer: () => rt.sceneRealizer,
    scalability: () => rt.scalability,
    requestScalability: (request) => { rt.requestScalability(request); },
    physics: () => rt.physics,
    navigation: () => rt.navigation,
    behaviourTrees: () => rt.behaviourTrees,
    audioParticles: () => rt.audioParticles,
    ticks: () => rt.ticks,
    snapshots: () => rt.snapshots,
    logs: () => rt.logs,
    inspectWorld: () => rt.inspectWorld(),
    actorSlot: (actor) => rt.actorSlot(actor),
    possessCamera: (actor) => rt.camera.possess(actor),
    stop: () => rt.stop(),
    pause: () => rt.pause(),
    resume: () => rt.resume(),
    tick: () => rt.tick(),
    paused: () => rt.paused,
    userPaused: () => rt.pauseReasons.has("user"),
    timeDilation: () => rt.timeDilation,
    setTimeDilation: (rate) => rt.setTimeDilation(rate),
    objectLifetime: () => rt.objectLifetime,
    emit: (command) => rt.emit(command),
  });
}

/** World physics phase order: dynamic meshes, ragdolls, main and Scene Layer steps, cables, contacts. */
export function createWorld(rt: RuntimeComposition, options: RuntimeDriverOptions, registry: ClassRegistry): World {
  let guidSeq = 0;
  return new World({
    seed: options.seed,
    dt: rt.dt,
    classRegistry: registry,
    guidFactory: () => `rt-${++guidSeq}`,
    onPhase: (phase) => rt.ticks.markPhase(phase),
    canTickScene: () => !rt.stopped && !rt.blocks.active,
    canTickActor: (actor) => rt.admission.canTickActor(actor),
    componentHooksFor: (classId) => rt.actors.componentHooks(classId),
    sceneSubsystemHooksFor: (classId) => rt.scriptRuntime.sceneSubsystemHooks(classId),
    // Strict gate: Tick only after On Init, while the main Scene may run.
    canTickSceneSubsystem: (subsystem) =>
      rt.admission.isCreated(subsystem) && rt.admission.canRunSceneSubsystem(subsystem),
    onPhysics: (ctx) => {
      rt.dynamicMeshes.flush();
      rt.ragdolls.sync();
      if (rt.admission.canTickScene()) rt.physics.stepMain(ctx.dt, rt.waterClock.stepTime, (sync) => rt.movement.step(ctx.dt, sync));
      if (rt.admission.hasReadyLayers()) rt.physics.stepLayers(ctx.dt, (sync) => rt.movement.step(ctx.dt, sync));
      rt.ragdolls.afterStep();
      if (rt.admission.canTickScene()) rt.cables.step(ctx.dt, rt.physics.gravity, rt.frameId + 1);
      rt.physics.dispatchCollisionEvents();
    },
  });
}

export function createSnapshots(rt: RuntimeComposition, options: RuntimeDriverOptions): SnapshotPublisher {
  return new SnapshotPublisher(options.maxActors ?? 256, rt.world, rt.renderSlots, {
    stopped: () => rt.stopped,
    frameId: () => rt.frameId,
    lastScriptMs: () => rt.ticks.lastScriptMs,
    lastPhysicsMs: () => rt.ticks.lastPhysicsMs,
    canPublish: () => rt.admission.canTickScene() || rt.admission.hasReadyLayers(),
    cameraActor: () => rt.camera.cameraActor(),
    applyOverlayLayouts: () => rt.overlay.applyLayouts(),
    retireDetachedStreams: () => rt.streams.retireDetached(),
    removedActors: () => rt.behaviourTrees.emitSnapshot(true),
    recorder: () => rt.ticks.recorder,
    profilePublish: (milliseconds) => rt.ticks.profilePublish(milliseconds),
    reportLog: (message, severity, category) => rt.reportLog(message, severity, category),
    reportError: (error) => { rt.reportError(error); },
    emit: (command) => rt.emit(command),
  }, nowMs);
}

export function createTickPipeline(rt: RuntimeComposition, options: RuntimeDriverOptions): TickPipeline {
  return new TickPipeline(rt.world, rt.snapshots, rt.logs, {
    canTick: () => rt.running && !rt.paused && !rt.boundaries.saveBoundaryActive && !rt.blocks.active,
    canAdvance: () => rt.running && !rt.paused && !rt.blocks.active,
    paused: () => rt.paused,
    stopped: () => rt.stopped,
    runTick: () => runTick(rt),
    settlePauseChanges: () => rt.settlePauseChanges(),
    frameId: () => rt.frameId,
    liveActors: () => rt.renderSlots.size,
    objectLifetime: () => ({ collectable: rt.objectLifetime.collector.size, lastPassMs: rt.objectLifetime.lastPass?.ms ?? null }),
    traceState: () => ({
      bt: rt.behaviourTrees.traceStates(),
      audio: rt.voices.traceState(),
      sprites: rt.spriteClips.traceStates(rt.world.getActors()),
      animGraphs: rt.animGraphs.traceStates(),
    }),
    reportLog: (message, severity, category) => rt.reportLog(message, severity, category),
    emit: (command) => rt.emit(command),
    meterScripts: (meter) => rt.scriptHost.setCostMeter(meter),
  }, {
    dt: rt.dt,
    seed: rt.seed,
    generation: rt.sessionGeneration,
    mode: rt.sessionMode,
    diagnosticsEnabled: options.includeDebugCommands ?? true,
    traceByteBudget: options.traceByteBudget,
  }, nowMs);
}

export function createDynamicMeshes(rt: RuntimeComposition): DynamicRuntimeMeshSync {
  return new DynamicRuntimeMeshSync({
    eligible: (actor) => !actor.sceneLayerId && rt.admission.canRun(actor),
    slot: (actor) => rt.actorSlot(actor),
    emit: (command) => rt.emit(command),
  });
}

export function createMovement(rt: RuntimeComposition): MovementWorldSync {
  return new MovementWorldSync({
    world: rt.world,
    physics: (actor) => rt.physics.forActor(actor),
    eligible: (actor) => rt.admission.canTickActor(actor),
    gravity: (actor) => -rt.physics.gravityFor(actor)[1],
    warn: (component) => rt.emit({ type: "log", severity: "warning", category: "Movement",
      message: `Movement on ${component.owner?.guid ?? "actor"} could not create its motor. Use one Movement component without Nav Agent, Ragdoll or Water Buoyancy components, and with a Rigid Body only if its Motion Type is Dynamic or Kinematic.`, frameId: rt.frameId }),
    event: (component, event, args) => {
      const actor = component.owner;
      if (actor) rt.admission.guard(() => rt.scriptHost.invokeEvent(actor.classId, event, actor, args, component.guid));
    },
  });
}

export function createCables(rt: RuntimeComposition): CableWorldSync {
  return new CableWorldSync({
    world: rt.world,
    physics: () => rt.physics.main.getBackend(),
    eligible: (actor) => rt.admission.canTickActor(actor),
    slot: (actor) => rt.actorSlot(actor),
    emit: (command) => rt.emit(command),
  });
}

export function createRagdolls(rt: RuntimeComposition): RagdollWorldSync {
  return new RagdollWorldSync({
    world: rt.world,
    physics: () => rt.physics.main,
    slot: (actor) => rt.actorSlot(actor),
    eligible: (actor) => rt.admission.canTickActor(actor),
    deferNative: !rt.physics.preferSoftware,
    emit: (command) => rt.emit(command),
    error: (error) => { rt.reportError(error); },
  });
}

export function createUIControls(rt: RuntimeComposition): UIControls2DRuntime {
  return new UIControls2DRuntime({
    actors: () => rt.world.getActors(),
    canRun: (actor) => !rt.stopped && rt.admission.canTickActor(actor),
    update: (component, properties) => {
      const slotId = component.owner ? rt.actorSlot(component.owner) : undefined;
      if (slotId !== undefined) rt.emit({ type: "setUIControl2D", slotId, componentId: component.guid,
        uiControl: { classId: component.classId, properties } });
    },
    event: (component, event, args) => {
      const actor = component.owner;
      if (actor && !actor.destroyed && !component.destroyed && rt.admission.canTickActor(actor)) {
        rt.scriptHost.invokeEvent(actor.classId, event, actor, args, component.guid);
      }
    },
  });
}

export function installWorldInputProvider(rt: RuntimeComposition): void {
  rt.world.setInputProvider(createWorldInputProvider({
    resolved: () => rt.resolvedInput,
    connections: rt.connectionBox,
    frameId: () => rt.frameId,
    emit: (command) => rt.emit(command),
    requestDeviceMotion: () => requestDeviceMotion(rt),
    calibrateTilt: () => rt.resolver.calibrateTilt(),
  }));
}

export function createScriptDebug(rt: RuntimeComposition): ScriptDebugObserver {
  return new ScriptDebugObserver({
    world: () => rt.world,
    emit: (command) => rt.emit(command),
    setDebugTrace: (object, sink) => {
      rt.scriptHost.setDebugTrace(object, sink);
      rt.behaviourTrees.setDebugTrace(object, sink);
      rt.animGraphs.setDebugTrace(object, sink);
    },
  });
}

function debugActorName(actor: Actor): string {
  const name = actor.getVariable("name");
  return typeof name === "string" && name.trim() ? name : actor.classId;
}

function nowMs(): number {
  return typeof performance !== "undefined" && performance.now
    ? performance.now()
    : Date.now();
}

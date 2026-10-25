import { createActorFromSerialized } from "@haptic/object-model";
import { ActorRealization } from "./actor-realization";
import type { RuntimeDriverOptions } from "./driver-types";
import { OwnerAdmission } from "./owner-admission";
import { setWorldGravity, type RuntimeComposition } from "./runtime-composition";
import { SceneLayerOverlay } from "./scene-layer-overlay";
import { SceneLayers } from "./scene-layers";
import { SceneRealizer } from "./scene-realizer";
import { SceneStreams } from "./scene-streams";
import { SessionBoundaries } from "./session-boundaries";
import { SimulationSession } from "./simulation-session";
import { SimulationWaits } from "./simulation-waits";

export function createAdmission(rt: RuntimeComposition): OwnerAdmission {
  return new OwnerAdmission({
    world: () => rt.world,
    stopped: () => rt.stopped,
    paused: () => rt.paused,
    saveBoundaryActive: () => rt.boundaries.saveBoundaryActive,
    sceneLoading: () => rt.sceneRealizer.blocked || rt.bootLoading,
    streams: () => rt.streams,
    blocks: () => rt.blocks,
    layers: () => rt.layers,
    releaseAssets: (ownerGuid) => rt.assetPreloads.releaseOwner(ownerGuid),
    reportError: (error) => { rt.reportError(error); },
  });
}

export function createStreams(rt: RuntimeComposition): SceneStreams {
  return new SceneStreams(rt.admission, {
    world: () => rt.world,
    stopped: () => rt.stopped,
    physicsWorldKind: () => rt.physics.kind,
    sceneDocument: (key) => rt.sceneLibrary.get(key),
    sceneGuid: (key) => rt.sceneGuidByKey.get(key) ?? key,
    acquireScene: () => rt.acquireScene,
    cooperativeLoading: () => rt.cooperativeSceneLoading ?? {},
    deferModelsReady: () => rt.deferSceneModelsReady,
    scripts: () => rt.scriptHost,
    createActor: (serialized) => createActorFromSerialized(rt.world, serialized, rt.actors.sceneActorHooks),
    realizeActor: (actor, checkpoint) => rt.actors.realize(actor, checkpoint),
    breakParentCycles: (actors, detach) => rt.actors.breakLoadedParentCycles(actors, detach),
    publishSnapshot: () => rt.snapshots.publish(),
    slot: (actor) => rt.actorSlot(actor),
    syncPhysics: () => rt.physics.main.syncFromWorld(rt.world),
    navigation: () => rt.navigation,
    removeActor: (actor) => rt.actors.remove(actor),
    cancelInvalidTweens: () => rt.tweens.cancelInvalid(),
    releaseAssets: (ownerGuid) => rt.assetPreloads.releaseOwner(ownerGuid),
    markUnsupportedInstance: (sceneGuid) => rt.simulation.markUnsupportedInstance("stream", sceneGuid),
    blocks: () => rt.blocks,
    emit: (command) => rt.emit(command),
  });
}

export function createSceneRealizer(rt: RuntimeComposition): SceneRealizer {
  return new SceneRealizer(rt.admission, {
    world: () => rt.world,
    stopped: () => rt.stopped,
    frameId: () => rt.frameId,
    playScene: () => rt.playScene,
    playSceneGuid: () => rt.playSceneGuid,
    enterScene: (scene, guid) => {
      rt.playScene = scene;
      rt.scalability.setScene(scene.settings);
      rt.playSceneGuid = guid;
      rt.camera.resetPossession();
    },
    sceneLibrary: () => rt.sceneLibrary,
    sceneGuid: (key) => rt.sceneGuidByKey.get(key) ?? key,
    acquireScene: () => rt.acquireScene,
    cooperativeLoading: () => rt.cooperativeSceneLoading,
    bootLoading: () => rt.bootLoading,
    deferModelsReady: () => rt.deferSceneModelsReady,
    deferLoadingPaint: () => rt.deferSceneLoadingPaint,
    physics: () => rt.physics,
    navigation: () => rt.navigation,
    layers: () => rt.layers,
    scripts: () => rt.scriptHost,
    startWorld: () => {
      rt.tilemapAnimationTimeMs = 0;
      if (rt.hasAnimatedTiles) rt.emit({ type: "tilemapAnimationTime", elapsedMs: 0 });
      rt.loopGuard.reset();
      rt.world.start();
    },
    setWorldGravity: (gravity) => setWorldGravity(rt, gravity),
    recordSimulationStart: (start) => rt.simulation.recordStart(start),
    markSceneTransition: () => rt.simulation.markSceneTransition(),
    createActor: (serialized) => createActorFromSerialized(rt.world, serialized, rt.actors.sceneActorHooks),
    realizeActor: (actor, checkpoint) => rt.actors.realize(actor, checkpoint),
    breakParentCycles: (actors) => rt.actors.breakLoadedParentCycles(actors),
    possessViewTarget: () => rt.camera.possessViewTarget(),
    publishSnapshot: () => rt.snapshots.publish(),
    removeActor: (actor) => rt.actors.remove(actor),
    removeSceneLayer: (layerGuid) => rt.removeSceneLayer(layerGuid),
    releaseAssets: (ownerGuid) => rt.assetPreloads.releaseOwner(ownerGuid),
    resetForSceneLoad: () => rt.subsystems.resetForSceneLoad(),
    duringSceneTeardown: (teardown) => rt.scriptRuntime.duringSceneTeardown(teardown),
    retireStreams: () => rt.streams.retireAll(),
    emitSceneDebug: () => {
      rt.navigation.emitDebug(true);
      rt.behaviourTrees.emitSnapshot(true);
    },
    reportError: (error) => { rt.reportError(error); },
    emit: (command) => rt.emit(command),
  });
}

export function createBoundaries(rt: RuntimeComposition): SessionBoundaries {
  return new SessionBoundaries(rt.admission, {
    world: () => rt.world,
    sessionGeneration: () => rt.sessionGeneration,
    stopped: () => rt.stopped,
    playScene: () => rt.playScene,
    playSceneGuid: () => rt.playSceneGuid,
    sceneLibrary: () => rt.sceneLibrary,
    scripts: () => rt.scriptHost,
    streams: () => rt.streams,
    blocks: () => rt.blocks,
    sceneRealizer: () => rt.sceneRealizer,
    physics: () => rt.physics,
    actorHooks: () => rt.actors.sceneActorHooks,
    canSpawnActorClass: (classId) => rt.scriptRuntime.canSpawnActorClass(classId),
    realizeActor: (actor) => rt.actors.realize(actor),
    removeActor: (actor) => rt.actors.remove(actor),
    publishSnapshot: () => rt.snapshots.publish(),
    takeDeferredOverlayLayout: () => rt.overlay.takeDeferredLayout(),
    pauseReasons: () => rt.pauseReasons,
    setPauseReason: (reason, paused) => rt.setPauseReason(reason, paused),
    stepPausedTick: () => {
      rt.resume();
      // A throwing tick still returns to pause; Step never leaves the game running.
      try { rt.tick(); } finally { rt.pause(); }
    },
    resetInputState: () => rt.resetInputState(),
    commandRevision: () => rt.commandRevision,
    reportError: (error) => { rt.reportError(error); },
  });
}

export function createActorRealization(rt: RuntimeComposition): ActorRealization {
  return new ActorRealization(rt.admission, {
    world: () => rt.world,
    stopped: () => rt.stopped,
    scripts: () => rt.scriptHost,
    scriptRuntime: () => rt.scriptRuntime,
    streams: () => rt.streams,
    boundaries: () => rt.boundaries,
    physicsKind: () => rt.physics.kind,
    renderSlots: () => rt.renderSlots,
    renderEmitter: () => rt.renderEmitter,
    audioParticles: () => rt.audioParticles,
    overlay: () => rt.overlay,
    movement: () => rt.movement,
    dynamicMeshes: () => rt.dynamicMeshes,
    textAppear: () => rt.textAppear,
    subsystems: () => rt.subsystems,
    cancelInvalidTweens: () => rt.tweens.cancelInvalid(),
    frameActors: () => rt.navFrameActors,
    reportLog: (message, severity, category) => rt.reportLog(message, severity, category),
    emit: (command) => rt.emit(command),
  });
}

export function createWaits(rt: RuntimeComposition): SimulationWaits {
  return new SimulationWaits({
    stopped: () => rt.stopped,
    paused: () => rt.paused,
    pauseChangePending: () => [...rt.pendingPauseChanges.values()].some(Boolean),
    streams: () => rt.streams,
    blocks: () => rt.blocks,
    boundaries: () => rt.boundaries,
  });
}

export function createSimulation(rt: RuntimeComposition, options: RuntimeDriverOptions): SimulationSession {
  return new SimulationSession({
    baseline: options.sessionMode === "simulate" ? options.playScene ?? null : null,
    assetGuids: options.simulationAssetGuids ?? [...Object.keys(options.materialParameterCatalog ?? {}), ...(options.materialTextureAssetGuids ?? []), ...(options.audioAssetGuids ?? [])],
    dataAssets: options.sessionMode === "simulate" ? options.dataAssets : undefined,
  }, {
    world: () => rt.world,
    sessionGeneration: () => rt.sessionGeneration,
    sessionMode: () => rt.sessionMode,
    stopped: () => rt.stopped,
    playSceneGuid: () => rt.playSceneGuid,
    bootLoading: () => rt.bootLoading,
    commandRevision: () => rt.commandRevision,
    boundaries: () => rt.boundaries,
    sceneRealizer: () => rt.sceneRealizer,
    streams: () => rt.streams,
    blocks: () => rt.blocks,
    layers: () => rt.layers,
    materialEditGate: () => rt.inspector.materialEditGate,
    materialParameters: () => rt.materialParameters,
    physics: () => rt.physics,
    scripts: () => rt.scriptHost,
    setPauseReason: (reason, paused) => rt.setPauseReason(reason, paused),
    resetInputState: () => rt.resetInputState(),
    flushInspectorRequests: () => rt.inspector.flushQueued(),
    flushDeferredSnapshot: () => rt.snapshots.flushDeferred(),
    emit: (command) => rt.emit(command),
  });
}

export function createOverlay(rt: RuntimeComposition, options: RuntimeDriverOptions): SceneLayerOverlay {
  return new SceneLayerOverlay({
    world: rt.world,
    focusNavigation: options.focusNavigation,
    admission: rt.admission,
    uiControls: rt.uiControls,
    render: rt.renderEmitter,
    audioParticles: rt.audioParticles,
    texturePixelSizes: options.texturePixelSizes ?? {},
  }, {
    stopped: () => rt.stopped,
    saveBoundaryActive: () => rt.boundaries.saveBoundaryActive,
    removing: (actor) => rt.actors.removing(actor),
    pixelsPerUnit: () => rt.physics.pixelsPerUnit,
    scripts: () => rt.scriptHost,
    slot: (actor) => rt.actorSlot(actor),
    guidSlot: (guid) => rt.guidSlot(guid),
    actorHooks: (classId) => rt.actors.sceneActorHooks(classId),
    prepareActor: (actor) => {
      rt.scriptHost.bindInterfaceHandlers(actor);
      rt.actors.applyDefaults(actor);
      rt.actors.assignSlot(actor);
    },
    breakParentCycles: (actors) => rt.actors.breakLoadedParentCycles(actors),
    realizeActor: (actor) => rt.actors.realize(actor),
    removeActor: (actor) => rt.actors.remove(actor),
    publishSnapshot: () => rt.snapshots.publish(),
    syncOverlayPhysics: () => rt.physics.syncLayers(),
    emit: (command) => rt.emit(command),
  });
}

export function createLayers(rt: RuntimeComposition): SceneLayers {
  return new SceneLayers(rt.admission, rt.overlay, {
    world: () => rt.world,
    stopped: () => rt.stopped,
    frameId: () => rt.frameId,
    bootLoading: () => rt.bootLoading,
    cooperativeLoading: () => rt.cooperativeSceneLoading,
    deferModelsReady: () => rt.deferSceneModelsReady,
    deferLoadingPaint: () => rt.deferSceneLoadingPaint,
    document: (assetGuid) => rt.sceneLayerLibrary.get(assetGuid),
    demandAssets: () => rt.demandAssetCatalog,
    assetPreloads: () => rt.assetPreloads,
    continueSimulation: (owner) => rt.waits.continueSimulation(owner),
    addLayerPhysics: (layerGuid, assetGuid, settings, actors) => rt.physics.addLayer(layerGuid, assetGuid, settings, actors),
    removeLayerPhysics: (layerGuid) => rt.physics.removeLayer(layerGuid),
    markUnsupportedInstance: (layerGuid) => rt.simulation.markUnsupportedInstance("layer", layerGuid),
    createActor: (serialized, layerGuid) => createActorFromSerialized(rt.world, serialized, rt.actors.sceneActorHooks, layerGuid),
    publishSnapshot: () => rt.snapshots.publish(),
    syncOverlayPhysics: () => rt.physics.syncLayers(),
    tryCompleteSceneLoad: () => rt.sceneRealizer.tryCompleteSceneLoad(),
    removeActor: (actor) => rt.actors.remove(actor),
    cancelInvalidTweens: () => rt.tweens.cancelInvalid(),
    reportError: (error) => { rt.reportError(error); },
    emit: (command) => rt.emit(command),
  });
}

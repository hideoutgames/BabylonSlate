import { timelineClipControl } from "./timeline-runtime";
import type { CommandMessage } from "@haptic/bridge";
import type { Actor, ClassRegistry, EngineObject } from "@haptic/object-model";
import { RuntimeAssetCatalog } from "./asset-catalog";
import { createAudioHostBindings } from "./audio-particle-emitter";
import type { RuntimeDriverOptions } from "./driver-types";
import { setWorldGravity, type RuntimeComposition } from "./runtime-composition";
import { recordDiagnostic } from "./runtime-error-reporting";
import { createActorHostBindings } from "./runtime-host-actors";
import { createAssetHostBindings } from "./runtime-host-assets";
import { createComponentHostBindings } from "./runtime-host-components";
import { createNavigationHostBindings } from "./runtime-host-navigation";
import { createOutputHostBindings } from "./runtime-host-output";
import { createPhysicsHostBindings } from "./runtime-host-physics";
import {
  createIlluminationHostBindings,
  createMaterialHostBindings,
  createRenderTargetHostBindings,
  createScalabilityHostBindings,
} from "./runtime-host-render";
import { createTimingHostBindings } from "./runtime-host-timing";
import { flushPainters, flushTextAppear } from "./runtime-tick-phases";
import { createSceneLayerOverlayHostBindings } from "./scene-layer-overlay";
import { createSceneLayerHostBindings } from "./scene-layers";
import { createSceneStreamHostBindings } from "./scene-streams";
import { ScriptHost } from "./script-host";

export function createScriptHost(rt: RuntimeComposition, options: RuntimeDriverOptions, registry: ClassRegistry): ScriptHost {
  const projectName = options.project?.name ?? "";
  const projectVersion = options.project?.version ?? "";
  const noticesUrl = options.thirdPartyNoticesUrl;
  let notices: Promise<string> | null = null;
  const getThirdPartyNotices = noticesUrl
    ? (): Promise<string> => {
        // One read per session; a failed read is retried on the next call.
        notices ??= fetch(noticesUrl).then(async (response) => {
          if (!response.ok) throw new Error(`Third-party notices could not be read (HTTP ${response.status}).`);
          return response.text();
        });
        return notices.catch((error: unknown) => {
          notices = null;
          throw error;
        });
      }
    : undefined;
  const emit = (command: CommandMessage): void => rt.emit(command);
  const frameId = (): number => rt.frameId;
  const slot = (actor: Actor): number | undefined => rt.actorSlot(actor);
  const canRun = (owner: EngineObject): boolean => rt.admission.canRun(owner);
  const continueSimulation = (owner: EngineObject | null): Promise<void> | undefined => rt.waits.continueSimulation(owner);
  const assetCatalog = new RuntimeAssetCatalog(options.assetCatalog);
  return new ScriptHost({
    data: rt.dataCatalog,
    curves: rt.curveCatalog,
    getAssetCatalog: () => assetCatalog,
    seed: options.seed,
    canRunOwner: (owner) => rt.admission.canRun(owner),
    inputBindings: rt.resolver.bindings,
    getInputState: (input) => rt.resolver.getInputState(input),
    interfaceRegistry: rt.world.interfaceRegistry,
    classRegistry: registry,
    checkInfiniteLoop: () => rt.loopGuard.check(),
    traceDebugDraw: options.traceDebugDraw,
    ...createOutputHostBindings({
      frameId,
      tickIndex: () => rt.world.clock.tickIndex,
      anchors: rt.anchors,
      recordDiagnostic: (diagnostic) => recordDiagnostic(rt, diagnostic),
      recordPrint: (print) => rt.ticks.recordPrint(print),
      emit,
    }),
    createObject: (classId) => rt.createScriptedObject(classId),
    collectGarbage: () => rt.objectLifetime.request(),
    ...createActorHostBindings({
      world: () => rt.world,
      stopped: () => rt.stopped,
      scripts: () => rt.scriptHost,
      audioParticles: rt.audioParticles,
      tweens: rt.tweens,
      classAssetGuids: rt.scriptRuntime.classAssetGuids,
      demandAssetCatalog: rt.demandAssetCatalog,
      assetPreloads: rt.assetPreloads,
      spawn: (spawn) => rt.spawnScriptedActor(spawn),
      prepareSpawn: (spawn) => rt.prepareScriptedActor(spawn),
      finishSpawn: (actor) => rt.finishScriptedActor(actor),
      continueSimulation,
      slot,
      emit,
    }),
    ...createAssetHostBindings({
      world: () => rt.world,
      demandAssetCatalog: rt.demandAssetCatalog,
      classAssetGuids: rt.scriptRuntime.classAssetGuids,
      assetPreloads: rt.assetPreloads,
      blocks: rt.blocks,
      continueSimulation,
    }),
    ...createTimingHostBindings({
      tweens: rt.tweens,
      delays: rt.delays,
      stopped: () => rt.stopped,
      continueSimulation,
    }),
    ...createPhysicsHostBindings({
      world: () => rt.world,
      physics: () => rt.physics.main,
      layerPhysics: (layerGuid) => rt.physics.layer(layerGuid),
      physicsFor: (actor) => rt.physics.forActor(actor),
      ragdolls: rt.ragdolls,
      movement: rt.movement,
      waterTime: () => rt.waterClock.time,
      projectCursorToScene: (channel, options, sceneLayerId) => sceneLayerId
        ? rt.camera.projectCursorToSceneLayer(sceneLayerId, channel)
        : rt.camera.projectCursorToScene(channel, options),
      projectTouchToScene: (finger, channel, options, sceneLayerId) => sceneLayerId
        ? rt.camera.projectTouchToSceneLayer(sceneLayerId, finger, channel)
        : rt.camera.projectTouchToScene(finger, channel, options),
    }),
    ...createScalabilityHostBindings({
      getScalability: () => rt.getScalability(),
      requestScalability: (request) => rt.requestScalability(request),
    }),
    ...createMaterialHostBindings({
      canRun,
      materialParameters: rt.materialParameters,
      setMaterialParameter: (material, name, parameter) => rt.propertyWrites.setMaterialParameter(material, name, parameter),
    }),
    ...createIlluminationHostBindings({
      slot,
      emitMeshAssignment: (actor, slotId) => rt.renderEmitter.emitMeshAssignment(actor, slotId),
      possessCamera: (target) => rt.camera.possess(target),
    }),
    ...createRenderTargetHostBindings({
      renderTargets: rt.sourceRenderTargets,
      renderTargetTextures: rt.sourceRenderTargetTextures,
      canRun,
      emit,
    }),
    ...createComponentHostBindings({
      painters: rt.painters,
      uiControls: rt.uiControls,
      dynamicMeshes: rt.dynamicMeshes,
      movement: rt.movement,
      textAppear: rt.textAppear,
      processingTick: () => rt.ticks.processing,
      flushPainters: () => flushPainters(rt),
      flushTextAppear: () => flushTextAppear(rt),
      refreshComponent: (component, propertyName) => rt.propertyWrites.refreshComponent(component, propertyName),
    }),
    timelineClip: (owner, clipId) => rt.timelines.clip(owner, clipId),
    timelineClipControl: (clip, action, args) => timelineClipControl(rt.timelines, clip, action, args),
    ...createAudioHostBindings({ frameId, scriptVoiceId: () => rt.voices.scriptVoiceId(), emit }),
    ...createNavigationHostBindings({ navigation: () => rt.navigation }),
    ...createSceneStreamHostBindings({ streams: rt.streams, world: () => rt.world }),
    animGraphControl: (target) => rt.animGraphs.control(target),
    registerSaveActor: (actor, persistentId) => rt.registerSaveActor(actor, persistentId),
    getSaveActorId: (actor) => rt.boundaries.saveActorId(actor),
    resolveSaveActor: (id) => rt.boundaries.findSaveActor(id) ?? rt.world.findActor(id),
    getSubsystem: (classId) => rt.scriptRuntime.findSubsystem(classId),
    getGameInstance: () => rt.world.gameInstance,
    getSceneLoadingProgress: () => {
      const value = rt.sceneRealizer.loadingProgress;
      if (!Number.isFinite(value)) return 0;
      return Math.min(1, Math.max(0, value));
    },
    waitForSimulation: (owner) => rt.waits.continueSimulation(owner) ?? Promise.resolve(),
    getProjectName: () => projectName,
    getProjectVersion: () => projectVersion,
    ...(getThirdPartyNotices ? { getThirdPartyNotices } : {}),
    setWorldGravity: (gravity) => {
      setWorldGravity(rt, gravity);
    },
    executeConsoleCommand: (command) => rt.console.execute(command),
    executeConsoleCommandAsync: (command) => rt.console.executeAsync(command),
    reportError: (error) => {
      rt.reportError(error);
    },
    changeScene: (scene) => {
      rt.sceneRealizer.change(scene);
    },
    ...createSceneLayerHostBindings({ layers: rt.layers }),
    ...createSceneLayerOverlayHostBindings({ overlay: rt.overlay }),
  });
}

import type { CommandMessage } from "@haptic/bridge";
import { createSessionSaveStorage, type ProjectDocument, type SaveGameStorage } from "@haptic/core";
import { applyRuntimeSourceControl, createPlayBootCoordinator, createRuntimeFromLoad, type RuntimeDriver } from "@haptic/runtime";
import { playRegistryViews } from "../lib/play-registry-views";
import { playAssetCatalog } from "../services/asset-catalog";
import { DocumentService } from "../services/document-service";
import { acquirePlayAssetSources, mergePreparedPlaySources, requiredProjectAssets, type PlayAssetSourceHost } from "../services/play-asset-sources";
import { createPlayContentService } from "../services/play-content-service";
import { playLoadControl, playPhysicsFromSceneSettings } from "../services/play-physics";
import type { ProjectService } from "../services/project-service";
import { prepareSaveGameConfiguration } from "../services/save-game-configuration";

/*
 * Runs a project's scene headlessly, as editor Play does without a renderer: the same compile,
 * asset preparation, load control and boot sequence, in-process. Play's host side is answered at
 * once (nothing draws here): loading screens and models count as shown, Scene Layers and streamed
 * scenes as ready, and preloads and streamed scenes get their sources from the same preparation.
 * Havok loads its packaged wasm instead of the editor's URL, and save data stays in memory.
 */

/** Save storage with nothing saved; a session overlay keeps the run's writes in memory. */
const emptySaveStorage: SaveGameStorage = {
  read: async () => null,
  write: async () => {},
  remove: async () => {},
  list: async () => [],
  withLock: (_key, operation) => operation(),
};

export type ProjectSceneRun = {
  /** Session errors: failed asserts, uncaught errors, failed scene loads and a failed boot. */
  problems: string[];
  /** Ticks the session completed. */
  tickIndex: number;
};

export async function runProjectScene(options: {
  project: ProjectService;
  document: ProjectDocument;
  scenePath: string;
  ticks: number;
}): Promise<ProjectSceneRun> {
  const { project, document } = options;
  const registry = project.registry!;
  const playContent = createPlayContentService({
    documents: new DocumentService(),
    project,
    readAssetChunk: (path, chunk) => project.readAssetChunk(path, chunk),
    projectDocument: () => document,
    onPreviewScriptsCompiled: () => {},
  });
  const host: PlayAssetSourceHost = {
    registry,
    project: document,
    createScope: (owner) => project.createAssetLoadScope(owner),
    traceExecution: true,
    compile: (required) => playContent.collectPlayPreviewScripts(required, undefined, document, { traceExecution: true }),
  };
  const sceneGuid = registry.list().find((asset) => asset.path === options.scenePath)?.header.guid;
  if (!sceneGuid) throw new Error(`No scene at ${options.scenePath}`);
  const lifetime = new AbortController();
  const prepared = await acquirePlayAssetSources(host, [sceneGuid, ...requiredProjectAssets(registry, document)],
    { consumer: `Play Scene ${sceneGuid}`, signal: lifetime.signal });
  const sets = [prepared];
  const commands: CommandMessage[] = [];
  let runtime: RuntimeDriver | undefined;
  try {
    const { game, content } = prepared;
    const scene = game.scenes.get(sceneGuid)!;
    const physics = playPhysicsFromSceneSettings(scene.settings);
    const views = playRegistryViews(registry.list());
    const load = playLoadControl({
      sessionMode: "play",
      seed: 1,
      sceneAssetGuid: sceneGuid,
      scene,
      physicsWorld: physics.physicsWorld,
      gravity: physics.gravity,
      gameInstanceClass: document.settings.gameInstanceClass ?? undefined,
      scenes: [...game.scenes].map(([guid, entry]) => ({ guid, scene: entry })),
      sceneLayers: [...game.sceneLayers].map(([guid, layer]) => ({ guid, layer })),
      sceneNavmeshBytes: Object.fromEntries(game.navmeshBytes),
      saveGame: await prepareSaveGameConfiguration({
        projectId: project.guid,
        settings: document.settings.saveGame,
        loadDefinition: (guid) => project.loadDocument("save-game", registry.getByGuid(guid)!.path),
        storage: createSessionSaveStorage(emptySaveStorage),
      }),
      inputAssets: await playContent.collectPlayInputAssets(prepared.required),
      dataAssets: content.dataAssets,
      assetCatalog: playAssetCatalog({ registry, settings: document.settings, sceneGuid }),
      collisionPresets: document.settings.physics.collisionPresets,
      pixelsPerUnit: document.settings.twoD.pixelsPerUnit ?? 100,
      texturePixelSizes: Object.fromEntries(content.texturePixelSizes ?? []),
      audioAssetGuids: views.audioAssetGuids,
      animClipCatalog: views.animClipCatalog,
    });
    load.havokWasmUrl = undefined;
    load.sceneCatalog = views.sceneCatalog;
    load.classAssetGuids = views.classAssetGuids;
    load.consoleCommands = views.consoleCommands;

    // Sources prepared later join the first ones, and the runtime takes the merged controls, as in Play.
    const acquire = async (guids: readonly string[], consumer: string, signal: AbortSignal) => {
      const next = await acquirePlayAssetSources(host, guids, { consumer, signal: AbortSignal.any([signal, lifetime.signal]) });
      sets.push(next);
      for (const control of mergePreparedPlaySources(sets)!.controls) await applyRuntimeSourceControl(runtime!, control);
      return next;
    };
    const answer = (command: CommandMessage) => {
      const session = runtime!;
      switch (command.type) {
        case "sceneLoading": session.notifySceneLoadingPainted(command.sceneAssetGuid, command.sceneLoadId); break;
        case "sceneRealized": session.notifySceneModelsReady(command.sceneAssetGuid, command.sceneLoadId); break;
        case "sceneLayerLoading": session.notifySceneLayerLoadingPainted(command.layerId, command.layerLoadId); break;
        case "sceneLayerRealized": session.notifySceneLayerReady(command.layerId, command.layerLoadId); break;
        case "sceneStreamRealized": session.notifySceneStreamReady(command.actorGuid, command.streamLoadId); break;
        case "assetPreload":
          void acquire(command.assetGuids, command.ownerId, lifetime.signal).then(
            () => session.notifyAssetPreloadResult({ preloadId: command.preloadId, success: true, progress: 1 }),
            (error: unknown) => session.notifyAssetPreloadResult({ preloadId: command.preloadId, success: false, error: String(error) }));
          break;
      }
    };
    runtime = createRuntimeFromLoad(load, (command) => {
      commands.push(command);
      // After the command returns, as a host's reply would arrive.
      queueMicrotask(() => answer(command));
    }, createSessionSaveStorage(emptySaveStorage), {
      acquireScene: async (guid, request) => {
        const source = await acquire([guid], request.consumer, request.signal);
        // Released with the rest when the run ends.
        return { scene: source.game.scenes.get(guid)!, release: () => {} };
      },
    });
    for (const control of prepared.controls) await applyRuntimeSourceControl(runtime, control);
    const problems: string[] = [];
    await createPlayBootCoordinator().play(runtime).catch((error: unknown) => {
      problems.push(`Play did not start: ${error instanceof Error ? error.message : String(error)}`);
    });
    if (!problems.length) {
      for (let tick = 0; tick < options.ticks; tick++) {
        runtime.tick();
        // A frame boundary: latent work that waits on storage, console commands or sources settles between ticks, as between Play frames.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    for (const command of commands) {
      if (command.type === "diagnostic" && command.severity === "error") {
        problems.push(`${command.message} (${[command.assetGuid, command.nodeId].filter(Boolean).join(" › ") || command.code})`);
      } else if (command.type === "sceneLoadFailed" || command.type === "sceneLayerLoadFailed") {
        problems.push(command.message);
      }
    }
    return { problems, tickIndex: runtime.getWorld().clock.tickIndex };
  } finally {
    runtime?.stop();
    lifetime.abort();
    for (const set of sets) set.release();
  }
}

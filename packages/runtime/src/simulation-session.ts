import type {
  CommandMessage,
  GameSessionMode,
  SessionBoundaryRequest,
  SessionBoundaryResult,
  SessionPauseReason,
  SimulationCaptureRequest,
  SimulationQuiesceRequest,
} from "@babylonslate/bridge";
import type { DataAssetCatalogEntry, SerializedScene } from "@babylonslate/core";
import { MaterialObject, getPostProcessMaterialObject, type Actor, type World } from "@babylonslate/object-model";
import { dataTypeSchemas } from "./data-catalog";
import type { RuntimeMaterialEditGate } from "./runtime-material-edit-gate";
import type { RuntimeMaterialParameters } from "./runtime-material-parameters";
import type { RuntimePhysicsWorlds } from "./runtime-physics-worlds";
import type { SceneLayers } from "./scene-layers";
import type { SceneRealizer } from "./scene-realizer";
import type { SceneStreams } from "./scene-streams";
import type { ScriptHost } from "./script-host";
import type { SessionBoundaries } from "./session-boundaries";
import { captureSimulationScene, type SimulationCaptureIdentity, type SimulationSceneCaptureResult } from "./simulation-scene-capture";

interface SimulationSessionOptions {
  /** The prepared authoring Scene of a Simulation; null in Play. */
  baseline: SerializedScene | null;
  /** Catalog identities are persistable without loading every referenced asset. */
  assetGuids: Iterable<string>;
  dataAssets: DataAssetCatalogEntry[] | undefined;
}

interface SimulationSessionHost {
  world(): World;
  sessionGeneration(): number;
  sessionMode(): GameSessionMode;
  stopped(): boolean;
  playSceneGuid(): string;
  bootLoading(): boolean;
  commandRevision(): number;
  boundaries(): Pick<SessionBoundaries, "result" | "saveBoundaryActive">;
  sceneRealizer(): Pick<SceneRealizer, "blocked" | "loadId">;
  streams(): Pick<SceneStreams, "blocking" | "actorReady" | "isStreamActor">;
  layers(): Pick<SceneLayers, "get">;
  /** The live material edit gate, once an Inspector material edit created it. */
  materialEditGate(): Pick<RuntimeMaterialEditGate, "cancel" | "busy" | "ownershipFailure"> | null;
  materialParameters(): Pick<RuntimeMaterialParameters, "captureOverrides">;
  physics(): Pick<RuntimePhysicsWorlds, "gravity">;
  scripts(): Pick<ScriptHost, "scriptsFor">;
  setPauseReason(reason: SessionPauseReason, paused: boolean): void;
  resetInputState(): void;
  /** Answer queued Inspector requests, when any are queued. */
  flushInspectorRequests(): void;
  /** Write the snapshot an `advance()` catch-up burst deferred, if any. */
  flushDeferredSnapshot(): void;
  emit(command: CommandMessage): void;
}

/**
 * Simulation quiesce and capture: the immutable baseline and starting Scene,
 * the prepared asset and data scopes retention validates against, independent
 * stream or SceneLayer instances Keep cannot retain, the final quiescent
 * boundary and the capture request ids. It also owns the Simulate-mode write
 * gate and per-actor live edit eligibility `RuntimeInspectorService` uses. The
 * driver keeps pause state; quiescence blocks a later resume through it.
 */
export class SimulationSession {
  private readonly baseline: SerializedScene | null;
  private readonly assets: ReadonlySet<string>;
  private ownedAssets: ReadonlySet<string>;
  private dataAssets: DataAssetCatalogEntry[] | undefined;
  private start: Pick<SimulationCaptureIdentity, "sceneAssetGuid" | "sceneInstanceId" | "sceneLoadId"> | null = null;
  private _quiescent = false;
  private unsupportedInstance: { kind: "stream" | "layer"; id: string } | null = null;
  private lastCaptureRequestId = 0;
  private readonly host: SimulationSessionHost;

  constructor(options: SimulationSessionOptions, host: SimulationSessionHost) {
    this.baseline = options.baseline;
    this.assets = new Set(options.assetGuids);
    this.ownedAssets = this.assets;
    this.dataAssets = options.dataAssets;
    this.host = host;
  }

  /** The Simulation acknowledged its final boundary: it stays paused and rejects live edits. */
  get quiescent(): boolean { return this._quiescent; }

  /** Inspector mutations are accepted only in a live, not yet quiescent Simulation. */
  canWrite(): boolean {
    return this.host.sessionMode() === "simulate" && !this._quiescent;
  }

  /** The live actor and its owning Scene, stream or SceneLayer accept a live edit now. */
  canEditActor(actor: Actor): boolean {
    const world = this.host.world();
    const streams = this.host.streams();
    if (this._quiescent || this.host.stopped() || this.host.boundaries().saveBoundaryActive || actor.destroyed || actor.world !== world || streams.blocking || !streams.actorReady(actor)) return false;
    return actor.sceneLayerId ? this.host.layers().get(actor.sceneLayerId)?.ready === true : !this.host.sceneRealizer().blocked && !this.host.bootLoading();
  }

  /** A Simulation records the first realized Scene as its starting scene. */
  recordStart(start: Pick<SimulationCaptureIdentity, "sceneAssetGuid" | "sceneInstanceId" | "sceneLoadId">): void {
    if (this.host.sessionMode() === "simulate" && !this.start) this.start = start;
  }

  /** Simulation Keep cannot retain a scene transition. */
  markSceneTransition(): void {
    if (this.host.sessionMode() === "simulate") this.host.emit({ type: "simulationRetentionUnavailable", sessionGeneration: this.host.sessionGeneration(),
      reason: "Keep cannot retain a scene transition into the starting scene document." });
  }

  markUnsupportedInstance(kind: "stream" | "layer", id: string): void {
    if (this.host.sessionMode() !== "simulate" || this.unsupportedInstance) return;
    this.unsupportedInstance = { kind, id };
    this.host.emit({ type: "simulationRetentionUnavailable", sessionGeneration: this.host.sessionGeneration(),
      reason: `Keep cannot retain an independent ${kind === "layer" ? "SceneLayer" : "streamed Scene"} instance (${id}), including one removed before Stop.` });
  }

  /** Scene content registration replaces the prepared asset and data scopes. */
  retainSceneContent(assetGuids: ReadonlySet<string>, dataAssets: DataAssetCatalogEntry[] | undefined): void {
    if (this.host.sessionMode() === "simulate") {
      // Source scopes are acquired/released on demand. Retention must validate
      // against current owned source metadata, including newly prepared types.
      this.ownedAssets = assetGuids;
      this.dataAssets = dataAssets;
    }
  }

  quiesce(request: SimulationQuiesceRequest): Promise<SessionBoundaryResult> {
    return new Promise(resolve => queueMicrotask(() => {
      const boundaryRequest: SessionBoundaryRequest = { ...request, action: { kind: "resetInput" } };
      const invalid = request.sessionGeneration !== this.host.sessionGeneration() ? "Stale session generation." :
        this.host.sessionMode() !== "simulate" ? "Final scene capture is available only during Simulation Play." :
        this.host.stopped() ? "The game session has stopped." :
        !Number.isSafeInteger(request.requestId) || request.requestId <= this.lastCaptureRequestId ? "Invalid or superseded capture request ID." : null;
      if (invalid) { resolve(this.host.boundaries().result(boundaryRequest, invalid)); return; }
      this.lastCaptureRequestId = request.requestId;
      this.host.setPauseReason("loading", true);
      this.host.materialEditGate()?.cancel("Simulation is stopping; the pending material edit was cancelled.");
      this._quiescent = true;
      this.host.resetInputState();
      this.host.flushInspectorRequests();
      this.host.flushDeferredSnapshot();
      resolve(this.host.boundaries().result(boundaryRequest));
    }));
  }

  capture(request: SimulationCaptureRequest): Promise<SimulationSceneCaptureResult> {
    return new Promise(resolve => queueMicrotask(() => {
      const world = this.host.world();
      const identity: SimulationCaptureIdentity = { generation: this.host.sessionGeneration(), sceneAssetGuid: this.host.playSceneGuid(),
        sceneInstanceId: world.currentScene?.guid ?? "", sceneLoadId: this.host.sceneRealizer().loadId,
        tickIndex: world.clock.tickIndex, commandRevision: this.host.commandRevision() };
      const fail = (reason: string, code: "boundary" | "ownership" | "budget" | "resource" = "boundary") => resolve({ ok: false, code, path: "scene", reason, identity });
      if (request.sessionGeneration !== this.host.sessionGeneration() || !Number.isSafeInteger(request.requestId) || request.requestId <= this.lastCaptureRequestId) { fail("Stale or superseded capture request."); return; }
      this.lastCaptureRequestId = request.requestId;
      if (this.host.stopped() || !this._quiescent || !this.baseline || !this.start || this.host.sessionMode() !== "simulate") { fail("A live Simulation must acknowledge its final quiescent boundary before capture."); return; }
      const gate = this.host.materialEditGate();
      if (gate?.busy || gate?.ownershipFailure) { fail(gate.ownershipFailure ?? "A material edit is still pending.", "ownership"); return; }
      if (request.maxBytes !== undefined && (!Number.isSafeInteger(request.maxBytes) || request.maxBytes < 1 || request.maxBytes > 64 * 1024 * 1024)) { fail("Invalid final scene capture budget.", "budget"); return; }
      try {
        const scene = world.currentScene;
        if (!scene || this.host.sceneRealizer().blocked || this.host.bootLoading() || this.host.streams().blocking) { fail("Scene loading has not reached a complete final boundary."); return; }
        const materials = this.host.materialParameters();
        const postProcessStack: typeof scene.postProcessStack = [];
        for (const entry of scene.postProcessStack) {
          const material = getPostProcessMaterialObject(scene, entry.id ?? "");
          const overrides = material ? materials.captureOverrides(material) : null;
          if (!overrides) { fail(`Post-process material ${entry.materialGuid} has no complete current authoring parameter state.`, "resource"); return; }
          postProcessStack.push({ ...entry, parameters: overrides });
        }
        if (postProcessStack.some(entry => !this.ownedAssets.has(entry.materialGuid))) { fail("A post-process material has no prepared authoring asset.", "resource"); return; }
        const schemas = dataTypeSchemas(this.dataAssets ?? []);
        const physics = this.host.physics();
        resolve(captureSimulationScene({ world, baseline: this.baseline, identity, startingScene: this.start,
          quiescent: true, renderRevision: request.renderRevision, maxBytes: request.maxBytes,
          sceneSettings: { ...this.baseline.settings, gravity: [physics.gravity[0], physics.gravity[1], physics.gravity[2]], postProcessStack },
          ownership: actor => actor.sceneLayerId ? "layer" : this.host.streams().isStreamActor(actor) ? "stream" : "root",
          independentInstances: this.unsupportedInstance ? [this.unsupportedInstance] : [],
          materialOverrides: component => {
            const material = component.getVariable("materialObject");
            return material instanceof MaterialObject ? this.host.materialParameters().captureOverrides(material) : null;
          },
          prefabComponents: classId => world.classRegistry.ancestry(classId).flatMap(ancestor => this.host.scripts().scriptsFor(ancestor))
            .find(script => script.components !== undefined)?.components ?? [],
          assetExists: guid => this.assets.has(guid) || this.ownedAssets.has(guid),
          structFields: guid => schemas.structs[guid]?.fields.map(field => ({ ...field, type: field.typeId })) ?? null,
          enumMembers: guid => schemas.enums[guid]?.members.map(member => member.name) ?? null,
        }));
      } catch (error) { fail(error instanceof Error ? error.message : "Final scene capture failed."); }
    }));
  }
}

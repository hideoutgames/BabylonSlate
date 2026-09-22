import type { Light, Mesh, Scene } from "@babylonjs/core";
import {
  meshBakeParticipation,
  normalizeBakeAuthoringSettings,
  type BakedLightingSource,
  type BakedLightingValidity,
  type EnvironmentLightingSettings,
  type SerializedScene,
} from "@babylonslate/core";
import type {
  MaterialDocument,
  MaterialFunctionDocument,
} from "@babylonslate/shader-graph";
import type { BakeRuntimeAssetReader } from "@babylonslate/assets";
import { prepareSceneBake } from "./scene-bake-preparation";
import { markSceneReadinessDirty } from "./scene-perf";
import {
  SceneBakedLighting,
  type BakedRuntimeReceiver,
} from "./scene-baked-lighting";
import {
  BakedReceiverMaterials,
  type BakedSourceLightResolver,
} from "./baked-receiver-materials";

/** Host-provided resolution for one loaded scene's bake ownership. */
export interface BakedSceneHost {
  /** The scene document's project asset guid (manifest `sceneGuid`). */
  readonly sceneAssetGuid: string;
  /** Reads BakedLighting/BakedGeometry assets from this host's asset source. */
  readonly readAsset: BakeRuntimeAssetReader;
  /** Compiled Material documents for receiver hash preparation. */
  readonly materials: ReadonlyMap<string, MaterialDocument>;
  readonly functions?: Record<string, MaterialFunctionDocument>;
  readonly projectEnvironment?: Partial<EnvironmentLightingSettings>;
  /** Exact authored component visual; null until the mesh exists. */
  meshForComponent(actorId: string, componentId: string): Mesh | null;
  /** Live realtime light for one authored light component. */
  lightForComponent(actorId: string, componentId: string): Light | null;
  /** False once the load owning this host is superseded. */
  isCurrent(): boolean;
  /** Optional cooperative cancellation (scene reload / disposal). */
  signal?: AbortSignal;
}

export type BakedSceneSessionState = "idle" | "pending" | "applied" | "stale";

/** Serializable session readout for host test hooks and CI diagnostics. */
export interface BakedSessionDiagnostics {
  state: BakedSceneSessionState;
  staleReasons: string[];
  /** Milliseconds the current pending admission has withheld readiness. */
  pendingMs: number;
  /** Per-receiver material variant and compiled `SLATE_BAKED` define state. */
  receivers: Array<{
    mesh: string;
    material: string | null;
    slateBaked: boolean;
    /** Realtime light names excluded on this receiver for baked direct terms. */
    excludedLights: string[];
    /** Realtime light defines on the compiled effect; null before it exists. */
    lightDefines: number | null;
  }>;
  /** Bound receiver count and shared atlas upload state. */
  owner: {
    receiverCount: number;
    atlas: { ready: boolean; halfFloat: boolean } | null;
  };
  validity: BakedLightingValidity;
}

const NOT_READY = /is not ready\./;

/**
 * Longest a pending session may withhold first-frame admission while receiver
 * meshes realize (Play command delivery) or bake IO stalls. Past the budget
 * the session fails stale and re-admits realtime lighting: a missing or
 * failed bake must never block the host indefinitely.
 */
const PENDING_READINESS_BUDGET_MS = 30_000;

/**
 * One per-Scene owner wiring `SceneBakedLighting` into scene loading and
 * readiness. `apply` supersedes any in-flight or bound bake (releasing
 * receiver materials, exclusions, geometry and atlas references first); while
 * receivers are unrealized the session stays pending and blocks strict
 * first-frame admission so no realtime-lit frame is admitted ahead of the
 * bake, up to a bounded budget. A stale or missing bake admits realtime
 * lighting again.
 */
export class BakedSceneSession {
  private readonly scene: Scene;
  private readonly owner: SceneBakedLighting;
  private receivers: BakedReceiverMaterials;
  private readonly readiness = { isReady: () => this.probe() };
  private readinessRegistered = false;
  private readonly pendingReadinessBudgetMs: number;
  private epoch = 0;
  private inFlight = 0;
  private state: BakedSceneSessionState = "idle";
  private sceneData?: SerializedScene;
  private host?: BakedSceneHost;
  private abort?: AbortController;
  private sources = new Map<string, BakedLightingSource>();
  private staleReasons: string[] = [];
  private pendingSince = 0;
  private disposed = false;

  constructor(
    scene: Scene,
    managedByteCeiling?: number,
    pendingReadinessBudgetMs = PENDING_READINESS_BUDGET_MS,
  ) {
    this.scene = scene;
    this.owner = new SceneBakedLighting(scene, managedByteCeiling);
    this.receivers = new BakedReceiverMaterials(scene);
    this.pendingReadinessBudgetMs = pendingReadinessBudgetMs;
    // The readiness check registers only while a bake binds: an idle session
    // must not alter readiness membership or probe cadence for scenes that
    // never assign baked lighting.
  }

  private registerReadiness(): void {
    if (this.readinessRegistered) return;
    this.readinessRegistered = true;
    this.scene.addIsReadyCheck(this.readiness);
  }

  private unregisterReadiness(): void {
    if (!this.readinessRegistered) return;
    this.readinessRegistered = false;
    try {
      this.scene.removeIsReadyCheck(this.readiness);
    } catch {
      // A disposing scene may already have dropped its check list.
    }
  }

  get sessionState(): BakedSceneSessionState {
    return this.state;
  }

  /** Why the last rebind failed, for diagnostics and the bake panel. */
  get staleReason(): string | null {
    return this.state === "stale"
      ? (this.staleReasons[0] ??
          (this.owner.validity.status !== "valid"
            ? [...Object.values(this.owner.validity)].join(" ")
            : null))
      : null;
  }

  get bakedLighting(): SceneBakedLighting {
    return this.owner;
  }

  /** Structured readout: why the bake is pending/stale and whether the receiver shaders actually carry `SLATE_BAKED`. */
  diagnostics(): BakedSessionDiagnostics {
    return {
      state: this.state,
      staleReasons: [...this.staleReasons],
      pendingMs:
        this.state === "pending"
          ? Math.round(performance.now() - this.pendingSince)
          : 0,
      receivers: this.receivers.diagnostics(),
      owner: this.owner.diagnostics(),
      validity: this.owner.validity,
    };
  }

  /**
   * Re-check receiver exclusions after the snapshot assigns Play/player light
   * visuals; `directAndIndirect` sources that had no runtime light at bind
   * time resolve on this pass instead of staying unexcluded. Ungated: the
   * assignMesh can land while the session is still `pending`, and `sync` is a
   * no-op on an empty or released receiver set.
   */
  refresh(): void {
    this.receivers.sync();
  }

  /**
   * Rebind the bake referenced by `sceneData.settings.bakedLightingAssetGuid`
   * through `host`. Safe to call for every scene load and environment-only
   * update; superseded work aborts and releases before the new bake applies.
   */
  apply(sceneData: SerializedScene, host: BakedSceneHost | null): void {
    // `loadScene`/`applySceneEnvironment` pairs hand the same document through
    // twice; only a new document or a stale release needs another pass.
    if (
      sceneData === this.sceneData &&
      (host?.sceneAssetGuid ?? null) === (this.host?.sceneAssetGuid ?? null) &&
      this.state !== "idle"
    )
      return;
    const epoch = ++this.epoch;
    this.abort?.abort();
    this.abort = new AbortController();
    this.sceneData = sceneData;
    this.host = host ?? undefined;
    if (!sceneData.settings.bakedLightingAssetGuid || !host) {
      // Nothing was ever bound: receivers and owner are already empty, so
      // releasing them would only dirty strict readiness for no reason.
      if (this.state !== "idle") {
        this.receivers.release();
        this.receivers = new BakedReceiverMaterials(this.scene);
        this.owner.invalidate("Scene loading superseded the applied bake.");
        this.unregisterReadiness();
      }
      this.state = "idle";
      return;
    }
    this.receivers.release();
    this.receivers = new BakedReceiverMaterials(this.scene);
    this.owner.invalidate("Scene loading superseded the applied bake.");
    this.registerReadiness();
    this.state = "pending";
    this.pendingSince = performance.now();
    markSceneReadinessDirty(this.scene);
    void this.progress(epoch);
  }

  private probe(): boolean {
    if (this.scene.isDisposed || this.disposed) return true;
    if (this.state === "applied") {
      this.receivers.sync();
      if (this.owner.validity.status !== "valid") {
        // A live-source change invalidated the admitted bake; realtime wins.
        this.receivers.release();
        this.receivers = new BakedReceiverMaterials(this.scene);
        this.state = "stale";
        markSceneReadinessDirty(this.scene);
        return true;
      }
      return this.owner.isReady();
    }
    if (this.state === "pending") {
      if (
        performance.now() - this.pendingSince >
        this.pendingReadinessBudgetMs
      ) {
        this.staleReasons = [
          "Baked lighting receivers were not realized in time; rendering unbaked.",
        ];
        console.warn(`[render] ${this.staleReasons[0]}`);
        this.state = "stale";
        markSceneReadinessDirty(this.scene);
        return true;
      }
      if (!this.inFlight) void this.progress(this.epoch);
      return false;
    }
    return true;
  }

  private async progress(epoch: number): Promise<void> {
    if (this.inFlight || this.state !== "pending" || this.epoch !== epoch)
      return;
    this.inFlight = epoch;
    const sceneData = this.sceneData!;
    const host = this.host!;
    const signal = this.abort!.signal;
    try {
      // Cheap doc-side admission first: receivers are the only meshes the
      // owner binds, so wait for them before hashing a full preparation.
      const missing = receiverIdentities(sceneData).filter(
        (identity) =>
          !host.meshForComponent(identity.actorId, identity.componentId),
      );
      if (missing.length) return;
      const owner = {
        sceneGuid: host.sceneAssetGuid,
        generation: epoch,
      };
      const prepared = await prepareSceneBake({
        owner,
        current: () =>
          this.epoch === epoch && host.isCurrent()
            ? owner
            : { sceneGuid: "", generation: -1 },
        document: sceneData,
        meshForComponent: host.meshForComponent,
        materials: host.materials,
        functions: host.functions,
        projectEnvironment: host.projectEnvironment,
        settings: normalizeBakeAuthoringSettings(
          sceneData.settings.bakeSettings,
        ),
        signal,
      });
      const receivers: BakedRuntimeReceiver[] = prepared.meshes
        .filter((mesh) => mesh.receiver)
        .map((mesh) => ({
          identity: mesh.identity,
          hashes: mesh.hashes,
          mesh: host.meshForComponent(
            mesh.identity.actorId,
            mesh.identity.componentId,
          )!,
        }));
      const applied = await this.owner.load({
        assetGuid: sceneData.settings.bakedLightingAssetGuid!,
        sceneGuid: host.sceneAssetGuid,
        inputs: prepared.inputs,
        receivers,
        readAsset: host.readAsset,
        isCurrent: () =>
          this.epoch === epoch && host.isCurrent() && !this.disposed,
        signal,
      });
      if (this.epoch !== epoch || this.disposed) return;
      if (!applied) {
        const validity = this.owner.validity;
        this.staleReasons =
          validity.status === "stale"
            ? [...validity.reasons]
            : validity.status === "missing"
              ? [validity.reason]
              : ["The bake did not apply."];
        console.warn(
          `[render] Baked lighting did not apply: ${this.staleReasons.join(" ")}`,
        );
        this.state = "stale";
        markSceneReadinessDirty(this.scene);
        return;
      }
      this.sources = new Map(
        prepared.sources.map((source) => [source.id, source]),
      );
      const lightForSource: BakedSourceLightResolver = (source) =>
        host.lightForComponent(source.actorId, source.componentId);
      for (const receiver of receivers) {
        const binding = this.owner.bindingFor(receiver.mesh);
        if (binding)
          this.receivers.apply(
            receiver.mesh,
            binding,
            this.sources,
            lightForSource,
          );
      }
      this.state = "applied";
      markSceneReadinessDirty(this.scene);
    } catch (error) {
      if (this.epoch !== epoch || this.disposed) return;
      const message = error instanceof Error ? error.message : String(error);
      // A bake participant whose visual has not spawned yet stays pending and
      // retries on the next readiness probe.
      if (NOT_READY.test(message)) return;
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (this.state === "pending") {
        this.staleReasons = [message];
        console.warn(`[render] Baked lighting session failed: ${message}`);
        this.state = "stale";
        markSceneReadinessDirty(this.scene);
      }
    } finally {
      if (this.inFlight === epoch) this.inFlight = 0;
    }
  }

  /** Release materials, exclusions, geometry and atlas references. */
  release(): void {
    this.epoch++;
    this.abort?.abort();
    if (this.state !== "idle") {
      this.receivers.release();
      this.receivers = new BakedReceiverMaterials(this.scene);
      this.owner.invalidate("Baked lighting was released.");
      this.unregisterReadiness();
      markSceneReadinessDirty(this.scene);
    }
    this.state = "idle";
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.epoch++;
    this.abort?.abort();
    this.unregisterReadiness();
    this.receivers.release();
    this.owner.dispose();
    this.state = "idle";
  }
}

function receiverIdentities(sceneData: SerializedScene): Array<{
  actorId: string;
  componentId: string;
}> {
  const identities: Array<{ actorId: string; componentId: string }> = [];
  for (const actor of sceneData.actors) {
    if (!actor.visible) continue;
    for (const component of actor.components) {
      if (component.classId !== "MeshComponent") continue;
      if (meshBakeParticipation(component.properties) !== "staticReceiver")
        continue;
      if (component.properties.assetGuid) continue;
      identities.push({ actorId: actor.id, componentId: component.id });
    }
  }
  return identities;
}

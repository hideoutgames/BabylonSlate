import type {
  CommandMessage,
  ControlMessage,
  GameSessionMode,
  RuntimeInspectorRequest,
  RuntimeInspectorResult,
  RuntimeMaterialEditPreparation,
} from "@babylonslate/bridge";
import type { MaterialParameterValue } from "@babylonslate/core";
import { Actor, ActorComponent, MaterialObject, type World } from "@babylonslate/object-model";
import type { RuntimeAssetPreloads } from "./asset-preloads";
import type { RagdollWorldSync } from "./ragdoll-sync";
import type { RenderCommandEmitter } from "./render-command-emitter";
import type { RenderSlots } from "./render-slots";
import { RuntimeInspector } from "./runtime-inspector";
import { RuntimeMaterialEditGate } from "./runtime-material-edit-gate";
import type { RuntimeMaterialParameters } from "./runtime-material-parameters";
import type { RuntimePhysicsWorlds } from "./runtime-physics-worlds";
import { runtimeEditLocalTransform } from "./runtime-transform-edit";
import type { SceneLayers } from "./scene-layers";
import type { SceneRealizer } from "./scene-realizer";
import type { SceneStreams } from "./scene-streams";
import type { SimulationSession } from "./simulation-session";

interface RuntimeInspectorServiceOptions {
  /** Material edits stage through the material edit gate's host acknowledgments. */
  deferMaterialEdits: boolean;
  /** Staged material edits acquire their sources on demand. */
  demandAssetCatalog: boolean;
}

interface RuntimeInspectorServiceHost {
  world(): World;
  sessionGeneration(): number;
  sessionMode(): GameSessionMode;
  stopped(): boolean;
  frameId(): number;
  /** Advance the presentation frame id and return the new value. */
  advanceFrameId(): number;
  commandRevision(): number;
  playSceneGuid(): string;
  simulation(): Pick<SimulationSession, "canWrite" | "canEditActor">;
  materialParameters(): RuntimeMaterialParameters;
  renderSlots(): Pick<RenderSlots, "recordedSlot" | "owner">;
  renderEmitter(): Pick<RenderCommandEmitter, "emitComponentTransforms" | "emitMaterialAssignments">;
  streams(): Pick<SceneStreams, "actorInstance">;
  layers(): Pick<SceneLayers, "get">;
  sceneRealizer(): Pick<SceneRealizer, "loadId">;
  physics(): Pick<RuntimePhysicsWorlds, "forActor">;
  ragdolls(): Pick<RagdollWorldSync, "retireActor">;
  assetPreloads(): Pick<RuntimeAssetPreloads, "acquire" | "release">;
  /** Refresh a component after a property write, as `RuntimePropertyWrites` does for any write. */
  refreshComponent(component: ActorComponent, propertyName: string): void;
  /** Write a mesh material parameter on the Inspector path: live edit eligibility instead of owner admission. */
  setMaterialParameter(material: MaterialObject, name: string, value: MaterialParameterValue): boolean;
  publishSnapshot(): void;
  emit(command: CommandMessage): void;
}

/**
 * Runtime Inspector requests and live edits on the driver side: the
 * validated, microtask-flushed request queue and its cancellation, the
 * `RuntimeInspector` evaluator with the property, transform and material
 * appliers it calls, the deferred material edit gate with its prepared-edit
 * token, Simulate-mode runtime identities on `spawn` / `assignMesh`, and the
 * snapshot an edit publishes. `RuntimePropertyWrites` owns the shared
 * component refresh and material parameter write path; the driver calls
 * `stop()` explicitly in Stop. It is not a registered subsystem.
 */
export class RuntimeInspectorService {
  private readonly deferMaterialEdits: boolean;
  private readonly demandAssetCatalog: boolean;
  private gate: RuntimeMaterialEditGate | null = null;
  private materialEditEmission: { preparation: RuntimeMaterialEditPreparation; emitted: boolean } | null = null;
  private evaluator: RuntimeInspector | null = null;
  private scheduled = false;
  private lastRequestId = 0;
  private readonly requests: Array<{ request: RuntimeInspectorRequest; resolve(result: RuntimeInspectorResult): void }> = [];
  private readonly host: RuntimeInspectorServiceHost;

  constructor(options: RuntimeInspectorServiceOptions, host: RuntimeInspectorServiceHost) {
    this.deferMaterialEdits = options.deferMaterialEdits;
    this.demandAssetCatalog = options.demandAssetCatalog;
    this.host = host;
  }

  /** The live material edit gate, once an Inspector material edit created it. */
  get materialEditGate(): RuntimeMaterialEditGate | null { return this.gate; }

  request(request: RuntimeInspectorRequest): Promise<RuntimeInspectorResult> {
    const inspector = this.inspector();
    const invalid = inspector.validateRequest(request) ??
      (request.requestId <= this.lastRequestId ? "Invalid or superseded Inspector request ID." :
        this.requests.length >= 32 ? "Runtime Inspector request queue is full." : null);
    if (invalid) return Promise.resolve(inspector.result(request, invalid));
    this.lastRequestId = request.requestId;
    const result = new Promise<RuntimeInspectorResult>(resolve => this.requests.push({ request: structuredClone(request), resolve }));
    if (!this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => this.flush());
    }
    return result;
  }

  cancel(request: { sessionGeneration: number; requestId: number }): void {
    if (request.sessionGeneration !== this.host.sessionGeneration() || !Number.isSafeInteger(request.requestId)) return;
    const index = this.requests.findIndex(entry => entry.request.requestId === request.requestId);
    if (index !== -1) {
      const [entry] = this.requests.splice(index, 1);
      entry!.resolve(this.inspector().result(entry!.request, "Inspector request cancelled."));
    }
    this.gate?.cancelRequest(request.requestId);
  }

  /** Answer queued requests, when any are queued. */
  flushQueued(): void {
    if (this.requests.length) this.flush();
  }

  /** Stop: cancel the pending material edit, then answer queued requests. */
  stop(): void {
    this.gate?.cancel("The game session has stopped.");
    this.flushQueued();
  }

  applyMaterialEditResult(message: Extract<ControlMessage, { type: "runtimeMaterialEditPrepared" | "runtimeMaterialEditApplied" }>): void {
    if (!this.gate || this.host.stopped()) return;
    queueMicrotask(() => { if (!this.host.stopped()) this.gate?.receive(message); });
  }

  /**
   * Add Simulate-mode runtime identities to `spawn` / `assignMesh`, and the
   * prepared edit token to the material command a staged edit sends.
   */
  annotate(command: CommandMessage): CommandMessage {
    if (this.host.sessionMode() === "simulate" && (command.type === "spawn" || command.type === "assignMesh")) {
      const actor = this.host.renderSlots().owner(command.slotId);
      if (actor) command = command.type === "spawn" ? { ...command, runtimeIdentity: this.inspector().identity(actor) } :
        { ...command, runtimeComponentTokens: actor.components.filter(component => !component.destroyed).map(component => ({
          componentGuid: component.guid, componentToken: this.inspector().identity(component).componentToken! })) };
    }
    const emission = this.materialEditEmission;
    if (emission && (command.type === "assignMaterial" || command.type === "setMaterialParameter") &&
      command.slotId === emission.preparation.slotId && command.componentId === emission.preparation.componentId &&
      command.materialAssetGuid === emission.preparation.materialGuid &&
      (emission.preparation.parameterName === undefined ? command.type === "assignMaterial" :
        command.type === "setMaterialParameter" && command.parameterName === emission.preparation.parameterName)) {
      command = { ...command, preparedEditToken: emission.preparation.editToken }; emission.emitted = true;
    }
    return command;
  }

  private flush(): void {
    this.scheduled = false;
    const inspector = this.inspector();
    for (const { request, resolve } of this.requests.splice(0)) {
      if (this.deferMaterialEdits && !this.host.stopped() && this.getMaterialEditGate().stage(request, resolve)) continue;
      resolve(inspector.execute(request));
    }
  }

  private inspector(): RuntimeInspector {
    return this.evaluator ??= new RuntimeInspector({
      world: this.host.world(), materials: this.host.materialParameters(), sessionGeneration: this.host.sessionGeneration(),
      canWrite: () => this.host.simulation().canWrite(), stopped: () => this.host.stopped(),
      ready: actor => this.host.simulation().canEditActor(actor),
      renderSlot: actor => this.host.renderSlots().recordedSlot(actor),
      resolvePick: (guid, slot) => { const actor = this.host.renderSlots().owner(slot); return actor && !actor.destroyed && actor.world === this.host.world() && actor.guid === guid ? actor : null; },
      sceneIdentity: actor => {
        const stream = this.host.streams().actorInstance(actor);
        if (stream) return `stream:${stream.actor.guid}:${stream.loadId}`;
        if (actor.sceneLayerId) return `layer:${actor.sceneLayerId}:${this.host.layers().get(actor.sceneLayerId)?.loadId ?? -1}`;
        return `scene:${this.host.playSceneGuid()}:${this.host.sceneRealizer().loadId}:${this.host.world().currentScene?.guid ?? ""}`;
      },
      boundary: () => ({ tickIndex: this.host.world().clock.tickIndex, frameId: this.host.frameId(),
        commandRevision: this.host.commandRevision(), structuralRevision: this.host.world().structuralRevision }),
      applyProperty: (target, key, value) => {
        const materialAssignment = target instanceof ActorComponent && key === "materialGuid";
        const priorSourcePresent = materialAssignment && target.variables.has("materialSource");
        const priorSource = materialAssignment ? target.getVariable("materialSource") : undefined;
        const prior = target instanceof Actor && key === "generateHitEvents" ? target.generateHitEvents :
          target instanceof Actor && key === "generateOverlapEvents" ? target.generateOverlapEvents : target.getVariable(key);
        const apply = (next: unknown) => {
          if (target instanceof Actor && key === "generateHitEvents") target.generateHitEvents = next as boolean;
          else if (target instanceof Actor && key === "generateOverlapEvents") target.generateOverlapEvents = next as boolean;
          else target.setVariable(key, next);
          if (target instanceof ActorComponent) this.host.refreshComponent(target, key);
        };
        // An explicit None is a real override too, including an untouched model slot.
        if (materialAssignment) target.setVariable("materialSource", "override");
        try { apply(value); } catch (error) {
          if (materialAssignment) {
            if (priorSourcePresent) target.setVariable("materialSource", priorSource);
            else target.variables.delete("materialSource");
          }
          apply(prior); throw error;
        }
        if (target instanceof Actor && key === "visible") this.publishSnapshot(target);
      },
      applyTransform: (target, transform, space) => {
        const world = this.host.world();
        const prior = target.transform;
        const actor = target instanceof Actor ? target : target.owner!;
        const affected = [actor];
        if (target instanceof Actor) {
          const ids = new Set([actor.guid]);
          let changed = true;
          while (changed) {
            changed = false;
            for (const candidate of world.getActors()) {
              if (candidate.destroyed || candidate.sceneLayerId !== actor.sceneLayerId || ids.has(candidate.guid) || !ids.has(String(candidate.getVariable("parentId") ?? ""))) continue;
              affected.push(candidate); ids.add(candidate.guid); changed = true;
            }
          }
        }
        if (affected.some(entry => entry.components.some(component => !component.destroyed && component.classId === "RagdollComponent")))
          throw new Error("This transform moves an articulated body; preserving its live state requires a new session.");
        const apply = () => {
          for (const affectedActor of affected) {
            this.host.ragdolls().retireActor(affectedActor);
            this.host.physics().forActor(affectedActor).teleportActor(affectedActor, world);
          }
        };
        target.transform = runtimeEditLocalTransform(world, target, transform, space);
        try { apply(); } catch (error) { target.transform = prior; apply(); throw error; }
        if (target instanceof ActorComponent) {
          const slotId = this.host.renderSlots().recordedSlot(actor);
          if (slotId !== undefined) this.host.renderEmitter().emitComponentTransforms(actor, slotId);
        }
        this.publishSnapshot(actor);
      },
      applyMaterial: (component, name, value) => {
        const material = component.getVariable("materialObject");
        return material instanceof MaterialObject && this.host.setMaterialParameter(material, name, value);
      },
    });
  }

  private getMaterialEditGate(): RuntimeMaterialEditGate {
    return this.gate ??= new RuntimeMaterialEditGate({ generation: this.host.sessionGeneration(),
      inspector: this.inspector(), materials: this.host.materialParameters(),
      slot: component => component.owner ? this.host.renderSlots().recordedSlot(component.owner) : undefined,
      acquireSource: this.demandAssetCatalog ? async (component, guids, signal) => {
        const result = await this.host.assetPreloads().acquire(guids, component.guid, {}, signal);
        if (!result.success) throw new Error(result.errorMessage || "Material source preparation failed.");
        return result.preloadId;
      } : undefined,
      releaseSource: id => this.host.assetPreloads().release(id),
      emit: command => this.host.emit(command),
      execute: (request, preparation) => {
        const emission = { preparation, emitted: false }; this.materialEditEmission = emission;
        try { return { result: this.inspector().execute(request), emitted: emission.emitted }; }
        finally { this.materialEditEmission = null; }
      },
      restore: component => {
        const actor = component.owner; const slot = actor ? this.host.renderSlots().recordedSlot(actor) : undefined;
        if (slot === undefined) throw new Error("Material owner is unavailable.");
        this.host.renderEmitter().emitMaterialAssignments([component], slot, true);
        const material = component.getVariable("materialObject");
        if (material instanceof MaterialObject) for (const [name, value] of Object.entries(this.host.materialParameters().describe(material) ?? {}))
          this.host.setMaterialParameter(material, name, value);
      },
    });
  }

  /** Presentation identity advances, while tick index, delays and physics do not. */
  private publishSnapshot(actor: Actor): void {
    const frameId = this.host.advanceFrameId();
    const slotId = this.host.renderSlots().recordedSlot(actor);
    if (slotId !== undefined) this.host.emit({ type: "resetActorInterpolation", actorGuid: actor.guid, slotId, frameId });
    this.host.publishSnapshot();
  }
}

import type { CommandMessage, ControlMessage, RuntimeInspectorRequest, RuntimeInspectorResult, RuntimeMaterialEditPreparation } from "@babylonslate/bridge";
import { ActorComponent, MaterialObject } from "@babylonslate/object-model";
import type { MaterialParameterValue } from "@babylonslate/core";
import type { RuntimeInspector } from "./runtime-inspector";
import type { RuntimeMaterialParameters } from "./runtime-material-parameters";

type Response = Extract<ControlMessage, { type: "runtimeMaterialEditPrepared" | "runtimeMaterialEditApplied" }>;
type Pending = {
  request: RuntimeInspectorRequest; preparation: RuntimeMaterialEditPreparation; component: ActorComponent;
  originalGuid: unknown; originalSource: unknown; originalSourcePresent: boolean;
  originalMaterial: MaterialObject | null; originalRevision: number;
  originalOverrides: Record<string, MaterialParameterValue> | null; originalValue: MaterialParameterValue | null;
  appliedMaterial?: MaterialObject | null; appliedRevision?: number;
  sourceLease?: string;
  sourceController?: AbortController;
  result?: RuntimeInspectorResult; phase: "sources" | "preparing" | "applying";
  resolve(result: RuntimeInspectorResult): void; timer: ReturnType<typeof setTimeout>;
};

/** Two acknowledgments: preparation leaves the predecessor visible, commit confirms the effective owner. */
export class RuntimeMaterialEditGate {
  private readonly pending = new Map<string, Pending>();
  private readonly sourceLeases = new WeakMap<ActorComponent, Map<string, string>>();
  private captureFailure: string | null = null;
  private readonly host: {
    generation: number; inspector: RuntimeInspector; materials: RuntimeMaterialParameters;
    slot(component: ActorComponent): number | undefined;
    emit(command: CommandMessage): void;
    execute(request: RuntimeInspectorRequest, preparation: RuntimeMaterialEditPreparation): { result: RuntimeInspectorResult; emitted: boolean };
    restore(component: ActorComponent): void;
    acquireSource?(component: ActorComponent, guids: readonly string[], signal: AbortSignal): Promise<string>;
    releaseSource(id: string): void;
  };
  constructor(host: {
    generation: number; inspector: RuntimeInspector; materials: RuntimeMaterialParameters;
    slot(component: ActorComponent): number | undefined;
    emit(command: CommandMessage): void;
    execute(request: RuntimeInspectorRequest, preparation: RuntimeMaterialEditPreparation): { result: RuntimeInspectorResult; emitted: boolean };
    restore(component: ActorComponent): void;
    acquireSource?(component: ActorComponent, guids: readonly string[], signal: AbortSignal): Promise<string>;
    releaseSource(id: string): void;
  }) { this.host = host; }
  get busy(): boolean { return this.pending.size > 0; }
  get ownershipFailure(): string | null { return this.captureFailure; }

  stage(request: RuntimeInspectorRequest, resolve: (result: RuntimeInspectorResult) => void): boolean {
    const action = request.action;
    if (action.kind !== "setMaterialParameter" && !(action.kind === "setProperty" && action.property === "materialGuid")) return false;
    const fail = (reason: string) => { resolve(this.host.inspector.result(request, reason)); return true; };
    const invalid = this.host.inspector.validateRequest(request);
    if (invalid) return fail(invalid);
    if (!Number.isSafeInteger(action.sequence) || action.sequence < 1) return fail("Invalid target sequence.");
    const component = this.host.inspector.resolveTarget(action.target);
    if (!(component instanceof ActorComponent) || !["MeshComponent", "DynamicRuntimeMeshComponent"].includes(component.classId)) return fail("Select a supported mesh component for material editing.");
    const slotId = this.host.slot(component);
    if (slotId === undefined) return fail("The selected material has no current renderer owner.");
    const material = component.getVariable("materialObject");
    const originalMaterial = material instanceof MaterialObject ? material : null;
    const materialGuid = action.kind === "setProperty" ? action.value : action.materialGuid;
    if (materialGuid !== null && (typeof materialGuid !== "string" || !materialGuid.trim())) return fail("A valid material asset identity is required.");
    if (action.kind === "setMaterialParameter" && (!action.value || !["float", "color", "texture"].includes(action.value.kind))) return fail("A typed material value is required.");
    if (action.kind === "setMaterialParameter" && (!originalMaterial || originalMaterial.materialAssetGuid !== action.materialGuid)) return fail("The material instance is unavailable.");
    for (const previous of this.pending.values()) if (previous.component === component) {
      // A single instance lease cannot promote competing candidates. Host scrubs coalesce before dispatch.
      return fail("A material change is already pending for this component.");
    }
    if (this.pending.size >= 8) return fail("The material preparation queue is full.");
    const editToken = `${this.host.generation}:${request.requestId}`;
    const preparation: RuntimeMaterialEditPreparation = { sessionGeneration: this.host.generation, requestId: request.requestId,
      editToken, slotId, actorGuid: component.owner!.guid, componentId: component.guid, materialGuid,
      ...(action.kind === "setMaterialParameter" ? { parameterName: action.parameter, parameter: action.value } : {}) };
    const pending: Pending = { request, preparation, component, originalGuid: component.getVariable("materialGuid"), originalMaterial,
      originalSource: component.getVariable("materialSource"), originalSourcePresent: component.variables.has("materialSource"),
      originalRevision: originalMaterial ? this.host.materials.revision(originalMaterial) : -1,
      originalOverrides: originalMaterial ? this.host.materials.captureOverrides(originalMaterial) : null,
      originalValue: action.kind === "setMaterialParameter" && originalMaterial ? this.host.materials.get(originalMaterial, action.parameter, action.value.kind) : null,
      phase: "sources", resolve, timer: setTimeout(() => this.reject(editToken, "Material preparation or application timed out.", true), 15_000) };
    this.pending.set(editToken, pending);
    const guids = action.kind === "setProperty" ? (typeof materialGuid === "string" ? [materialGuid] : [])
      : action.value?.kind === "texture" && typeof action.value.textureAssetGuid === "string" ? [action.value.textureAssetGuid] : [];
    if (guids.length && this.host.acquireSource) {
      pending.sourceController = new AbortController();
      void this.host.acquireSource(component, guids, pending.sourceController.signal).then(lease => {
        if (this.pending.get(editToken) !== pending) { this.host.releaseSource(lease); return; }
        pending.sourceLease = lease;
        this.prepare(pending);
      }).catch(error => this.reject(editToken, error instanceof Error ? error.message : "Material source preparation failed."));
    } else this.prepare(pending);
    return true;
  }
  private ownsOriginal(pending: Pending): boolean {
    const action = pending.request.action;
    const selected = this.host.inspector.resolveTarget("target" in action ? action.target : null!);
    const current = pending.component.getVariable("materialObject");
    return selected === pending.component && pending.component.getVariable("materialGuid") === pending.originalGuid &&
      pending.component.getVariable("materialSource") === pending.originalSource && current === pending.originalMaterial &&
      (!(current instanceof MaterialObject) || this.host.materials.revision(current) === pending.originalRevision);
  }
  private prepare(pending: Pending): void {
    const { request, preparation } = pending;
    const invalid = this.host.inspector.validateRequest(request);
    if (invalid || !this.ownsOriginal(pending)) { this.reject(preparation.editToken, invalid ?? "Gameplay replaced the material while its source was being prepared."); return; }
    const action = request.action;
    if (action.kind === "setProperty" && preparation.materialGuid !== null && !this.host.materials.acceptsAssignment(preparation.materialGuid)) {
      this.reject(preparation.editToken, "The material is unavailable or is not a surface material."); return;
    }
    if (action.kind === "setMaterialParameter" && (!pending.originalMaterial || !this.host.materials.accepts(pending.originalMaterial, action.parameter, action.value))) {
      this.reject(preparation.editToken, "The material parameter or typed value is unavailable."); return;
    }
    pending.phase = "preparing";
    try { this.host.emit({ type: "prepareRuntimeMaterialEdit", ...preparation }); }
    catch (error) { this.reject(preparation.editToken, error instanceof Error ? error.message : "Material preparation transport failed."); }
  }
  receive(message: Response): void {
    if (message.sessionGeneration !== this.host.generation) return;
    const pending = this.pending.get(message.editToken);
    if (!pending || pending.request.requestId !== message.requestId) return;
    if (message.type === "runtimeMaterialEditPrepared") {
      if (pending.phase !== "preparing") return;
      if (!message.success) { this.reject(message.editToken, message.reason ?? "Material preparation failed."); return; }
      if (!this.ownsOriginal(pending)) {
        this.reject(message.editToken, "Gameplay replaced the material while its edit was being prepared."); return;
      }
      const { result, emitted } = this.host.execute(pending.request, pending.preparation);
      if (!result.success) { this.reject(message.editToken, result.reason ?? "The runtime rejected the prepared material edit."); return; }
      pending.result = result;
      const applied = pending.component.getVariable("materialObject");
      pending.appliedMaterial = applied instanceof MaterialObject ? applied : null;
      pending.appliedRevision = applied instanceof MaterialObject ? this.host.materials.revision(applied) : -1;
      pending.phase = "applying";
      if (!emitted) this.complete(message.editToken);
    } else {
      if (pending.phase !== "applying") return;
      if (!message.success) this.reject(message.editToken, message.reason ?? "The renderer rejected the prepared material edit.");
      else this.complete(message.editToken);
    }
  }
  private complete(token: string): void {
    const pending = this.pending.get(token); if (!pending) return;
    this.pending.delete(token); clearTimeout(pending.timer);
    const action = pending.request.action;
    let leases = this.sourceLeases.get(pending.component);
    if (action.kind === "setProperty") {
      for (const lease of leases?.values() ?? []) this.host.releaseSource(lease);
      leases?.clear();
    }
    const key = action.kind === "setMaterialParameter" ? `texture:${action.parameter}` : "material";
    const previous = leases?.get(key);
    if (pending.sourceLease) {
      if (!leases) { leases = new Map(); this.sourceLeases.set(pending.component, leases); }
      leases.set(key, pending.sourceLease);
    } else if (action.kind === "setProperty" || (action.kind === "setMaterialParameter" && action.value.kind === "texture")) leases?.delete(key);
    if (previous && previous !== pending.sourceLease) this.host.releaseSource(previous);
    this.host.emit({ type: "releaseRuntimeMaterialPreparation", sessionGeneration: this.host.generation, editToken: token, committed: true });
    pending.resolve(pending.result!);
  }
  private reject(token: string, reason: string, uncertain = false): void {
    const pending = this.pending.get(token); if (!pending) return;
    this.pending.delete(token); clearTimeout(pending.timer);
    pending.sourceController?.abort();
    if (pending.phase === "applying") {
      const action = pending.request.action;
      const selected = this.host.inspector.resolveTarget("target" in action ? action.target : null!);
      const current = pending.component.getVariable("materialObject");
      const owns = selected === pending.component && current === pending.appliedMaterial &&
        (!(current instanceof MaterialObject) || this.host.materials.revision(current) === pending.appliedRevision);
      if (owns) {
        try {
          if (action.kind === "setProperty") {
            if (pending.originalSourcePresent) pending.component.setVariable("materialSource", pending.originalSource);
            else pending.component.variables.delete("materialSource");
            pending.component.setVariable("materialGuid", pending.originalGuid);
            const original = pending.component.getVariable("materialObject");
            if (original instanceof MaterialObject && pending.originalOverrides) this.host.materials.seed(original, pending.originalOverrides);
          } else if (action.kind === "setMaterialParameter" && current instanceof MaterialObject && pending.originalValue) {
            this.host.materials.set(current, action.parameter, pending.originalValue);
          }
          this.host.restore(pending.component);
        } catch { this.captureFailure = "A rejected material edit could not restore its predecessor owner."; }
      } else this.captureFailure = "Gameplay changed a material during failed editor application; final renderer ownership is unconfirmed.";
      if (uncertain) this.captureFailure = "A material application acknowledgment was lost; final renderer ownership is unconfirmed.";
    }
    this.host.emit({ type: "releaseRuntimeMaterialPreparation", sessionGeneration: this.host.generation, editToken: token, committed: false });
    if (pending.sourceLease) this.host.releaseSource(pending.sourceLease);
    pending.resolve(this.host.inspector.result(pending.request, reason));
  }
  cancel(reason: string): void { for (const token of [...this.pending.keys()]) this.reject(token, reason, true); }
  cancelRequest(requestId: number): void {
    for (const [token, pending] of this.pending) if (pending.request.requestId === requestId)
      this.reject(token, pending.phase === "applying" ? "Inspector request cancelled during renderer application; final ownership is unconfirmed." : "Inspector request cancelled.", true);
  }
}

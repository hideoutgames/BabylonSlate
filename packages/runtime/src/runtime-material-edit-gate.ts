import type { CommandMessage, ControlMessage, RuntimeInspectorRequest, RuntimeInspectorResult, RuntimeMaterialEditPreparation } from "@babylonslate/bridge";
import { ActorComponent, MaterialObject } from "@babylonslate/object-model";
import type { MaterialParameterValue } from "@babylonslate/core";
import type { RuntimeInspector } from "./runtime-inspector";
import type { RuntimeMaterialParameters } from "./runtime-material-parameters";

type Response = Extract<ControlMessage, { type: "runtimeMaterialEditPrepared" | "runtimeMaterialEditApplied" }>;
type Pending = {
  request: RuntimeInspectorRequest; preparation: RuntimeMaterialEditPreparation; component: ActorComponent;
  originalGuid: unknown; originalMaterial: MaterialObject | null; originalRevision: number;
  originalOverrides: Record<string, MaterialParameterValue> | null; originalValue: MaterialParameterValue | null;
  appliedMaterial?: MaterialObject | null; appliedRevision?: number;
  result?: RuntimeInspectorResult; phase: "preparing" | "applying";
  resolve(result: RuntimeInspectorResult): void; timer: ReturnType<typeof setTimeout>;
};

/** Two acknowledgments: preparation leaves the predecessor visible, commit confirms the effective owner. */
export class RuntimeMaterialEditGate {
  private readonly pending = new Map<string, Pending>();
  private captureFailure: string | null = null;
  constructor(private readonly host: {
    generation: number; inspector: RuntimeInspector; materials: RuntimeMaterialParameters;
    slot(component: ActorComponent): number | undefined;
    emit(command: CommandMessage): void;
    execute(request: RuntimeInspectorRequest, preparation: RuntimeMaterialEditPreparation): { result: RuntimeInspectorResult; emitted: boolean };
    restore(component: ActorComponent): void;
  }) {}
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
    if (materialGuid !== null && (typeof materialGuid !== "string" || !this.host.materials.acceptsAssignment(materialGuid))) return fail("The material is unavailable or is not a surface material.");
    if (action.kind === "setMaterialParameter" && (!originalMaterial || originalMaterial.materialAssetGuid !== action.materialGuid || !this.host.materials.accepts(originalMaterial, action.parameter, action.value))) return fail("The material instance, parameter or typed value is unavailable.");
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
      originalRevision: originalMaterial ? this.host.materials.revision(originalMaterial) : -1,
      originalOverrides: originalMaterial ? this.host.materials.captureOverrides(originalMaterial) : null,
      originalValue: action.kind === "setMaterialParameter" && originalMaterial ? this.host.materials.get(originalMaterial, action.parameter, action.value.kind) : null,
      phase: "preparing", resolve, timer: setTimeout(() => this.reject(editToken, "Material preparation or application timed out.", true), 15_000) };
    this.pending.set(editToken, pending);
    this.host.emit({ type: "prepareRuntimeMaterialEdit", ...preparation });
    return true;
  }
  receive(message: Response): void {
    if (message.sessionGeneration !== this.host.generation) return;
    const pending = this.pending.get(message.editToken);
    if (!pending || pending.request.requestId !== message.requestId) return;
    if (message.type === "runtimeMaterialEditPrepared") {
      if (pending.phase !== "preparing") return;
      if (!message.success) { this.reject(message.editToken, message.reason ?? "Material preparation failed."); return; }
      const selected = this.host.inspector.resolveTarget(pending.request.action.kind === "identities" ? null! : pending.request.action.target);
      const current = pending.component.getVariable("materialObject");
      if (selected !== pending.component || pending.component.getVariable("materialGuid") !== pending.originalGuid || current !== pending.originalMaterial ||
        (current instanceof MaterialObject && this.host.materials.revision(current) !== pending.originalRevision)) {
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
    this.host.emit({ type: "releaseRuntimeMaterialPreparation", sessionGeneration: this.host.generation, editToken: token, committed: true });
    pending.resolve({ ...pending.result!, ...this.host.inspector.result(pending.request) });
  }
  private reject(token: string, reason: string, uncertain = false): void {
    const pending = this.pending.get(token); if (!pending) return;
    this.pending.delete(token); clearTimeout(pending.timer);
    if (pending.phase === "applying") {
      const action = pending.request.action;
      const selected = this.host.inspector.resolveTarget(action.kind === "identities" ? null! : action.target);
      const current = pending.component.getVariable("materialObject");
      const owns = selected === pending.component && current === pending.appliedMaterial &&
        (!(current instanceof MaterialObject) || this.host.materials.revision(current) === pending.appliedRevision);
      if (owns) {
        try {
          if (action.kind === "setProperty") {
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
    pending.resolve(this.host.inspector.result(pending.request, reason));
  }
  cancel(reason: string): void { for (const token of [...this.pending.keys()]) this.reject(token, reason, true); }
}

import type { CommandMessage, MaterialParameterValue } from "@babylonslate/bridge";
import {
  normalizeRenderTargetPayload,
  normalizeRenderTargetTexturePayload,
  type RenderTargetPayload,
  type RenderTargetTexturePayload,
  type ScalabilityRequest,
  type ScalabilityResult,
  type ScalabilitySnapshot,
} from "@babylonslate/core";
import {
  Actor,
  ActorComponent,
  getPostProcessMaterialObject,
  type BObject,
  type MaterialInstanceObject,
} from "@babylonslate/object-model";
import { captureComponent } from "./render-targets";
import type { RuntimeMaterialParameters } from "./runtime-material-parameters";
import type { ScriptHostServices } from "./script-host";

/** The actor a script illumination or camera call targets: an actor or one of its components. */
export function actorFromIlluminationTarget(target: unknown): Actor | null {
  if (!target || typeof target !== "object") return null;
  if (target instanceof Actor) return target;
  if (target instanceof ActorComponent) return target.owner;
  return null;
}

interface IlluminationHostDeps {
  slot(actor: Actor): number | undefined;
  /** Resend the actor's component render commands, lights included. */
  emitMeshAssignment(actor: Actor, slotId: number): void;
  possessCamera(target: unknown): void;
}

/** Script illumination and camera calls: Update Illumination and Possess Camera. */
export function createIlluminationHostBindings(deps: IlluminationHostDeps): Pick<ScriptHostServices,
  "possessCamera" | "updateIllumination"> {
  return {
    possessCamera: (target) => {
      deps.possessCamera(target);
    },
    updateIllumination: (target) => {
      const actor = actorFromIlluminationTarget(target);
      if (!actor) return;
      const slotId = deps.slot(actor);
      if (slotId === undefined) return;
      deps.emitMeshAssignment(actor, slotId);
    },
  };
}

interface RenderTargetHostDeps {
  /** Authored Render Target assets by guid. */
  renderTargets: ReadonlyMap<string, RenderTargetPayload>;
  /** Authored Render Target Texture assets by guid. */
  renderTargetTextures: ReadonlyMap<string, RenderTargetTexturePayload>;
  canRun(owner: BObject): boolean;
  emit(command: CommandMessage): void;
}

/** Script render target calls: asset modes and on-demand capture. */
export function createRenderTargetHostBindings(deps: RenderTargetHostDeps): Pick<ScriptHostServices,
  "getRenderTargetMode" | "getRenderTargetTextureTarget" | "captureRenderTarget"> {
  return {
    getRenderTargetMode: (guid) => normalizeRenderTargetPayload(
      deps.renderTargets.get(guid) ?? null,
    ).mode,
    getRenderTargetTextureTarget: (guid) => normalizeRenderTargetTexturePayload(
      deps.renderTargetTextures.get(guid) ?? null,
    ).renderTargetGuid,
    captureRenderTarget: (target) => {
      if (!(target instanceof Actor) || !deps.canRun(target) || !captureComponent(target)) return;
      deps.emit({ type: "captureRenderTarget", actorGuid: target.guid });
    },
  };
}

interface MaterialHostDeps {
  canRun(owner: BObject): boolean;
  materialParameters: Pick<RuntimeMaterialParameters, "hasPostProcessDefinition" | "get" | "resetValue">;
  /** Apply a parameter value; false when it was rejected. */
  setMaterialParameter(material: MaterialInstanceObject, name: string, parameter: MaterialParameterValue): boolean;
}

/** Script material calls: parameter reads, writes and resets, and post-process entries. */
export function createMaterialHostBindings(deps: MaterialHostDeps): Pick<ScriptHostServices,
  "getPostProcessEntry" | "getMaterialParameter" | "resetMaterialParameter" | "setMaterialParameter"> {
  return {
    getPostProcessEntry: (owner, entryId) => {
      if (!deps.canRun(owner)) return null;
      const material = getPostProcessMaterialObject(owner, entryId);
      return material && deps.materialParameters.hasPostProcessDefinition(material) ? material : null;
    },
    getMaterialParameter: (material, name, kind) => deps.canRun(material)
      ? deps.materialParameters.get(material, name, kind) : null,
    resetMaterialParameter: (material, name, kind) => {
      if (!deps.canRun(material)) return false;
      const value = deps.materialParameters.resetValue(material, name, kind);
      return value !== null && deps.setMaterialParameter(material, name, value);
    },
    setMaterialParameter: (material, name, parameter) => { deps.setMaterialParameter(material, name, parameter); },
  };
}

interface ScalabilityHostDeps {
  getScalability(): ScalabilitySnapshot;
  requestScalability(request: ScalabilityRequest): ScalabilityResult;
}

/** Script scalability calls; Set Render Resolution is a custom-resolution patch. */
export function createScalabilityHostBindings(deps: ScalabilityHostDeps): Pick<ScriptHostServices,
  "setRenderResolution" | "getScalability" | "requestScalability"> {
  return {
    setRenderResolution: (width, height) => {
      deps.requestScalability({ kind: "patch", render: { width, height, customResolution: true, blackBars: true } });
    },
    getScalability: () => deps.getScalability(),
    requestScalability: (request) => deps.requestScalability(request),
  };
}

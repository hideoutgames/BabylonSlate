import { MaterialObject, PostProcessMaterialObject, type EngineObject, type MaterialInstanceObject } from "@haptic/object-model";
import type { MaterialParameterValue } from "@haptic/bridge";
import type { ScriptHostServices } from "./script-host-services";

/** What `ScriptMaterialOwnership` reads from its `ScriptHost`. */
export interface MaterialOwnershipHost {
  readonly services: ScriptHostServices;
  canInvokeOwner(owner: EngineObject): boolean;
}

/**
 * Script material and texture replacements for one `ScriptHost`: the latest replacement version per owner
 * and scope (`material`, `texture:<name>`), so a superseded asynchronous set cancels, and the preload
 * each scope holds for the asset it applied.
 */
export class ScriptMaterialOwnership {
  private readonly materialReplacements = new WeakMap<EngineObject, Map<string, number>>();
  private readonly materialPreloads = new WeakMap<EngineObject, Map<string, { id: string; guid: string }>>();
  private readonly host: MaterialOwnershipHost;

  constructor(host: MaterialOwnershipHost) {
    this.host = host;
  }

  beginMaterialReplacement(owner: EngineObject, key: string): number {
    let versions = this.materialReplacements.get(owner);
    if (!versions) { versions = new Map(); this.materialReplacements.set(owner, versions); }
    const version = (versions.get(key) ?? 0) + 1;
    versions.set(key, version);
    return version;
  }

  async prepareMaterialAsset(guid: string, owner: EngineObject | null): Promise<string> {
    if (!this.host.services.acquireAssets) { await this.host.services.prepareAssets?.([guid], owner); return ""; }
    const result = await this.host.services.acquireAssets([guid], owner);
    if (!result.success) throw new Error(`Asset ${guid}, requested by ${owner?.guid ?? "scene"}: ${result.errorMessage}`);
    return result.preloadId;
  }

  /** Holds `preload` (the asset it keeps loaded) for the owner's scope, releasing the one it replaces. */
  retainMaterialPreload(owner: EngineObject, key: string, preload: { id: string; guid: string } | null): void {
    let scopes = this.materialPreloads.get(owner);
    const previous = scopes?.get(key);
    if (preload?.id) {
      if (!scopes) { scopes = new Map(); this.materialPreloads.set(owner, scopes); }
      scopes.set(key, preload);
    } else scopes?.delete(key);
    if (previous && previous.id !== preload?.id) this.host.services.releaseAcquiredAssets?.(previous.id);
  }

  /** A synchronous set keeps the scope's preload only while it holds the asset being set. */
  releaseMaterialPreloadUnlessHolding(owner: EngineObject, key: string, guid: string): void {
    const held = this.materialPreloads.get(owner)?.get(key);
    if (held && held.guid !== guid) this.retainMaterialPreload(owner, key, null);
  }

  releaseMaterialPreloads(owner: EngineObject): void {
    const scopes = this.materialPreloads.get(owner);
    this.materialPreloads.delete(owner);
    for (const { id } of scopes?.values() ?? []) this.host.services.releaseAcquiredAssets?.(id);
  }

  isMaterialReplacementCurrent(owner: EngineObject, key: string, version: number): boolean {
    return this.materialReplacements.get(owner)?.get(key) === version;
  }

  setMaterialParameter(
    material: unknown,
    name: string,
    parameter: MaterialParameterValue,
  ): void {
    if (!this.materialAvailable(material) || typeof name !== "string" || !name.trim()) return;
    this.host.services.setMaterialParameter?.(material, name.trim(), parameter);
  }

  materialAvailable(material: unknown): material is MaterialInstanceObject {
    if (!(material instanceof MaterialObject || material instanceof PostProcessMaterialObject) || !this.host.canInvokeOwner(material)) return false;
    return material instanceof PostProcessMaterialObject ? material.isCurrent() : material.component.getVariable("materialObject") === material;
  }

  getMaterialParameter(material: unknown, name: string, kind: MaterialParameterValue["kind"]): MaterialParameterValue | null {
    if (!this.materialAvailable(material) || typeof name !== "string" || !name.trim()) return null;
    return this.host.services.getMaterialParameter?.(material, name.trim(), kind) ?? null;
  }

  resetMaterialParameter(material: unknown, name: string, kind: MaterialParameterValue["kind"]): boolean {
    if (!this.materialAvailable(material) || typeof name !== "string" || !name.trim()) return false;
    return this.host.services.resetMaterialParameter?.(material, name.trim(), kind) ?? false;
  }
}

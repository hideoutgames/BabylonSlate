import { Actor, engineScriptApiFor, Scene, SceneLayer, type ActorComponent, type EngineObject } from "@haptic/object-model";
import type { ScriptHostServices, ScriptNodeLocation } from "./script-host-services";

/** The diagnostic code of a script write or spawn that waits for an asset its owner did not load. */
export const ASSET_LOAD_ON_DEMAND_DIAGNOSTIC_CODE = "runtime.assetLoadOnDemand";
/** The diagnostic code of an on-demand asset load that failed, or that names an asset the game does not include. */
export const ASSET_LOAD_FAILED_DIAGNOSTIC_CODE = "runtime.assetLoadFailed";

/**
 * Asset types whose consumers load them on their own: a Scene Streaming component streams its Target Scene, and
 * the audio host prepares a cold Audio clip when a voice starts.
 */
const SELF_LOADING_ASSET_TYPES: ReadonlySet<string> = new Set(["Scene", "Audio"]);

/** What `ScriptAssetLoads` reads from its `ScriptHost`. */
export interface AssetLoadsHost {
  readonly services: ScriptHostServices;
  canInvokeOwner(owner: EngineObject): boolean;
}

/** One write waiting for its asset: the value, and what the property held when the write was made. */
interface PendingWrite {
  readonly value: unknown;
  readonly previous: unknown;
}

/** Who asked for an on-demand load, for the messages: the script's owner and the node, when a compiled node runs. */
interface LoadRequest {
  guid: string;
  /** The asset type the consumer takes, named when the catalog does not know the asset. */
  type: string;
  /** What waits for the asset, e.g. `Material on 2D Post Processing Panel of actor "Hud"`. */
  consumer: string;
  /** What happens once it loads, e.g. `it applies to Material on …` or `the decal spawns`. */
  onLoad: string;
  caller: EngineObject | null;
}

/** "ParticleSystem" as messages name it: "Particle System" ("2DPostProcessingPanel": "2D Post Processing Panel"). */
function typeLabel(type: string): string {
  return type.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z])([A-Z][a-z])/g, "$1 $2") || "Asset";
}

/** `2D Post Processing Panel of actor "Hud"`: the component's class without its suffix, and its actor's name. */
function componentLabel(component: ActorComponent): string {
  const owner = component.owner;
  const name = owner?.getVariable("name");
  const actor = typeof name === "string" && name.trim() ? name.trim() : owner?.guid ?? "";
  return `${typeLabel(component.classId.replace(/Component$/, ""))}${owner ? ` of actor "${actor}"` : ""}`;
}

/**
 * On-demand loading for script writes of assets their owner did not load (Soft references): a component asset
 * property keeps showing its previous value while the asset loads, then takes the new one; Spawn Decal and Spawn
 * Particles wait the same way. The first such write per asset and node warns; a failed load or an asset the game
 * does not include is an error, and the property keeps its value.
 *
 * Read back meanwhile, the property answers with the value the script set (`pendingValue`), as any Set Variable
 * does; everything that draws, simulates or saves the component reads the value it shows. The latest write wins: a
 * later write (deferred or not) supersedes one still loading, whose load then applies nothing. A write is also
 * dropped when its component is destroyed, or when something other than a script (a Save Game load, the runtime
 * Inspector) changes the property meanwhile. A load stays owned by the component's actor, so switching back to
 * the asset later applies at once.
 */
export class ScriptAssetLoads {
  private readonly host: AssetLoadsHost;
  private readonly pending = new WeakMap<ActorComponent, Map<string, PendingWrite>>();
  /** Writes waiting now; zero lets every component read and write skip the lookup. */
  private pendingCount = 0;
  /** Asset-typed, script-settable properties per component class id (its engine ancestry's script API). */
  private readonly assetProperties = new Map<string, ReadonlyMap<string, { type: string; label: string }>>();
  /** Warnings and errors already reported, by asset and node. */
  private readonly reported = new Set<string>();

  constructor(host: AssetLoadsHost) {
    this.host = host;
  }

  /** Whether `guid` names an asset this host loads on demand and has not loaded. */
  needsLoad(guid: string): boolean {
    const services = this.host.services;
    if (!services.prepareAssets || !guid || guid.startsWith("engine:")) return false;
    return services.getAssetLoadState?.(guid) !== "ready";
  }

  /** The value a script set on a property whose asset is still loading; `undefined` when none waits. */
  pendingValue(component: ActorComponent, name: string): { value: unknown } | undefined {
    if (this.pendingCount === 0) return undefined;
    const write = this.pending.get(component)?.get(name);
    return write ? { value: write.value } : undefined;
  }

  /**
   * A script write of `value` to the component's `name`. Returns true when the write waits for its asset (or was
   * refused because the game lacks it), after which `apply` runs once the asset is ready and the write is still
   * current; false when the caller applies it now, which also supersedes any write still loading.
   */
  deferComponentWrite(component: ActorComponent, name: string, value: unknown, caller: EngineObject | null,
    apply: () => void, onFailed?: () => void): boolean {
    // Called for every component Set Variable: anything but an asset string, with nothing waiting, ends here.
    if (this.pendingCount === 0 && typeof value !== "string") return false;
    const property = this.assetProperty(component, name);
    if (!property) return false;
    let writes = this.pending.get(component);
    const current = writes?.get(name);
    if (current && Object.is(current.value, value)) return true;
    if (current) { writes!.delete(name); this.pendingCount--; }
    const guid = typeof value === "string" ? value.trim() : "";
    if (!this.needsLoad(guid)) return false;
    const consumer = `${property.label} on ${componentLabel(component)}`;
    const request: LoadRequest = { guid, type: property.type, consumer, onLoad: `it applies to ${consumer} when loaded`, caller };
    if (!this.admit(request)) { onFailed?.(); return true; }
    const write: PendingWrite = { value, previous: component.getVariable(name) };
    if (!writes) { writes = new Map(); this.pending.set(component, writes); }
    writes.set(name, write);
    this.pendingCount++;
    const location = this.host.services.locateScriptNode?.() ?? null;
    this.warn(request, location);
    const settle = (): boolean => {
      const live = this.pending.get(component);
      if (live?.get(name) !== write) return false;
      live.delete(name);
      this.pendingCount--;
      return true;
    };
    const gone = () => component.destroyed || !component.owner || component.owner.destroyed;
    void this.host.services.prepareAssets!([guid], component.owner ?? null).then(() => {
      if (!settle() || gone() || !this.host.canInvokeOwner(component)) return;
      // Something other than a script (a Save Game load, the runtime Inspector) changed the property meanwhile.
      if (!Object.is(component.getVariable(name), write.previous)) return;
      apply();
    }, (error: unknown) => {
      if (!settle() || gone()) return;
      this.fail(request, location, error);
      onFailed?.();
    });
    return true;
  }

  /**
   * Runs `spawn` once `guid` is loaded (at once when it already is), for a spawn whose node returns nothing. The
   * spawn is dropped when `caller` is destroyed meanwhile, the load fails, or the game does not include the asset.
   */
  whenLoaded(guid: string, request: Omit<LoadRequest, "guid" | "caller">, caller: EngineObject | null, spawn: () => void): void {
    if (!this.needsLoad(guid)) { spawn(); return; }
    const load: LoadRequest = { ...request, guid, caller };
    if (!this.admit(load)) return;
    const location = this.host.services.locateScriptNode?.() ?? null;
    this.warn(load, location);
    void this.host.services.prepareAssets!([guid], caller).then(() => {
      if (!caller?.destroyed) spawn();
    }, (error: unknown) => {
      if (!caller?.destroyed) this.fail(load, location, error);
    });
  }

  /** A script-settable component property holding an asset this host loads on demand: its asset type and name. */
  private assetProperty(component: ActorComponent, name: string): { type: string; label: string } | undefined {
    let properties = this.assetProperties.get(component.classId);
    if (!properties) {
      const found = new Map<string, { type: string; label: string }>();
      const ancestry = this.host.services.classRegistry?.ancestry(component.classId) ?? [component.classId];
      for (const classId of ancestry) {
        for (const variable of engineScriptApiFor(classId)?.variables ?? []) {
          if (variable.typeId !== "asset" || variable.getOnly || (variable.container ?? "single") !== "single") continue;
          const type = variable.typeClassId ?? "";
          if (!SELF_LOADING_ASSET_TYPES.has(type) && !found.has(variable.propertyKey)) found.set(variable.propertyKey, { type, label: variable.name });
        }
      }
      properties = found;
      this.assetProperties.set(component.classId, properties);
    }
    return properties.get(name);
  }

  /** False, with an error, when the game's catalog does not include the asset (an empty catalog trusts every guid). */
  private admit(request: LoadRequest): boolean {
    const catalog = this.host.services.getAssetCatalog?.();
    if (!catalog || catalog.assetCount === 0 || catalog.hasAsset(request.guid)) return true;
    const location = this.host.services.locateScriptNode?.() ?? null;
    this.report("error", ASSET_LOAD_FAILED_DIAGNOSTIC_CODE, request, location,
      `${typeLabel(request.type)} ${request.guid} is not included in this game, so ${request.consumer} keeps its current value. ` +
      "Reference it from a Class, Scene or Data asset the game ships, or add its folder to Always Package Folders.");
    return false;
  }

  private warn(request: LoadRequest, location: ScriptNodeLocation | null): void {
    const owner = request.caller instanceof Scene ? "this Scene" : request.caller instanceof SceneLayer ? "this Scene Layer"
      : request.caller instanceof Actor || request.caller ? "this Class" : "its owner";
    this.report("warning", ASSET_LOAD_ON_DEMAND_DIAGNOSTIC_CODE, request, location,
      `${this.assetLabel(request)} was not loaded with ${owner}; ${request.onLoad}. ` +
      "Set the variable to Hard (Load With Owner), or load it first with Load Asset (Async), to have it ready at once.");
  }

  private fail(request: LoadRequest, location: ScriptNodeLocation | null, error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);
    this.report("error", ASSET_LOAD_FAILED_DIAGNOSTIC_CODE, request, location,
      `${this.assetLabel(request)} failed to load, so ${request.consumer} keeps its current value: ${reason}`);
  }

  /** Reported once per severity, asset and node (once per asset outside compiled nodes). */
  private report(severity: "warning" | "error", code: string, request: LoadRequest, location: ScriptNodeLocation | null,
    message: string): void {
    const key = `${severity}|${request.guid}|${location?.assetGuid ?? ""}|${location?.graphId ?? ""}|${location?.nodeId ?? ""}`;
    if (this.reported.has(key)) return;
    this.reported.add(key);
    const services = this.host.services;
    if (services.reportScriptDiagnostic) services.reportScriptDiagnostic({ severity, code, category: "Assets", message, location });
    else services.log(severity, "Assets", message);
  }

  /** `Material "Glow"`, from the catalog; the guid when the catalog does not name it. */
  private assetLabel(request: LoadRequest): string {
    const data = this.host.services.getAssetCatalog?.()?.getAssetData(request.guid);
    const type = typeLabel(data?.Type || request.type);
    return data?.Name ? `${type} "${data.Name}"` : `${type} ${request.guid}`;
  }
}

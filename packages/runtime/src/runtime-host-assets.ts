import { isLockedEngineClassId, type BObject, type World } from "@babylonslate/object-model";
import type { RuntimeAssetPreloads } from "./asset-preloads";
import type { ScriptHostServices } from "./script-host";
import type { SimulationBlocks } from "./simulation-blocks";

interface AssetHostDeps {
  world(): World;
  demandAssetCatalog: boolean;
  /** Class id to its asset guid, for classes the host prepares on demand. */
  classAssetGuids: ReadonlyMap<string, string>;
  assetPreloads: Pick<RuntimeAssetPreloads, "prepare" | "acquire" | "release" | "request" | "requestFailed" | "wait" |
    "releaseHandle" | "unload" | "handleState" | "handleProgress" | "getState">;
  blocks: Pick<SimulationBlocks, "hold">;
  /** Pending while Pause, a blocking load or a session boundary holds the owner's continuation. */
  continueSimulation(owner: BObject | null): Promise<void> | undefined;
}

/**
 * Script asset loading: consumers' on-demand preparation and the load handles
 * scripts request, wait on, query and release. A handle belongs to the calling
 * object, else the current Scene, else the session (Session Wide).
 */
export function createAssetHostBindings(deps: AssetHostDeps): Pick<ScriptHostServices,
  "prepareAssets" | "acquireAssets" | "releaseAcquiredAssets" | "getAssetLoadState" |
  "requestAssetLoad" | "requestClassLoad" | "waitForAssetLoad" | "releaseAssetLoad" | "unloadAsset" |
  "getAssetLoadHandleState" | "getAssetLoadHandleProgress"> {
  const preloads = deps.assetPreloads;
  const ownerId = (owner: BObject | null): string => owner?.guid ?? deps.world().currentScene?.guid ?? "session";
  const continueFor = async (owner: BObject | null): Promise<void> => {
    const pending = deps.continueSimulation(owner);
    if (pending) await pending;
  };
  return {
    prepareAssets: deps.demandAssetCatalog ? async (assets, owner) => {
      try { await preloads.prepare(assets, ownerId(owner)); }
      catch (error) {
        await continueFor(owner);
        throw error;
      }
      await continueFor(owner);
    } : undefined,
    acquireAssets: async (assets, owner) => {
      let result;
      try {
        result = await preloads.acquire(assets, ownerId(owner));
        await continueFor(owner);
        return result;
      } catch (error) {
        if (result?.preloadId) preloads.release(result.preloadId);
        throw error;
      }
    },
    releaseAcquiredAssets: (preloadId) => preloads.release(preloadId),
    getAssetLoadState: (assetGuid) => preloads.getState(assetGuid),
    requestAssetLoad: (assets, owner, options) => preloads.request(assets, ownerId(owner), options),
    requestClassLoad: (classId, owner, options) => {
      const id = String(classId ?? "").trim();
      const guid = deps.classAssetGuids.get(id);
      // A host that holds every Class, and an engine Class, have nothing to load.
      if (!deps.demandAssetCatalog || (!guid && isLockedEngineClassId(id))) return preloads.request([], ownerId(owner), options);
      if (!guid) {
        return preloads.requestFailed(ownerId(owner),
          `Class ${id || "(none)"} is missing from the asset catalog; choose a Class from this project`, options);
      }
      return preloads.request([guid], ownerId(owner), options);
    },
    waitForAssetLoad: async (handle, owner, blocking) => {
      const settled = preloads.wait(handle);
      // A handle that has already settled holds nothing, so it leaves no pause behind.
      const result = await (blocking && preloads.handleState(handle) === "Loading" ? deps.blocks.hold(settled) : settled);
      await continueFor(owner);
      return { success: result.success, errorMessage: result.errorMessage };
    },
    releaseAssetLoad: (handle) => preloads.releaseHandle(handle),
    unloadAsset: (asset, owner, options) => preloads.unload(asset, options?.sessionWide ? "session" : ownerId(owner)),
    getAssetLoadHandleState: (handle) => preloads.handleState(handle),
    getAssetLoadHandleProgress: (handle) => preloads.handleProgress(handle),
  };
}

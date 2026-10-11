/** Main/worker contract; readiness includes the consumer's runtime preparation. */
export type RuntimeAssetLoadState = "unloaded" | "loading" | "ready" | "failed";

/** Script-facing `engine:AssetLoadState` members. */
export const ASSET_LOAD_STATES = ["Unloaded", "Loading", "Loaded", "Failed"] as const;
export type AssetLoadStateName = (typeof ASSET_LOAD_STATES)[number];

/** Script-facing `engine:AssetLoadHandleState` members. */
export const ASSET_LOAD_HANDLE_STATES = ["Loading", "Loaded", "Failed", "Released"] as const;
export type AssetLoadHandleState = (typeof ASSET_LOAD_HANDLE_STATES)[number];

/** Script-facing `engine:AssetLoadPriority` members. */
export const ASSET_LOAD_PRIORITIES = ["Low", "Normal", "High"] as const;
export type AssetLoadPriorityName = (typeof ASSET_LOAD_PRIORITIES)[number];

/** The host scheduler's priorities (`AssetLoadingService`, native preparation). */
export type RuntimeAssetSchedulerPriority = "gameplay" | "preload" | "background";

/** Load priority a script chooses → the order the host schedules the work in. */
export const ASSET_LOAD_PRIORITY_SCHEDULING: Readonly<Record<AssetLoadPriorityName, RuntimeAssetSchedulerPriority>> = {
  High: "gameplay",
  Normal: "preload",
  Low: "background",
};

const HOST_STATE_NAMES: Readonly<Record<RuntimeAssetLoadState, AssetLoadStateName>> = {
  unloaded: "Unloaded",
  loading: "Loading",
  ready: "Loaded",
  failed: "Failed",
};

/** A host-published per-asset state as the script-facing enum member. */
export function assetLoadStateName(state: RuntimeAssetLoadState | undefined): AssetLoadStateName {
  return state ? HOST_STATE_NAMES[state] : "Unloaded";
}

/** A load request's result: the handle it created and how it settled. */
export interface RuntimeAssetPreloadResult {
  preloadId: string;
  success: boolean;
  progress: number;
  errorMessage: string;
}

export interface RuntimeAssetPreloadOptions {
  /** Otherwise ownership follows the calling scene or runtime object. */
  sessionWide?: boolean;
  /** Default Normal. */
  priority?: AssetLoadPriorityName;
}

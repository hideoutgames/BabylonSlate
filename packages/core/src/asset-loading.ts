/** Main/worker contract; readiness includes the consumer's runtime preparation. */
export type RuntimeAssetLoadState = "unloaded" | "loading" | "ready" | "failed";
export interface RuntimeAssetPreloadResult {
  preloadId: string;
  success: boolean;
  progress: number;
  errorMessage: string;
}
export interface RuntimeAssetPreloadOptions {
  /** Otherwise ownership follows the calling scene or runtime object. */
  sessionWide?: boolean;
  onProgress?: (progress: number) => void;
}

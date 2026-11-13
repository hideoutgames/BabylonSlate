/** The desktop app's automatic update, as the launcher shows it. */
export type AppUpdateStatus =
  | { state: "idle" }
  | { state: "downloading"; version: string; percent: number }
  | { state: "ready"; version: string };

export interface AppUpdates {
  status(): Promise<AppUpdateStatus>;
  /** Calls `listener` with every later status; returns the unsubscribe function. */
  subscribe(listener: (status: AppUpdateStatus) => void): () => void;
  /** Quits, installs the downloaded update and starts the new version; false while none is waiting. */
  restart(): Promise<boolean>;
}

type ElectronUpdatesBridge = {
  status(): Promise<AppUpdateStatus>;
  restart(): Promise<boolean>;
  onStatus(listener: (status: AppUpdateStatus) => void): () => void;
};

/**
 * Only the desktop app updates itself in place; the web reloads into new
 * versions and the stores update the mobile apps. Null everywhere else.
 */
export function getAppUpdates(): AppUpdates | null {
  const bridge = (globalThis as { haptic?: { updates?: ElectronUpdatesBridge } }).haptic?.updates;
  if (!bridge) return null;
  return {
    status: () => bridge.status(),
    subscribe: (listener) => bridge.onStatus(listener),
    restart: () => bridge.restart(),
  };
}

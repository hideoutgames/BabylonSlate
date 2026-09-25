import type { AppUpdater, UpdateCheckResult } from "electron-updater";

type Updater = Pick<AppUpdater, "autoDownload" | "autoInstallOnAppQuit" | "allowPrerelease" | "allowDowngrade" | "checkForUpdates" | "downloadUpdate"> & {
  on(event: "error", listener: (error: Error) => void): unknown;
};

/** Read only this preference: an unrelated legacy setting must not reset opt-out. */
export function automaticUpdatesEnabled(json: string | null): boolean {
  try { return JSON.parse(json ?? "{}")?.automaticUpdatesEnabled !== false; }
  catch { return true; }
}

/** Owns checks/downloads; electron-updater owns verified installation on normal quit. */
export function createDesktopUpdates(updater: Updater, reportError: (error: unknown) => void) {
  let enabled = false;
  let generation = 0;
  let pending = false;
  let token: UpdateCheckResult["cancellationToken"];
  let timer: ReturnType<typeof setInterval> | undefined;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.on("error", reportError);

  async function check() {
    if (!enabled || pending) return;
    pending = true;
    const started = generation;
    try {
      const result = await updater.checkForUpdates();
      if (!enabled || started !== generation || !result?.isUpdateAvailable) return;
      token = result.cancellationToken;
      await updater.downloadUpdate(token);
    } catch (error) {
      if (enabled && started === generation) reportError(error);
    } finally {
      token = undefined;
      pending = false;
      // A preference re-enabled during an older check gets a fresh check.
      if (enabled && started !== generation) void check();
    }
  }

  function setEnabled(value: boolean) {
    if (enabled === value) return;
    enabled = value;
    generation += 1;
    updater.autoInstallOnAppQuit = enabled;
    if (timer) clearInterval(timer);
    timer = undefined;
    if (!enabled) {
      token?.cancel();
      return;
    }
    void check();
    timer = setInterval(() => void check(), 6 * 60 * 60 * 1000);
    timer.unref();
  }

  return { setEnabled };
}

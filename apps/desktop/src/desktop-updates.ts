import type { AppUpdater, UpdateCheckResult } from "electron-updater";

type Updater = Pick<AppUpdater, "autoDownload" | "autoInstallOnAppQuit" | "allowPrerelease" | "allowDowngrade" | "checkForUpdates" | "downloadUpdate" | "quitAndInstall"> & {
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "download-progress", listener: (progress: { percent: number }) => void): unknown;
  on(event: "update-downloaded", listener: (info: { version: string }) => void): unknown;
};

/** What the launcher shows: nothing, a download in progress, or an update waiting for a restart. */
export type DesktopUpdateStatus =
  | { state: "idle" }
  | { state: "downloading"; version: string; percent: number }
  | { state: "ready"; version: string };

/**
 * Read only this preference: an unrelated setting must not reset opt-out.
 * Missing settings default on; unreadable settings may hold an opt-out, so they stay off.
 */
export function automaticUpdatesEnabled(json: string | null): boolean {
  try { return JSON.parse(json ?? "{}")?.automaticUpdatesEnabled !== false; }
  catch { return false; }
}

export function updatesSupported(
  platform: NodeJS.Platform,
  manifest: { channel?: unknown; packageVersion?: unknown; macosSigned?: unknown },
  appVersion: string,
  env: NodeJS.ProcessEnv,
): boolean {
  if (manifest.channel !== "release" || manifest.packageVersion !== appVersion) return false;
  if (platform === "win32") return true;
  if (platform === "linux") return typeof env.APPIMAGE === "string" && env.APPIMAGE.length > 0;
  if (platform === "darwin") return manifest.macosSigned === true;
  return false;
}

/**
 * Owns checks/downloads; electron-updater owns verified installation, on normal
 * quit or when the launcher's Restart to Update asks for it.
 */
export function createDesktopUpdates(
  updater: Updater,
  reportError: (error: unknown) => void,
  onStatus: (status: DesktopUpdateStatus) => void = () => {},
) {
  let enabled = false;
  let generation = 0;
  let pending = false;
  let token: UpdateCheckResult["cancellationToken"];
  let timer: ReturnType<typeof setInterval> | undefined;
  let status: DesktopUpdateStatus = { state: "idle" };
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.on("error", reportError);

  function publish(next: DesktopUpdateStatus) {
    status = next;
    onStatus(next);
  }
  // Whole percents only: the launcher's bar needs no finer steps than that.
  updater.on("download-progress", ({ percent }) => {
    const whole = Math.min(100, Math.max(0, Math.floor(percent)));
    if (status.state === "downloading" && whole !== status.percent) publish({ ...status, percent: whole });
  });
  // electron-updater may install only after this event (on macOS, once Squirrel has the update too).
  updater.on("update-downloaded", ({ version }) => {
    if (enabled) publish({ state: "ready", version });
  });

  async function check() {
    if (!enabled || pending) return;
    pending = true;
    const started = generation;
    try {
      const result = await updater.checkForUpdates();
      if (!enabled || started !== generation || !result?.isUpdateAvailable) return;
      const version = result.updateInfo.version;
      // A later periodic check finds the same update again; it is already waiting.
      if (status.state === "ready" && status.version === version) return;
      token = result.cancellationToken;
      publish({ state: "downloading", version, percent: 0 });
      await updater.downloadUpdate(token);
    } catch (error) {
      if (status.state === "downloading") publish({ state: "idle" });
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
      if (status.state !== "idle") publish({ state: "idle" });
      return;
    }
    void check();
    timer = setInterval(() => void check(), 6 * 60 * 60 * 1000);
    timer.unref();
  }

  /** Quits, installs the downloaded update and starts the new version; false while none is waiting. */
  function restart(): boolean {
    if (!enabled || status.state !== "ready") return false;
    updater.quitAndInstall(true, true);
    return true;
  }

  return { setEnabled, status: () => status, restart };
}

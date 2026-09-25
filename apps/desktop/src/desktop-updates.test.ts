import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import type { UpdateCheckResult } from "electron-updater";
import { automaticUpdatesEnabled, createDesktopUpdates } from "./desktop-updates";

function harness(initial: string | null = null) {
  const cancel = vi.fn();
  const result = {
    isUpdateAvailable: true,
    updateInfo: { version: "1.2.4-release", files: [], path: "update.exe", sha512: "hash" },
    versionInfo: { version: "1.2.4-release", files: [], path: "update.exe", sha512: "hash" },
    cancellationToken: { cancel },
  } as unknown as UpdateCheckResult;
  const driver = Object.assign(new EventEmitter(), {
    autoDownload: true, autoInstallOnAppQuit: true, allowPrerelease: true, allowDowngrade: true,
    checkForUpdates: vi.fn<() => Promise<UpdateCheckResult | null>>().mockResolvedValue(result),
    downloadUpdate: vi.fn(async () => ["verified-update.exe"]),
  });
  const errors = vi.fn();
  const controller = createDesktopUpdates(driver, errors);
  return { driver, errors, result, cancel, controller, start: () => controller.setEnabled(automaticUpdatesEnabled(initial)) };
}

afterEach(() => vi.useRealTimers());

it.each([null, false])("does not download when a check reports no update (%s)", async available => {
  vi.useFakeTimers();
  const { driver, result, start, controller } = harness();
  driver.checkForUpdates.mockResolvedValue(available === null ? null : { ...result, isUpdateAvailable: false });
  start();
  await vi.advanceTimersByTimeAsync(0);
  expect(driver.downloadUpdate).not.toHaveBeenCalled();
  controller.setEnabled(false);
});

it("defaults legacy settings to background release downloads and normal-quit installation", async () => {
  vi.useFakeTimers();
  const { driver, start, controller } = harness('{"undoHistoryLength":50}');
  start();
  await vi.advanceTimersByTimeAsync(0);
  expect(driver.checkForUpdates).toHaveBeenCalledOnce();
  expect(driver.downloadUpdate).toHaveBeenCalledOnce();
  expect(driver.autoInstallOnAppQuit).toBe(true);
  expect(driver.allowPrerelease).toBe(false);
  expect(driver.allowDowngrade).toBe(false);
  await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
  expect(driver.checkForUpdates).toHaveBeenCalledTimes(2);
  controller.setEnabled(false);
  expect(driver.autoInstallOnAppQuit).toBe(false);
});

it("honors saved opt-out at startup and resumes when enabled", async () => {
  vi.useFakeTimers();
  const { driver, start, controller } = harness('{"automaticUpdatesEnabled":false,"unrelatedLegacySetting":null}');
  start();
  await vi.advanceTimersByTimeAsync(12 * 60 * 60 * 1000);
  expect(driver.checkForUpdates).not.toHaveBeenCalled();
  expect(driver.autoInstallOnAppQuit).toBe(false);
  controller.setEnabled(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(driver.downloadUpdate).toHaveBeenCalledOnce();
  controller.setEnabled(false);
});

it("does not download a check that finishes after opt-out", async () => {
  vi.useFakeTimers();
  const { driver, result, start, controller } = harness();
  let finish!: (result: UpdateCheckResult) => void;
  driver.checkForUpdates.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  start();
  controller.setEnabled(false);
  finish(result);
  await vi.advanceTimersByTimeAsync(12 * 60 * 60 * 1000);
  expect(driver.downloadUpdate).not.toHaveBeenCalled();
  expect(driver.checkForUpdates).toHaveBeenCalledOnce();
  expect(driver.autoInstallOnAppQuit).toBe(false);
});

it("cancels a download on opt-out and tolerates offline errors", async () => {
  vi.useFakeTimers();
  const { driver, cancel, errors, start, controller } = harness();
  let fail!: (error: Error) => void;
  driver.downloadUpdate.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
  start();
  await vi.advanceTimersByTimeAsync(0);
  controller.setEnabled(false);
  expect(cancel).toHaveBeenCalledOnce();
  expect(driver.autoInstallOnAppQuit).toBe(false);
  fail(new Error("Cancelled"));
  await vi.advanceTimersByTimeAsync(0);
  driver.checkForUpdates.mockRejectedValue(new Error("Offline"));
  controller.setEnabled(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(errors).toHaveBeenCalledWith(expect.objectContaining({ message: "Offline" }));
  expect(() => driver.emit("error", new Error("Network error"))).not.toThrow();
  controller.setEnabled(false);
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { defaultEngineSettings, type AppSettingsStore, type EngineSettings } from "@haptic/vfs";
import { AppSettingsProvider, useAppSettings, useDebugMode } from "../context/app-settings-context";
import { DiagnosticLogInstaller } from "./diagnostic-log-installer";

const host = vi.hoisted(() => ({ mobile: true }));

vi.mock("@haptic/vfs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@haptic/vfs")>()),
  isMobilePlatform: () => host.mobile,
}));

afterEach(cleanup);

function storeWith(patch: Partial<EngineSettings>): AppSettingsStore {
  const settings = { ...defaultEngineSettings(), ...patch };
  return { load: async () => settings, save: async () => {}, update: async () => settings };
}

/** Shows once the stored settings are in, so an absence is not read before Debug Mode could apply. */
function Hydrated() {
  const { hydrated } = useAppSettings();
  const debugMode = useDebugMode();
  return hydrated ? <span>{`debug ${debugMode}`}</span> : null;
}

async function mount(debugMode: boolean) {
  render(<AppSettingsProvider store={storeWith({ debugMode })}><Hydrated /><DiagnosticLogInstaller /></AppSettingsProvider>);
  await screen.findByText(`debug ${debugMode}`);
}

const benchmark = () => (globalThis as { hapticGitBenchmark?: unknown }).hapticGitBenchmark;

// The benchmark clones into a second storage instance. Only mobile storage binds a folder per
// instance; desktop's binds one per window, so offering it there would move the open project.
describe("DiagnosticLogInstaller", () => {
  it("offers the Git benchmark to the console only in Debug Mode on iOS and Android", async () => {
    host.mobile = true;
    await mount(true);
    expect(typeof benchmark()).toBe("function");
    cleanup();
    expect(benchmark()).toBeUndefined();

    host.mobile = false;
    await mount(true);
    expect(benchmark()).toBeUndefined();
    cleanup();

    host.mobile = true;
    await mount(false);
    expect(benchmark()).toBeUndefined();
  });
});

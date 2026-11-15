import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { GitBenchmarkResult } from "@haptic/source-control/git-benchmark";
import { defaultEngineSettings, type AppSettingsStore, type EngineSettings } from "@haptic/vfs";
import type { EditorGitBenchmarkOptions } from "../lib/git-benchmark-runner";
import { AppSettingsProvider, useAppSettings, useDebugMode } from "../context/app-settings-context";
import { DiagnosticLogInstaller } from "./diagnostic-log-installer";

const host = vi.hoisted(() => ({ mobile: true }));
// The runner clones and pushes through the device's storage, native HTTP and saved credential.
const runner = vi.hoisted(() => ({ run: vi.fn<(options: EditorGitBenchmarkOptions) => Promise<GitBenchmarkResult>>() }));

vi.mock("@haptic/vfs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@haptic/vfs")>()),
  isMobilePlatform: () => host.mobile,
}));

vi.mock("../lib/git-benchmark-runner", () => ({ runGitBenchmarkInEditor: runner.run }));

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

const benchmark = () =>
  (globalThis as { hapticGitBenchmark?: (options: EditorGitBenchmarkOptions) => Promise<GitBenchmarkResult> }).hapticGitBenchmark;

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

  // The Debug menu's dialog runs the same runner; the console keeps its options and gets the result back.
  it("runs the benchmark from the console with the options it is given and returns the result", async () => {
    host.mobile = true;
    const result = { leftovers: "Branch haptic-benchmark-20261115120000 on the host." } as GitBenchmarkResult;
    runner.run.mockResolvedValue(result);
    await mount(true);
    const options = { repositoryUrl: "https://github.com/acme/bench.git", branch: "develop", blobs: 1, blobMiB: 4, depth: 2 };
    await expect(benchmark()!(options)).resolves.toBe(result);
    expect(runner.run).toHaveBeenCalledExactlyOnceWith(options);
  });
});

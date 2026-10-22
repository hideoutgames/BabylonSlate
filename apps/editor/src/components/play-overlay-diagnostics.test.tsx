import { Profiler } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Engine } from "@babylonjs/core";
import type { RenderDiagnostics } from "@haptic/render";
import { startPlaySession, type PlaySession } from "../services/play-session";
import { PLAY_PROBE_KEY, playProbes } from "../services/runtime-probes";
import { PlayOverlay } from "./play-overlay";

vi.mock("../services/play-session", () => ({ startPlaySession: vi.fn() }));
vi.mock("../context/play-context", () => ({
  usePlay: () => ({ overlayStats: true }),
}));
vi.mock("../context/app-settings-context", () => ({
  useAppSettings: () => ({ settings: {} }),
}));
vi.mock("@haptic/vfs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@haptic/vfs")>()),
  createAppSettingsStore: () => ({ load: () => new Promise(() => {}) }),
  getHostMemoryStats: () => Promise.resolve(null),
}));
vi.mock("../services/lifecycle-pause", () => ({ attachLifecyclePause: () => () => {} }));

const polls: Array<() => void> = [];

beforeEach(() => {
  polls.length = 0;
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  // The 200 ms HUD poll runs only when the test steps it.
  const setInterval = window.setInterval.bind(window);
  vi.spyOn(window, "setInterval").mockImplementation((handler, delay, ...args) => {
    if (delay !== 200) return setInterval(handler, delay, ...args) as unknown as ReturnType<typeof globalThis.setInterval>;
    polls.push(handler as () => void);
    return 0 as unknown as ReturnType<typeof globalThis.setInterval>;
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });

function diagnostics(lights: boolean): RenderDiagnostics {
  return {
    cpuMs: 1.25, gpuMs: null, gpuStatus: "pending", width: 640, height: 360, shadowDrawCalls: 0,
    readbackMs: null, autoLod: { meshes: 0, reduced: 0 }, qualityLimits: [],
    shadowLights: lights ? [{ name: "Sun", illumination: "included", status: "active", mapSize: 1024, passes: 1 }] : [],
  } as unknown as RenderDiagnostics;
}

/** `testMode` mirrors a test build: the e2e data attributes only exist and update there. */
async function openPlay(onRender?: () => void, testMode = true) {
  window.history.replaceState(null, "", testMode ? "/?test=1" : "/");
  const state = { lights: false, guids: ["actor-a"], ys: [1], passes: 0, materials: [] as string[] };
  const renderDiagnostics = vi.fn(() => diagnostics(state.lights));
  const testHooks = {
    postProcessPassCount: vi.fn(() => state.passes),
    assignedMaterialGuids: vi.fn(() => [...state.materials]),
    spawnedActorGuids: vi.fn(() => [...state.guids]),
    lastActorPositions: vi.fn(() => state.ys.map((y) => ({ slotId: 0, x: 0, y, z: 0 }))),
  };
  vi.mocked(startPlaySession).mockReturnValue({
    handle: {
      resize() {}, setSize() {}, scheduler: { setResizing() {} },
      renderDiagnostics,
      lightsDebugEnabled: () => state.lights,
      postProcessPassCount: testHooks.postProcessPassCount,
      assignedMaterialGuids: testHooks.assignedMaterialGuids,
      isFreeCamEnabled: () => false,
      accountedGeometryBytes: () => 0,
    },
    lastMoveX: () => null,
    spawnedActorGuids: testHooks.spawnedActorGuids,
    lastActorPositions: testHooks.lastActorPositions,
    accountedBytes: () => 0,
    liveObjectCounts: () => ({ meshes: 0, textures: 0 }),
    drawCalls: () => 0,
    bridgeMessagesPerSec: () => 0,
    executeConsoleCommand: () => Promise.resolve({ success: true, output: "" }),
    stop: () => ({}),
  } as unknown as PlaySession);
  const overlay = <PlayOverlay sharedEngine={{} as Engine} onClose={() => {}} />;
  render(onRender ? <Profiler id="play" onRender={onRender}>{overlay}</Profiler> : overlay);
  await act(async () => {});
  return { state, renderDiagnostics, testHooks, callbacks: vi.mocked(startPlaySession).mock.lastCall![0] };
}

const poll = () => act(() => { polls[0]!(); });

it("reads rendering diagnostics only for the Stats HUD, while keeping the other poll outputs live", async () => {
  const { state, renderDiagnostics, callbacks } = await openPlay();
  state.guids = ["actor-a", "actor-b"];
  state.ys = [1, 2];
  state.passes = 2;
  state.materials = ["mat-1", "mat-2"];
  await poll();
  expect(renderDiagnostics).not.toHaveBeenCalled();
  const overlay = screen.getByTestId("play-overlay");
  expect(overlay.dataset.postProcessPasses).toBe("2");
  expect(overlay.dataset.assignedMaterials).toBe("mat-1,mat-2");
  expect(screen.getByTestId("play-actor-guids").dataset.guids).toBe("actor-a,actor-b");
  expect(screen.getByTestId("play-actor-y").dataset.ys).toBe("1,2");

  act(() => callbacks.onStatHighlight?.("draws", true));
  await poll();
  expect(renderDiagnostics).toHaveBeenCalled();
  expect(screen.getByTestId("stats-hud").textContent).toContain("1.25 ms");

  fireEvent.click(screen.getByTestId("play-stats-toggle"));
  renderDiagnostics.mockClear();
  await poll();
  expect(renderDiagnostics).not.toHaveBeenCalled();
});

it("shows the lights overlay while lights debug is on, with Stats closed, and drops it when it turns off", async () => {
  const { state, renderDiagnostics } = await openPlay();
  expect(screen.queryByTestId("lights-debug-overlay")).toBeNull();
  state.lights = true;
  await poll();
  expect(screen.getByTestId("lights-debug-overlay").textContent).toContain("Sun");

  state.lights = false;
  renderDiagnostics.mockClear();
  await poll();
  expect(screen.queryByTestId("lights-debug-overlay")).toBeNull();
  expect(renderDiagnostics).not.toHaveBeenCalled();
});

it("leaves the e2e data attributes out and skips their reads outside a test build", async () => {
  const { state, testHooks } = await openPlay(undefined, false);
  state.guids = ["actor-a", "actor-b"];
  state.passes = 2;
  await poll();
  const overlay = screen.getByTestId("play-overlay");
  expect(overlay.dataset.postProcessPasses).toBeUndefined();
  expect(overlay.dataset.assignedMaterials).toBeUndefined();
  expect(screen.queryByTestId("play-move-x")).toBeNull();
  expect(screen.queryByTestId("play-actor-guids")).toBeNull();
  expect(screen.queryByTestId("play-actor-y")).toBeNull();
  for (const read of Object.values(testHooks)) expect(read).not.toHaveBeenCalled();
});

it("updates the Stats HUD state only while it is visible, yet keeps the FeatureTest FPS probe current", async () => {
  const onRender = vi.fn();
  const { callbacks } = await openPlay(onRender, false);
  const stats = (fps: number) => ({ fps, scriptMs: 1, physicsMs: 2, publishMs: 3, frameId: 1 });
  onRender.mockClear();
  act(() => callbacks.onStats?.(stats(58)));
  expect(onRender).not.toHaveBeenCalled();
  expect(playProbes.get(PLAY_PROBE_KEY)?.runtimeFps()).toBe(58);

  act(() => callbacks.onStatHighlight?.("draws", true));
  act(() => callbacks.onStats?.(stats(61)));
  expect(screen.getByTestId("play-fps").dataset.fps).toBe("61");
  expect(playProbes.get(PLAY_PROBE_KEY)?.runtimeFps()).toBe(61);
});

it("does not re-render the overlay when a poll finds nothing new", async () => {
  const onRender = vi.fn();
  await openPlay(onRender);
  await poll();
  onRender.mockClear();
  await poll();
  await poll();
  expect(onRender).not.toHaveBeenCalled();
});

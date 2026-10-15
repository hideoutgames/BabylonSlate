import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { Engine } from "@babylonjs/core";
import { createBtStateObservers, type BtStateObservers } from "../lib/bt-state-observers";
import { startPlaySession, type PlaySession } from "../services/play-session";
import { PlayOverlay } from "./play-overlay";

vi.mock("../services/play-session", () => ({ startPlaySession: vi.fn() }));
// Stable: a new callback each render would restart the session effect.
const { reportBtState } = vi.hoisted(() => ({ reportBtState: vi.fn() }));
vi.mock("../context/play-context", () => ({
  usePlay: () => ({ reportBtState }),
}));
vi.mock("../context/app-settings-context", () => ({
  useAppSettings: () => ({ settings: {} }),
}));
vi.mock("@babylonslate/vfs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@babylonslate/vfs")>()),
  createAppSettingsStore: () => ({ load: () => new Promise(() => {}) }),
}));
vi.mock("../services/lifecycle-pause", () => ({ attachLifecyclePause: () => () => {} }));

beforeEach(() => {
  reportBtState.mockClear();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const setInterval = window.setInterval.bind(window);
  vi.spyOn(window, "setInterval").mockImplementation((handler, delay, ...args) =>
    (delay === 200 ? 0 : setInterval(handler, delay, ...args)) as unknown as ReturnType<typeof globalThis.setInterval>);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function openPlay(observers: BtStateObservers) {
  const setBehaviourTreeStateObserved = vi.fn();
  vi.mocked(startPlaySession).mockReturnValue({
    handle: { resize() {}, setSize() {}, scheduler: { setResizing() {} } },
    executeConsoleCommand: () => Promise.resolve({ success: true, output: "" }),
    setBehaviourTreeStateObserved,
    stop: () => ({
      diagnostics: [], droppedDiagnostics: 0, textureCountBefore: 0,
      released: Promise.resolve({ textureCountAfter: 0, textureLeak: false, quarantined: false }),
      runtimeMode: "worker", lastTrace: null,
    }),
  } as unknown as PlaySession);
  render(<PlayOverlay sharedEngine={{} as Engine} btStateObservers={observers} onClose={() => {}} />);
  await act(async () => {});
  return setBehaviourTreeStateObserved;
}

it("asks the runtime for behaviour tree state as Play starts when a Behaviour Tree editor is already open", async () => {
  const observers = createBtStateObservers();
  observers.observe();
  const setObserved = await openPlay(observers);
  expect(setObserved).toHaveBeenCalledExactlyOnceWith(true);
});

it("leaves the runtime's behaviour tree state off until an editor opens, and off again when the last one closes", async () => {
  const observers = createBtStateObservers();
  const setObserved = await openPlay(observers);
  expect(setObserved).not.toHaveBeenCalled();

  const releaseGraph = observers.observe();
  const releaseBlackboard = observers.observe();
  releaseGraph();
  expect(setObserved.mock.calls).toEqual([[true]]);
  expect(reportBtState).not.toHaveBeenCalled();

  // The stale state is dropped so a reopened editor does not flash it before fresh state arrives.
  releaseBlackboard();
  expect(setObserved.mock.calls).toEqual([[true], [false]]);
  expect(reportBtState).toHaveBeenCalledExactlyOnceWith(null);
});

it("stops following the editors once Play is closed", async () => {
  const observers = createBtStateObservers();
  const setObserved = await openPlay(observers);
  cleanup();
  await act(async () => {});
  observers.observe();
  expect(setObserved).not.toHaveBeenCalled();
});

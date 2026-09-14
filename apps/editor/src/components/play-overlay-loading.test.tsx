import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Engine } from "@babylonjs/core";
import { startPlaySession, type PlaySession, type PlaySessionResult } from "../services/play-session";
import { PlayOverlay } from "./play-overlay";

vi.mock("../services/play-session", () => ({ startPlaySession: vi.fn() }));
vi.mock("../context/play-context", () => ({
  usePlay: () => ({ reportBtState: reportBtState }),
}));
const { reportBtState } = vi.hoisted(() => ({ reportBtState: () => {} }));
vi.mock("../context/app-settings-context", () => ({
  useAppSettings: () => ({ settings: {} }),
}));
vi.mock("@babylonslate/vfs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@babylonslate/vfs")>()),
  // Keep persistent settings I/O outside the startup/failure UI contract.
  createAppSettingsStore: () => ({ load: () => new Promise(() => {}) }),
}));
vi.mock("../services/lifecycle-pause", () => ({ attachLifecyclePause: () => () => {} }));

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  // HUD polling is unrelated to the boot callback boundary exercised here.
  const setInterval = window.setInterval.bind(window);
  vi.spyOn(window, "setInterval").mockImplementation((handler, delay, ...args) =>
    delay === 200 ? 0 : setInterval(handler, delay, ...args));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function openPendingPlay() {
  const result: PlaySessionResult = {
    diagnostics: [], droppedDiagnostics: 0, textureCountBefore: 0,
    textureCountAfter: 0, textureLeak: false, runtimeMode: "worker", lastTrace: null,
  };
  const stop = vi.fn(() => result);
  vi.mocked(startPlaySession).mockReturnValue({
    handle: { resize() {}, setSize() {}, scheduler: { setResizing() {} } },
    executeConsoleCommand: () => Promise.resolve({ success: true, output: "" }),
    stop,
  } as unknown as PlaySession);
  const onClose = vi.fn();
  function Host() {
    const [closed, setClosed] = useState(false);
    return closed ? null : <PlayOverlay sharedEngine={{} as Engine} onClose={(value) => {
      onClose(value);
      setClosed(true);
    }} />;
  }
  render(<Host />);
  return { stop, result, onClose, callbacks: vi.mocked(startPlaySession).mock.lastCall![0] };
}

it("blocks from mount through the initial worker handshake and presentation", async () => {
  const { callbacks } = openPendingPlay();
  expect(screen.getByRole("dialog").textContent).toContain("Preparing Scene");
  act(() => callbacks.onSceneLoading?.({ sceneAssetGuid: "scene", sceneLoadId: 1,
    progress: 90, phase: "Presenting First Frame" }));
  expect(screen.getByRole("dialog").textContent).toContain("Presenting First Frame");
  act(() => callbacks.onSceneLoading?.(null));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it.each(["Stop", "failure"] as const)("closes pending startup on %s before the worker sends a scene token", async (action) => {
  const { callbacks, stop, result, onClose } = openPendingPlay();
  const dialog = screen.getByRole("dialog");
  if (action === "Stop") fireEvent.click(within(dialog).getByRole("button", { name: "Stop" }));
  else act(() => callbacks.onFatalDiagnostic?.());
  await waitFor(() => expect(screen.queryByTestId("play-overlay")).toBeNull());
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(stop).toHaveBeenCalledOnce();
  expect(onClose).toHaveBeenCalledExactlyOnceWith(result);
});

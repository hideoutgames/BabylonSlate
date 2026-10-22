import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Engine } from "@babylonjs/core";
import { GameSessionOwner } from "../services/game-session-owner";
import { startPlaySession, type PlaySession, type PlaySessionResult } from "../services/play-session";
import { PlayOverlay } from "./play-overlay";

vi.mock("../services/play-session", () => ({ startPlaySession: vi.fn() }));
vi.mock("../context/play-context", () => ({
  usePlay: () => ({}),
}));
// Stable: a new callback each render would restart the session effect.
vi.mock("../context/app-settings-context", () => ({
  useAppSettings: () => ({ settings: {} }),
}));
vi.mock("@haptic/vfs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@haptic/vfs")>()),
  createAppSettingsStore: () => ({ load: () => new Promise(() => {}) }),
}));
vi.mock("../services/lifecycle-pause", () => ({ attachLifecyclePause: () => () => {} }));

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const setInterval = window.setInterval.bind(window);
  vi.spyOn(window, "setInterval").mockImplementation((handler, delay, ...args) =>
    (delay === 200 ? 0 : setInterval(handler, delay, ...args)) as unknown as ReturnType<typeof globalThis.setInterval>);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("keeps Escape releasing Simulation game input after a failed release", async () => {
  const result: PlaySessionResult = {
    diagnostics: [], droppedDiagnostics: 0, textureCountBefore: 0,
    released: Promise.resolve({ textureCountAfter: 0, textureLeak: false, quarantined: false }),
    runtimeMode: "worker", lastTrace: null,
  };
  const setInputMode = vi.fn<PlaySession["setInputMode"]>()
    .mockRejectedValueOnce(new Error("Game input could not be reset"))
    .mockResolvedValue(undefined);
  vi.mocked(startPlaySession).mockReturnValue({
    handle: { resize() {}, setSize() {}, scheduler: { setResizing() {} } },
    executeConsoleCommand: () => Promise.resolve({ success: true, output: "" }),
    setInputMode,
    requestPausedRedraw() {},
    stop: () => result,
  } as unknown as PlaySession);
  const owner = new GameSessionOwner<PlaySessionResult>();
  const ticket = owner.begin("simulate")!;
  render(<PlayOverlay sharedEngine={{} as Engine} sessionOwner={owner} sessionTicket={ticket} onClose={() => {}} />);
  await act(async () => {});
  act(() => vi.mocked(startPlaySession).mock.lastCall![0].onSceneLoading?.(null));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  await act(async () => { fireEvent.keyDown(document, { key: "Escape" }); });
  expect(screen.getByRole("alert").textContent).toContain("Game input could not be reset");
  // The session is still in Game Input, so Escape must retry the release.
  await act(async () => { fireEvent.keyDown(document, { key: "Escape" }); });
  expect(setInputMode.mock.calls).toEqual([["edit"], ["edit"]]);
  expect(screen.queryByRole("alert")).toBeNull();
});

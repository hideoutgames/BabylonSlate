import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Engine } from "@babylonjs/core";
import { startPlaySession, type PlaySession } from "../services/play-session";
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
  createAppSettingsStore: () => ({ load: () => new Promise(() => {}) }),
}));
vi.mock("../services/lifecycle-pause", () => ({ attachLifecyclePause: () => () => {} }));

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  // HUD polling is unrelated to the log feed exercised here.
  const setInterval = window.setInterval.bind(window);
  vi.spyOn(window, "setInterval").mockImplementation((handler, delay, ...args) =>
    delay === 200 ? 0 : setInterval(handler, delay, ...args));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function openPlay() {
  vi.mocked(startPlaySession).mockReturnValue({
    handle: { resize() {}, setSize() {}, scheduler: { setResizing() {} } },
    executeConsoleCommand: () => Promise.resolve({ success: true, output: "" }),
    inspectWorld: () => Promise.resolve({ tickIndex: 0, nodes: [] }),
    stop: () => ({}),
  } as unknown as PlaySession);
  render(<PlayOverlay sharedEngine={{} as Engine} onClose={() => {}} />);
  await act(async () => {});
  const callbacks = vi.mocked(startPlaySession).mock.lastCall![0];
  act(() => callbacks.onSceneLoading?.(null));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  return callbacks;
}

it("shows a burst of Play prints in arrival order, keeping the newest 500", async () => {
  const callbacks = await openPlay();
  act(() => {
    for (let index = 0; index < 600; index += 1) {
      callbacks.onPrint?.({ message: `line ${index}`, key: "status", duration: 1, color: "#ffffff" });
    }
  });
  await waitFor(() =>
    expect(
      Array.from(screen.getByTestId("play-log-tail").children, (line) => line.textContent),
    ).toEqual(["line 595", "line 596", "line 597", "line 598", "line 599"]),
  );
  fireEvent.click(screen.getByTestId("play-console-open"));
  const transcript = await screen.findByTestId("debug-console-transcript");
  const rows = transcript.querySelectorAll('[data-testid^="debug-console-log-"]');
  expect(Array.from(rows, (row) => row.textContent)).toEqual(
    Array.from({ length: 500 }, (_, index) => `[print] line ${index + 100}`),
  );
});

it("shows a one-frame print on screen as soon as it arrives", async () => {
  const callbacks = await openPlay();
  act(() => callbacks.onPrint?.({ message: "flash", key: "", duration: 0, color: "#ffffff" }));
  expect(screen.getByTestId("print-overlay").textContent).toContain("flash");
});

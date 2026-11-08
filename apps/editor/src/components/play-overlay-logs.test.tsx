import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Profiler } from "react";
import type { Engine } from "@babylonjs/core";
import { statsHudModel } from "@haptic/debugger";
import { startPlaySession, type PlaySession } from "../services/play-session";
import { PlayOverlay } from "./play-overlay";

vi.mock("../services/play-session", () => ({ startPlaySession: vi.fn() }));
vi.mock("../context/play-context", () => ({
  usePlay: () => {
    // The overlay root is the only caller in its tree, so this counts its renders.
    renders.overlay += 1;
    return { appendLog: appendLog };
  },
}));
const { appendLog, renders } = vi.hoisted(() => ({ appendLog: vi.fn(), renders: { overlay: 0, commits: 0 } }));
// Counts the Stats HUD's renders: it builds its model once per render.
vi.mock("@haptic/debugger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@haptic/debugger")>();
  return { ...actual, statsHudModel: vi.fn(actual.statsHudModel) };
});
vi.mock("../context/app-settings-context", () => ({
  useAppSettings: () => ({ settings: {} }),
}));
vi.mock("@haptic/vfs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@haptic/vfs")>()),
  createAppSettingsStore: () => ({ load: () => new Promise(() => {}) }),
}));
vi.mock("@haptic/render/lifecycle-pause", () => ({ attachLifecyclePause: () => () => {} }));

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  // HUD polling is unrelated to the log feed exercised here.
  const setInterval = window.setInterval.bind(window);
  vi.spyOn(window, "setInterval").mockImplementation((handler, delay, ...args) =>
    (delay === 200 ? 0 : setInterval(handler, delay, ...args)) as unknown as ReturnType<typeof globalThis.setInterval>);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function openPlay() {
  vi.mocked(startPlaySession).mockReturnValue({
    handle: { resize() {}, setSize() {}, scheduler: { setResizing() {} } },
    executeConsoleCommand: () => Promise.resolve({ success: true, output: "" }),
    inspectWorld: () => Promise.resolve({ tickIndex: 0, nodes: [] }),
    stop: () => ({}),
  } as unknown as PlaySession);
  render(
    <Profiler id="play-overlay" onRender={() => { renders.commits += 1; }}>
      <PlayOverlay sharedEngine={{} as Engine} onClose={() => {}} />
    </Profiler>,
  );
  await act(async () => {});
  const callbacks = vi.mocked(startPlaySession).mock.lastCall![0];
  act(() => callbacks.onSceneLoading?.(null));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  return callbacks;
}

it("keeps a burst of Play prints in the Debug Console in arrival order, keeping the newest 500", async () => {
  const callbacks = await openPlay();
  act(() => {
    for (let index = 0; index < 600; index += 1) {
      callbacks.onPrint?.({ message: `line ${index}`, key: "status", duration: 1, color: "#ffffff" });
    }
  });
  fireEvent.click(screen.getByTestId("play-console-open"));
  const transcript = await screen.findByTestId("debug-console-transcript");
  await waitFor(() => {
    const rows = transcript.querySelectorAll('[data-testid^="debug-console-log-"]');
    expect(Array.from(rows, (row) => row.textContent)).toEqual(
      Array.from({ length: 500 }, (_, index) => `[print] line ${index + 100}`),
    );
  });
});

it("prints nothing in the bottom-left of the Play view", async () => {
  const callbacks = await openPlay();
  act(() => {
    callbacks.onLog?.("Audio clip missing", "warning");
    callbacks.onPrint?.({ message: "hello", key: "", duration: 1, color: "#ffffff" });
  });
  await waitFor(() => expect(screen.getByTestId("print-overlay").textContent).toContain("hello"));
  expect(screen.queryByTestId("play-log-tail")).toBeNull();
});

it("shows a one-frame print on screen as soon as it arrives", async () => {
  const callbacks = await openPlay();
  act(() => callbacks.onPrint?.({ message: "flash", key: "", duration: 0, color: "#ffffff" }));
  expect(screen.getByTestId("print-overlay").textContent).toContain("flash");
});

it("sends runtime logs to the Output Log with their category and severity", async () => {
  const callbacks = await openPlay();
  appendLog.mockClear();
  act(() => callbacks.onRuntimeLog?.({ category: "Fuel", severity: "warning", message: "Low" }));
  expect(appendLog).toHaveBeenCalledExactlyOnceWith("[Fuel] Warning: Low");
});

it("puts Play warnings and errors in the Debug Console, not on the Play view", async () => {
  const callbacks = await openPlay();
  act(() => callbacks.onLog?.("Audio clip missing", "warning"));
  fireEvent.click(screen.getByTestId("play-console-open"));
  const transcript = await screen.findByTestId("debug-console-transcript");
  await waitFor(() => expect(transcript.textContent).toContain("Audio clip missing"));
  expect(screen.queryByTestId("play-log-tail")).toBeNull();
});

it("keeps a logging game from re-rendering the Play overlay, and its closed Debug Console, until the console opens", async () => {
  const callbacks = await openPlay();
  await act(async () => {});
  const before = { ...renders };
  act(() => {
    for (let index = 0; index < 50; index += 1) callbacks.onLog?.(`line ${index}`, "info");
  });
  // Lines reach the console a frame later; the hidden-tab fallback flushes within 250 ms.
  await act(() => new Promise((resolve) => setTimeout(resolve, 300)));
  expect(renders.commits).toBe(before.commits);
  expect(renders.overlay).toBe(before.overlay);

  fireEvent.click(screen.getByTestId("play-console-open"));
  const transcript = await screen.findByTestId("debug-console-transcript");
  const logRows = () =>
    Array.from(transcript.querySelectorAll('[data-testid^="debug-console-log-"]'), (row) => row.textContent);
  expect(logRows()).toEqual(Array.from({ length: 50 }, (_, index) => `[info] line ${index}`));

  // While it is open, new lines re-render the console alone.
  const open = renders.overlay;
  act(() => callbacks.onLog?.("after opening", "warning"));
  await waitFor(() => expect(logRows().at(-1)).toBe("[warning] after opening"));
  expect(renders.overlay).toBe(open);
});

it("skips the hidden Stats HUD when the overlay renders for its own state", async () => {
  await openPlay();
  await act(async () => {});
  const overlayRenders = renders.overlay;
  const hudRenders = vi.mocked(statsHudModel).mock.calls.length;
  fireEvent.click(screen.getByTestId("play-console-open"));
  await screen.findByTestId("debug-console-transcript");
  expect(renders.overlay).toBeGreaterThan(overlayRenders);
  expect(vi.mocked(statsHudModel).mock.calls.length).toBe(hudRenders);
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useLayoutEffect } from "react";
import type { Engine } from "@babylonjs/core";
import type { CommandMessage } from "@babylonslate/bridge";
import { GraphDebugProvider, useGraphDebugStore } from "../context/graph-debug-context";
import type { GraphDebugStore } from "../services/graph-debug-store";
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

const DOOR = { kind: "class", classId: "Door" } as const;
type Roster = Extract<CommandMessage, { type: "debugRoster" }>;
type Trace = Extract<CommandMessage, { type: "executionTrace" }>;

let store: GraphDebugStore | null = null;
/** The editor has a Class graph focused before the session starts. */
function FocusedClass() {
  const current = useGraphDebugStore();
  store = current;
  useLayoutEffect(() => { current?.setTarget(DOOR); }, [current]);
  return null;
}

async function openSession(mode: "simulate" | "play") {
  const observeGraphDebug = vi.fn();
  vi.mocked(startPlaySession).mockReturnValue({
    handle: { resize() {}, setSize() {}, scheduler: { setResizing() {} } },
    executeConsoleCommand: () => Promise.resolve({ success: true, output: "" }),
    setBehaviourTreeStateObserved() {},
    observeGraphDebug,
    stop: () => ({
      diagnostics: [], droppedDiagnostics: 0, textureCountBefore: 0,
      released: Promise.resolve({ textureCountAfter: 0, textureLeak: false, quarantined: false }),
      runtimeMode: "worker", lastTrace: null,
    }),
  } as unknown as PlaySession);
  render(
    <GraphDebugProvider>
      <FocusedClass />
      <PlayOverlay sharedEngine={{} as Engine} sessionTicket={{ mode } as never} onClose={() => {}} />
    </GraphDebugProvider>,
  );
  await act(async () => {});
  const options = vi.mocked(startPlaySession).mock.calls.at(-1)![0] as unknown as {
    onDebugRoster?: (roster: Roster) => void;
    onExecutionTrace?: (trace: Trace) => void;
  };
  return { observeGraphDebug, options };
}

const roster = (ids: string[], reset = true, removed: string[] = []): Roster => ({
  type: "debugRoster", target: DOOR, reset, removed,
  added: ids.map((id) => ({ id, kind: "actor", label: id })),
});

describe("Simulation graph debugging in the Play overlay", () => {
  it("asks the runtime to watch the focused Class as the Simulation starts, then to follow the first instance listed", async () => {
    const { observeGraphDebug, options } = await openSession("simulate");
    expect(observeGraphDebug).toHaveBeenCalledExactlyOnceWith(DOOR, null);

    act(() => options.onDebugRoster!(roster(["d1", "d2"])));
    expect(observeGraphDebug).toHaveBeenLastCalledWith(DOOR, "d1");

    // The followed instance despawns: the next one is followed.
    act(() => options.onDebugRoster!(roster([], false, ["d1"])));
    expect(observeGraphDebug).toHaveBeenLastCalledWith(DOOR, "d2");
  });

  it("hands the followed instance's trace to the store", async () => {
    const { options } = await openSession("simulate");
    act(() => options.onDebugRoster!(roster(["d1"])));
    const seen: number[] = [];
    store!.subscribeTrace((trace) => seen.push(trace.tickIndex));
    const graphs = [{ assetGuid: "Door.class", graphId: "event-graph", nodes: ["a"], edges: [], values: [["a", "p", "in", "7"] as [string, string, "in", string]] }];
    act(() => options.onExecutionTrace!({ type: "executionTrace", target: DOOR, instanceId: "d1", tickIndex: 9, graphs }));
    expect(seen).toEqual([9]);
    expect(store!.value("Door.class", "event-graph", "a", "p", "in")).toBe("7");
  });

  it("stops asking, and forgets the target, once the Simulation closes", async () => {
    const { observeGraphDebug } = await openSession("simulate");
    cleanup();
    await act(async () => {});
    expect(observeGraphDebug).toHaveBeenCalledTimes(1);
    expect(store!.getSnapshot().target).toBeNull();
  });

  it("leaves fullscreen Play alone", async () => {
    const { observeGraphDebug, options } = await openSession("play");
    expect(options.onDebugRoster).toBeUndefined();
    expect(options.onExecutionTrace).toBeUndefined();
    expect(observeGraphDebug).not.toHaveBeenCalled();
  });
});

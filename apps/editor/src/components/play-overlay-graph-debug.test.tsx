import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useLayoutEffect } from "react";
import type { Engine } from "@babylonjs/core";
import type { CommandMessage, DebugObserveTarget } from "@haptic/bridge";
import { GraphDebugProvider, useGraphDebugStore } from "../context/graph-debug-context";
import type { GraphDebugStore } from "../services/graph-debug-store";
import { startPlaySession, type PlaySession } from "../services/play-session";
import { PlayOverlay } from "./play-overlay";

vi.mock("../services/play-session", () => ({ startPlaySession: vi.fn() }));
// Stable: a new callback each render would restart the session effect.
const play = vi.hoisted(() => ({}));
vi.mock("../context/play-context", () => ({
  usePlay: () => play,
}));
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

const DOOR = { kind: "class", classId: "Door" } as const;
const GUARD = { kind: "behaviourTree", assetGuid: "guard" } as const;
type Roster = Extract<CommandMessage, { type: "debugRoster" }>;
type Trace = Extract<CommandMessage, { type: "executionTrace" }>;
type BtState = Extract<CommandMessage, { type: "btState" }>;

let store: GraphDebugStore | null = null;
/** The editor has a graph focused before the session starts. */
function Focused({ target }: { target: DebugObserveTarget }) {
  const current = useGraphDebugStore();
  store = current;
  useLayoutEffect(() => { current?.setTarget(target); }, [current, target]);
  return null;
}

async function openSession(mode: "simulate" | "play", target: DebugObserveTarget = DOOR) {
  const observeGraphDebug = vi.fn();
  vi.mocked(startPlaySession).mockReturnValue({
    handle: { resize() {}, setSize() {}, scheduler: { setResizing() {} } },
    executeConsoleCommand: () => Promise.resolve({ success: true, output: "" }),
    observeGraphDebug,
    setPauseReason: async (_reason: string, paused: boolean) => ({ success: true, paused, pauseReasons: paused ? ["user"] : [] }),
    requestPausedRedraw() {},
    stop: () => ({
      diagnostics: [], droppedDiagnostics: 0, textureCountBefore: 0,
      released: Promise.resolve({ textureCountAfter: 0, textureLeak: false, quarantined: false }),
      runtimeMode: "worker", lastTrace: null,
    }),
  } as unknown as PlaySession);
  render(
    <GraphDebugProvider>
      <Focused target={target} />
      <PlayOverlay sharedEngine={{} as Engine} sessionTicket={{ mode } as never} onClose={() => {}} />
    </GraphDebugProvider>,
  );
  await act(async () => {});
  const options = vi.mocked(startPlaySession).mock.calls.at(-1)![0] as unknown as {
    onSessionPaused?: (paused: boolean, cause?: { code: string; message: string; assetGuid?: string; nodeId?: string }) => void;
    onDebugRoster?: (roster: Roster) => void;
    onExecutionTrace?: (trace: Trace) => void;
    onBtState?: (state: BtState) => void;
  };
  return { observeGraphDebug, options };
}

const roster = (ids: string[], reset = true, removed: string[] = []): Roster => ({
  type: "debugRoster", target: DOOR, reset, removed,
  added: ids.map((id) => ({ id, kind: "actor", label: id })),
});

describe("Graph debugging in the Play overlay", () => {
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

  it("hands a followed Behaviour Tree's state to the store", async () => {
    const { observeGraphDebug, options } = await openSession("simulate", GUARD);
    expect(observeGraphDebug).toHaveBeenCalledExactlyOnceWith(GUARD, null);
    act(() => options.onDebugRoster!({ ...roster(["bt-1"]), target: GUARD }));
    expect(observeGraphDebug).toHaveBeenLastCalledWith(GUARD, "bt-1");
    act(() => options.onBtState!({
      type: "btState", instanceId: "bt-1", slotId: 0, status: "running", btNodeId: "wait",
      lastResults: {}, blackboard: { hp: 3 }, stack: [{ nodeId: "root", childIndex: 0, opened: true }],
    }));
    expect(store!.status("guard", "root")).toBe("running");
    expect(store!.blackboard("guard")).toEqual({ hp: 3 });
  });

  it("stops asking, and forgets the target, once the Simulation closes", async () => {
    const { observeGraphDebug } = await openSession("simulate");
    cleanup();
    await act(async () => {});
    expect(observeGraphDebug).toHaveBeenCalledTimes(1);
    expect(store!.getSnapshot().target).toBeNull();
  });

  it("watches nothing while Play runs behind its view, and the focused graph while Play is stopped", async () => {
    const { observeGraphDebug, options } = await openSession("play");
    expect(observeGraphDebug).not.toHaveBeenCalled();

    await act(async () => options.onSessionPaused!(true, { code: "runtime.breakpoint", message: "Breakpoint", assetGuid: "Door.class", nodeId: "open" }));
    expect(observeGraphDebug).toHaveBeenCalledExactlyOnceWith(DOOR, null);
    act(() => options.onDebugRoster!(roster(["d1"])));
    expect(observeGraphDebug).toHaveBeenLastCalledWith(DOOR, "d1");

    // Back in the game, the runtime stops watching.
    await act(async () => options.onSessionPaused!(false));
    expect(observeGraphDebug).toHaveBeenLastCalledWith(null, null);
  });
});

import { useSyncExternalStore } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { DebugInspectSnapshot } from "@babylonslate/object-model";
import { INSPECT_REQUEST_TIMEOUT_MS, useInspectWorldPoll } from "./use-inspect-world-poll";

function Probe({
  open,
  inspectWorld,
  onOwnerRender,
}: {
  open: boolean;
  inspectWorld: () => Promise<DebugInspectSnapshot>;
  onOwnerRender?: () => void;
}) {
  const store = useInspectWorldPoll(open, inspectWorld);
  onOwnerRender?.();
  return <Tick store={store} />;
}

function Tick({ store }: { store: ReturnType<typeof useInspectWorldPoll> }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return (
    <div data-testid="inspect-tick" data-tick={String(snapshot.tickIndex)}>
      {snapshot.tickIndex}
    </div>
  );
}

describe("useInspectWorldPoll", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("polls inspectWorld at 5 Hz only while the inspector is open", async () => {
    vi.useFakeTimers();
    let tick = 0;
    const inspectWorld = vi.fn(async () => {
      tick += 1;
      return { tickIndex: tick, nodes: [] };
    });

    const { rerender } = render(
      <Probe open={false} inspectWorld={inspectWorld} />,
    );
    expect(inspectWorld).not.toHaveBeenCalled();

    rerender(<Probe open inspectWorld={inspectWorld} />);
    await act(async () => {
      await Promise.resolve();
    });
    const callsAfterOpen = inspectWorld.mock.calls.length;
    expect(callsAfterOpen).toBeGreaterThanOrEqual(1);
    const tickAfterOpen = Number(
      screen.getByTestId("inspect-tick").getAttribute("data-tick"),
    );
    expect(tickAfterOpen).toBeGreaterThan(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(inspectWorld.mock.calls.length).toBeGreaterThan(callsAfterOpen);
    expect(
      Number(screen.getByTestId("inspect-tick").getAttribute("data-tick")),
    ).toBeGreaterThan(tickAfterOpen);

    rerender(<Probe open={false} inspectWorld={inspectWorld} />);
    const callsAfterClose = inspectWorld.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(inspectWorld.mock.calls.length).toBe(callsAfterClose);
  });

  it("does not start another inspectWorld until the previous pull finishes", async () => {
    vi.useFakeTimers();
    let resolvePull: ((snapshot: DebugInspectSnapshot) => void) | undefined;
    const inspectWorld = vi.fn(
      () =>
        new Promise<DebugInspectSnapshot>((resolve) => {
          resolvePull = resolve;
        }),
    );

    render(<Probe open inspectWorld={inspectWorld} />);
    expect(inspectWorld).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(inspectWorld).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvePull?.({ tickIndex: 1, nodes: [] });
      await Promise.resolve();
    });
    expect(Number(screen.getByTestId("inspect-tick").getAttribute("data-tick"))).toBe(
      1,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(inspectWorld).toHaveBeenCalledTimes(2);
  });

  it("asks again once an inspect has gone unanswered too long, and ignores its late answer", async () => {
    vi.useFakeTimers();
    const answers: Array<(snapshot: DebugInspectSnapshot) => void> = [];
    const inspectWorld = vi.fn(
      () =>
        new Promise<DebugInspectSnapshot>((resolve) => {
          answers.push(resolve);
        }),
    );

    render(<Probe open inspectWorld={inspectWorld} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INSPECT_REQUEST_TIMEOUT_MS - 400);
    });
    // Still waiting on the first request.
    expect(inspectWorld).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(inspectWorld).toHaveBeenCalledTimes(2);

    // The abandoned request answering late must not overwrite anything.
    await act(async () => {
      answers[0]!({ tickIndex: 99, nodes: [] });
      await Promise.resolve();
    });
    expect(screen.getByTestId("inspect-tick").getAttribute("data-tick")).toBe("0");

    await act(async () => {
      answers[1]!({ tickIndex: 5, nodes: [] });
      await Promise.resolve();
    });
    expect(screen.getByTestId("inspect-tick").getAttribute("data-tick")).toBe("5");
  });

  it("keeps the last snapshot and polls again after a rejected inspect", async () => {
    vi.useFakeTimers();
    const inspectWorld = vi.fn<() => Promise<DebugInspectSnapshot>>()
      .mockResolvedValueOnce({ tickIndex: 4, nodes: [] })
      .mockRejectedValueOnce(new Error("Play session stopped"))
      .mockResolvedValue({ tickIndex: 6, nodes: [] });

    render(<Probe open inspectWorld={inspectWorld} />);
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(inspectWorld).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("inspect-tick").getAttribute("data-tick")).toBe("4");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(screen.getByTestId("inspect-tick").getAttribute("data-tick")).toBe("6");
  });

  it("does not re-render the component that polls, whatever the snapshots", async () => {
    vi.useFakeTimers();
    let tick = 0;
    const inspectWorld = async () => ({ tickIndex: ++tick, nodes: [] });
    const ownerRender = vi.fn();

    render(<Probe open inspectWorld={inspectWorld} onOwnerRender={ownerRender} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(tick).toBeGreaterThanOrEqual(5);
    expect(Number(screen.getByTestId("inspect-tick").getAttribute("data-tick"))).toBe(tick);
    expect(ownerRender).toHaveBeenCalledTimes(1);
  });

  it("re-renders a reader only when a snapshot's content differs from the one it shows", async () => {
    vi.useFakeTimers();
    const renders = vi.fn();
    function Reader({ store }: { store: ReturnType<typeof useInspectWorldPoll> }) {
      const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
      renders(snapshot.tickIndex);
      return null;
    }
    function Host({ inspectWorld }: { inspectWorld: () => Promise<DebugInspectSnapshot> }) {
      const store = useInspectWorldPoll(true, inspectWorld);
      return <Reader store={store} />;
    }
    // A paused world answers every poll with an equal, freshly built snapshot.
    const inspectWorld = vi.fn(async (): Promise<DebugInspectSnapshot> => ({
      tickIndex: 7,
      nodes: [
        { id: "hero", kind: "actor", label: "Hero", classId: "Actor", parentId: null, variables: { health: 10 } },
      ],
    }));

    render(<Host inspectWorld={inspectWorld} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(inspectWorld.mock.calls.length).toBeGreaterThanOrEqual(5);
    // Once with the empty initial snapshot, once for the first real one.
    expect(renders.mock.calls).toEqual([[0], [7]]);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { DebugInspectSnapshot } from "@babylonslate/object-model";
import { useInspectWorldPoll } from "./use-inspect-world-poll";

function Probe({
  open,
  inspectWorld,
}: {
  open: boolean;
  inspectWorld: () => Promise<DebugInspectSnapshot>;
}) {
  const snapshot = useInspectWorldPoll(open, inspectWorld);
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

    await vi.advanceTimersByTimeAsync(200);
    await act(async () => {
      await Promise.resolve();
    });
    expect(inspectWorld.mock.calls.length).toBeGreaterThan(callsAfterOpen);
    expect(
      Number(screen.getByTestId("inspect-tick").getAttribute("data-tick")),
    ).toBeGreaterThan(tickAfterOpen);

    rerender(<Probe open={false} inspectWorld={inspectWorld} />);
    const callsAfterClose = inspectWorld.mock.calls.length;
    await vi.advanceTimersByTimeAsync(400);
    expect(inspectWorld.mock.calls.length).toBe(callsAfterClose);
  });
});

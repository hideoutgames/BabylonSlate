import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AnimationEventPayload } from "@haptic/assets";
import { AnimationPreviewClock } from "../lib/animation-preview-clock";
import { AnimationEventTimeline } from "./animation-timeline";
import { moveAnimationEvents } from "../lib/animation-event-timeline";
import { AnimEventFlashes } from "./anim-event-flashes";
import { useClockEventFlashes, useFiredEventFlashes } from "../lib/anim-event-flashes";

vi.mock("../context/document-context", async () =>
  (await import("../testing/document-context-mock")).documentContextMock(() => ({})),
);

afterEach(cleanup);

const event = (id: string, timeMs: number, durationMs = 0, name = id): AnimationEventPayload => ({
  id,
  name,
  timeMs,
  durationMs,
  triggerWeight: 0.5,
  action: null,
});

describe("moveAnimationEvents", () => {
  const events = [event("step", 200), event("hit", 400, 200)];
  const key = (rowId: string, keyId: string) => ({ rowId, keyId });

  it.each([
    ["a single event", [key("events", "step")], 100, { step: [300, 0], hit: [400, 200] }],
    ["a whole window, both ends selected", [key("window:hit", "hit:begin"), key("window:hit", "hit:end")], 100, { step: [200, 0], hit: [500, 200] }],
    ["a window's begin alone, its end staying", [key("window:hit", "hit:begin")], -100, { step: [200, 0], hit: [300, 300] }],
    ["a window's end alone, changing its Duration", [key("window:hit", "hit:end")], 150, { step: [200, 0], hit: [400, 350] }],
    ["a single event no earlier than the start", [key("events", "step")], -500, { step: [0, 0], hit: [400, 200] }],
    ["a whole window no later than the end", [key("window:hit", "hit:begin"), key("window:hit", "hit:end")], 900, { step: [200, 0], hit: [800, 200] }],
  ])("moves %s", (_label, keys, delta, expected) => {
    const moved = moveAnimationEvents(events, keys, delta, 1000);
    expect(Object.fromEntries(moved.map((entry) => [entry.id, [entry.timeMs, entry.durationMs]]))).toEqual(expected);
  });
});

describe("AnimationEventTimeline", () => {
  const animation = { clipName: "Swing", modelGuid: "m", skeletonGuid: "rig", durationMs: 1000, events: [event("step", 200, 0, "Footstep")] };

  it("adds an event, or a window, at the Preview's playhead and selects it", () => {
    const clock = new AnimationPreviewClock(1000);
    clock.seek(300);
    const onChange = vi.fn();
    const onSelectEvents = vi.fn();
    render(<AnimationEventTimeline animation={animation} clock={clock} selectedEventIds={new Set()} onSelectEvents={onSelectEvents} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("animation-timeline-add-event"));
    expect(onChange.mock.calls.at(-1)![0].at(-1)).toMatchObject({ id: "event-2", name: "Event", timeMs: 300, durationMs: 0 });
    expect([...onSelectEvents.mock.calls.at(-1)![0]]).toEqual(["event-2"]);
    fireEvent.click(screen.getByTestId("animation-timeline-add-window"));
    expect(onChange.mock.calls.at(-1)![0].at(-1)).toMatchObject({ name: "Window", timeMs: 300, durationMs: 200 });
  });

  it("draws single events on the Events row and each window on a row of its own", () => {
    const clock = new AnimationPreviewClock(1000);
    render(
      <AnimationEventTimeline
        animation={{ ...animation, events: [event("step", 200, 0, "Footstep"), event("hit", 400, 200, "Hit")] }}
        clock={clock}
        selectedEventIds={new Set()}
        onSelectEvents={() => {}}
        onChange={() => {}}
      />,
    );
    expect(screen.getByTestId("animation-timeline-events")).toBeTruthy();
    expect(screen.getByTestId("animation-timeline-window-hit")).toBeTruthy();
  });
});

function ClockFlashes({ clock, events }: { clock: AnimationPreviewClock; events: AnimationEventPayload[] }) {
  return <AnimEventFlashes flashes={useClockEventFlashes(clock, events, 1000)} data-testid="flashes" />;
}

function SessionFlashes({ session }: { session: { subscribe: (listener: () => void) => () => void; events: () => never[] | undefined } }) {
  return <AnimEventFlashes flashes={useFiredEventFlashes(session.subscribe, session.events)} data-testid="flashes" />;
}

describe("Preview event flashes", () => {
  const names = () => screen.queryAllByTestId("flashes-name").map((entry) => entry.textContent);

  it("flashes an Animation's events as the Preview plays past them, the wrap included, and nothing on a seek", () => {
    vi.useFakeTimers();
    const clock = new AnimationPreviewClock(1000);
    render(<ClockFlashes clock={clock} events={[event("step", 250, 0, "Footstep"), event("hit", 900, 200, "Hit")]} />);
    // The Preview advances a frame at a time.
    const play = (ms: number) => {
      for (let left = ms; left > 0; left -= 50) act(() => clock.advance(Math.min(50, left)));
    };
    play(300);
    expect(names()).toEqual(["Footstep"]);
    play(650);
    expect(names()).toEqual(["Footstep", "Hit Begin"]);
    // Round the end: Hit's window ends at the end of the pass.
    play(100);
    expect(names()).toEqual(["Footstep", "Hit Begin", "Hit End"]);
    act(() => vi.advanceTimersByTime(2000));
    expect(names()).toEqual([]);
    // Restart jumps back to the start without crossing the rest of the pass.
    play(800);
    act(() => vi.advanceTimersByTime(2000));
    act(() => clock.restart());
    expect(names()).toEqual([]);
    act(() => clock.seek(240));
    act(() => clock.seek(260));
    expect(names()).toEqual([]);
    vi.useRealTimers();
  });

  it("flashes the events an evaluation fired once, with Begin and End for a window", () => {
    const listeners = new Set<() => void>();
    const fired: { current?: unknown[] } = {};
    const session = {
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      events: () => fired.current as never[] | undefined,
    };
    render(<SessionFlashes session={session} />);
    fired.current = [{ name: "Footstep", phase: "event" }, { name: "Hit", phase: "begin" }];
    act(() => listeners.forEach((listener) => listener()));
    // The same evaluation published again flashes nothing more.
    act(() => listeners.forEach((listener) => listener()));
    expect(names()).toEqual(["Footstep", "Hit Begin"]);
  });
});

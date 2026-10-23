import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import type { TracePayload } from "@haptic/debugger";
import {
  TraceLogPanel,
  TracePlaybackProvider,
  TraceSnapshotPanel,
  TraceTimelinePanel,
} from "./trace-editor";
import { dispatchPointerEvent } from "../../../../packages/editor-kit/src/test-support/pointer-events";

const traceDocument = vi.hoisted(() => ({
  id: "trace:traces/session.htrace",
  content: null as unknown,
}));

vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({ openDocuments: [traceDocument] })));

const panelProps = {} as IDockviewPanelProps;

function TraceDocument() {
  return (
    <TracePlaybackProvider documentId={traceDocument.id}>
      <TraceTimelinePanel {...panelProps} />
      <TraceSnapshotPanel {...panelProps} />
      <TraceLogPanel {...panelProps} />
    </TracePlaybackProvider>
  );
}

function renderTrace(payload: TracePayload) {
  traceDocument.content = payload;
  const result = render(<TraceDocument />);
  return {
    ...result,
    rerenderTrace(next: TracePayload) {
      traceDocument.content = next;
      result.rerender(<TraceDocument />);
    },
  };
}

const actor = (guid: string, health: number) => ({
  guid,
  classId: "PlayerCharacter",
  spawnIndex: 0,
  transform: { position: [1, 2, 3], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
  variables: {
    name: guid,
    health,
    samples: [1, 2, 3, 4, 5, 6],
    target: null,
    enabled: false,
  },
  components: [],
});
const payload: TracePayload = {
  seed: 7,
  dt: 1 / 60,
  retention: { byteBudget: 64 * 1024, droppedFrames: 0, complete: true, stopReason: "requested" },
  frames: [
    {
      tickIndex: 501,
      timeDilation: 1,
      scriptMs: 1,
      physicsMs: 0.5,
      logs: [
        { severity: "warn", category: "combat", message: "first warning" },
      ],
      prints: [{ message: "print-a", key: "health" }],
      snapshotText: JSON.stringify({
        tickIndex: 501,
        dt: 1 / 60,
        gameInstance: null,
        actors: [actor("player", 100), actor("removed", 10)],
      }),
    },
    {
      tickIndex: 502,
      timeDilation: 1,
      scriptMs: 12,
      physicsMs: 2,
      logs: [
        { severity: "error", category: "combat", message: "second error" },
      ],
      prints: [],
      snapshotText: JSON.stringify({
        tickIndex: 502,
        dt: 1 / 60,
        gameInstance: null,
        actors: [actor("added", 20), actor("player", 75)],
      }),
      inputEvents: [{ type: "key", code: "Space", down: true, tick: 502 }],
      bt: [
        {
          slotId: 2,
          status: "running",
          btNodeId: "chase",
          lastResults: {},
          blackboard: { target: "player" },
          stack: [],
          nodeMemory: {},
        },
      ],
    },
  ],
};

describe("Trace document panels", () => {
  afterEach(cleanup);

  it("summarizes incomplete and complete retention", () => {
    const { rerenderTrace } = renderTrace({
      ...payload,
      frames: [],
      retention: {
        byteBudget: 1024 * 1024,
        droppedFrames: 1,
        complete: false,
        stopReason: "oversized-frame",
      },
    });
    const summary = screen.getByTestId("trace-retention-summary");
    expect(summary.textContent).toContain("Incomplete");
    expect(summary.textContent).toContain("1 MiB Serialized Data Budget");
    expect(summary.textContent).toContain("1 Dropped Frame");
    expect(summary.textContent).toContain("Frame Exceeded Budget");
    rerenderTrace(payload);
    expect(summary.textContent).toBe(
      "Complete · 65536 B Serialized Data Budget · 0 Dropped Frames · Stopped By Request",
    );
  });

  it("expands and collapses the selected actor with the keyboard", () => {
    renderTrace(payload);
    const tree = screen.getByRole("tree", { name: "Snapshot" });
    fireEvent.keyDown(tree, { key: "Home" });
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    expect(
      within(tree)
        .getAllByRole("treeitem")
        .some((row) => row.textContent?.includes("Identity")),
    ).toBe(true);
    fireEvent.keyDown(tree, { key: "ArrowLeft" });
    expect(
      within(tree)
        .getAllByRole("treeitem")
        .some((row) => row.textContent?.includes("Identity")),
    ).toBe(false);
  });

  it("shows the recorded tick and rejects fractional frame selection", () => {
    renderTrace(payload);
    expect(screen.getByTestId("trace-frame-summary").textContent).toContain(
      "Tick 502",
    );
    expect(screen.getByTestId("trace-frame-summary").textContent).toContain(
      "14.00 ms",
    );
    fireEvent.change(screen.getByTestId("trace-playback-frame"), {
      target: { value: "0.5" },
    });
    fireEvent.blur(screen.getByTestId("trace-playback-frame"));
    expect(
      (screen.getByTestId("trace-playback-frame") as HTMLInputElement).value,
    ).toBe("1");
    fireEvent.click(
      screen.getByRole("button", { name: "Previous Frame" }),
    );
    expect(screen.getByTestId("trace-frame-summary").textContent).toContain(
      "Tick 501",
    );
  });

  it("searches nested values and preserves selection across reordered actors", () => {
    renderTrace(payload);
    fireEvent.change(screen.getByRole("textbox", { name: "Search Snapshot" }), {
      target: { value: "health" },
    });
    const tree = screen.getByRole("tree", { name: "Snapshot" });
    expect(tree.textContent).toContain("PlayerCharacter");
    const health = within(tree)
      .getAllByRole("treeitem")
      .find(
        (row) =>
          row.textContent?.includes("Health") && row.textContent.includes("75"),
      )!;
    const healthIndex = within(tree).getAllByRole("treeitem").indexOf(health);
    fireEvent.keyDown(tree, { key: "Home" });
    for (let i = 0; i < healthIndex; i++)
      fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(screen.getByTestId("trace-value-detail").textContent).toContain(
      "75",
    );
    fireEvent.click(screen.getByRole("button", { name: "Previous Frame" }));
    expect(screen.getByTestId("trace-value-detail").textContent).toContain(
      "100",
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Search Snapshot" }), {
      target: { value: "samples" },
    });
    expect(tree.textContent).toContain("6 Items");
    expect(tree.textContent).toContain("[5]");
  });

  it("compares actor identities and exposes additions, removals and changed values", () => {
    renderTrace(payload);
    fireEvent.click(
      screen.getByRole("button", { name: "Changes" }),
    );
    const changes = screen.getByTestId("trace-snapshot-changes");
    expect(changes.textContent).toContain("Added");
    expect(changes.textContent).toContain("Removed");
    expect(changes.textContent).toContain("Health");
    expect(changes.textContent).toContain("100");
    expect(changes.textContent).toContain("75");
    fireEvent.click(screen.getByRole("button", { name: "Previous Frame" }));
    expect(screen.getByText("No Previous Recorded Frame")).toBeTruthy();
  });

  it("filters changes by kind, path and the recorded before and after values", () => {
    renderTrace(payload);
    fireEvent.click(screen.getByRole("button", { name: "Changes" }));
    const search = screen.getByRole("textbox", { name: "Search Snapshot" });
    const changes = () => screen.getByTestId("trace-snapshot-changes").textContent ?? "";
    fireEvent.change(search, { target: { value: "removed" } });
    expect(changes()).toContain("Removed");
    expect(changes()).not.toContain("Added");
    expect(changes()).not.toContain("Health");
    fireEvent.change(search, { target: { value: " 75 " } });
    expect(changes()).toContain("Health");
    expect(changes()).not.toContain("Removed");
    fireEvent.change(search, { target: { value: "no such change" } });
    expect(screen.getByText("No Matching Changes")).toBeTruthy();
    fireEvent.change(search, { target: { value: "" } });
    expect(changes()).toContain("Added");
  });

  it("shows recorded inputs and behaviour trees even without a world snapshot", () => {
    renderTrace({
      ...payload,
      frames: [{ ...payload.frames[1]!, snapshotText: undefined }],
    });
    expect(screen.getByText("No Snapshot Recorded")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Search Snapshot" }), {
      target: { value: "Space" },
    });
    expect(
      screen.getByRole("tree", { name: "Snapshot" }).textContent,
    ).toContain("Space");
    fireEvent.change(screen.getByRole("textbox", { name: "Search Snapshot" }), {
      target: { value: "chase" },
    });
    expect(
      screen.getByRole("tree", { name: "Snapshot" }).textContent,
    ).toContain("chase");
  });

  it("retains legacy text and reports empty recordings", () => {
    const { rerenderTrace } = renderTrace({
      ...payload,
      frames: [{ ...payload.frames[0]!, snapshotText: "tick=501" }],
    });
    expect(screen.getByText("Snapshot Could Not Be Parsed")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Raw Snapshot" }),
    );
    expect(screen.getByTestId("trace-snapshot-raw").textContent).toBe(
      "tick=501",
    );
    rerenderTrace({ ...payload, frames: [] });
    expect(screen.getAllByText("No Recorded Frames").length).toBeGreaterThan(0);
    expect(
      screen
        .getByRole("button", { name: "Next Frame" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("filters log metadata, reveals full messages and navigates to their frame", () => {
    renderTrace(payload);
    expect(screen.getByTestId("trace-log-scope").textContent).toContain("30");
    fireEvent.change(screen.getByRole("textbox", { name: "Search Log" }), {
      target: { value: "warn" },
    });
    const log = screen.getByTestId("trace-playback-log");
    expect(log.textContent).toContain("first warning");
    expect(log.textContent).not.toContain("second error");
    fireEvent.click(within(log).getByRole("button"));
    expect(screen.getByTestId("trace-log-detail").textContent).toContain(
      "combat",
    );
    expect(screen.getByTestId("trace-frame-summary").textContent).toContain(
      "Tick 501",
    );
  });

  it("jumps between over-budget ticks and zooms around the selected frame", () => {
    const frames = Array.from({ length: 500 }, (_, i) => ({
      ...payload.frames[0]!,
      tickIndex: 1000 + i,
      scriptMs: i === 250 ? 50 : 1,
      logs: [],
      prints: [],
    }));
    renderTrace({ ...payload, frames });
    fireEvent.click(
      screen.getByRole("button", { name: "Previous Over Budget" }),
    );
    expect(screen.getByTestId("trace-frame-summary").textContent).toContain(
      "Tick 1250",
    );
    expect(screen.getByTestId("trace-frame-summary").textContent).toContain(
      "50.50 ms",
    );
    fireEvent.click(screen.getByRole("button", { name: "Zoom In" }));
    expect(screen.getByTestId("trace-visible-range").textContent).not.toContain(
      "0–499",
    );
    fireEvent.click(screen.getByRole("button", { name: "Show All Frames" }));
    expect(screen.getByTestId("trace-visible-range").textContent).toContain(
      "0–499",
    );
  });
});

describe("Trace timeline chart", () => {
  // 300 px over frames 0 and 1 (the axis runs from -0.5 to 1.5): frame 0 sits at x = 75, frame 1 at x = 225.
  // The Ticks track is the top 112 px; the markers row lies below it.
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 300, 130));
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("selects a tapped tick, names a hovered one and the events a frame recorded", () => {
    renderTrace(payload);
    const chart = screen.getByRole("group", { name: "Script And Physics Tick Times" });
    act(() => {
      dispatchPointerEvent(chart, "pointerdown", { clientX: 75, clientY: 20 });
      dispatchPointerEvent(chart, "pointerup", { clientX: 75, clientY: 20 });
    });
    expect(screen.getByTestId("trace-frame-summary").textContent).toContain("Tick 501");
    fireEvent.keyDown(chart, { key: "ArrowRight" });
    expect(screen.getByTestId("trace-frame-summary").textContent).toContain("Tick 502");
    act(() => dispatchPointerEvent(chart, "pointermove", { pointerType: "mouse", clientX: 225, clientY: 20 }));
    expect(screen.getByRole("tooltip").textContent).toBe(
      "Ticks · Frame 1 · Tick 502Script 12 msPhysics 2 msTotal 14 msOver Budget",
    );
    act(() => dispatchPointerEvent(chart, "pointermove", { pointerType: "mouse", clientX: 225, clientY: 120 }));
    expect(screen.getByRole("tooltip").textContent).toBe("1 Log · 1 InputFrame 1 · Tick 502");
  });
});

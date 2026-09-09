import { afterEach, describe, expect, it } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { TracePayload } from "@babylonslate/debugger";
import { TracePlayback } from "./trace-playback";

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
  frames: [
    {
      tickIndex: 501,
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

describe("TracePlayback", () => {
  afterEach(cleanup);

  it("expands and collapses the selected actor with the keyboard", () => {
    render(<TracePlayback payload={payload} />);
    const tree = screen.getByRole("tree", { name: "Snapshot" });
    fireEvent.keyDown(tree, { key: "Home" });
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    expect(
      within(tree)
        .getAllByRole("treeitem")
        .some((row) => row.textContent?.startsWith("Identity")),
    ).toBe(true);
    fireEvent.keyDown(tree, { key: "ArrowLeft" });
    expect(
      within(tree)
        .getAllByRole("treeitem")
        .some((row) => row.textContent?.startsWith("Identity")),
    ).toBe(false);
  });

  it("shows the recorded tick and rejects fractional frame selection", () => {
    render(<TracePlayback payload={payload} />);
    expect(screen.getByTestId("trace-frame-summary").textContent).toContain(
      "Tick 502",
    );
    expect(screen.getByTestId("trace-frame-summary").textContent).toContain(
      "14.00 ms",
    );
    expect(
      screen
        .getByTestId("trace-playback-graph-bar-1")
        .getAttribute("aria-current"),
    ).toBe("true");
    fireEvent.change(screen.getByTestId("trace-playback-frame"), {
      target: { value: "0.5" },
    });
    fireEvent.blur(screen.getByTestId("trace-playback-frame"));
    expect(
      (screen.getByTestId("trace-playback-frame") as HTMLInputElement).value,
    ).toBe("1");
    fireEvent.click(
      screen.getByRole("button", { name: "Previous Frame", exact: true }),
    );
    expect(screen.getByTestId("trace-frame-summary").textContent).toContain(
      "Tick 501",
    );
    expect(
      screen
        .getByTestId("trace-playback-graph-bar-0")
        .getAttribute("aria-current"),
    ).toBe("true");
  });

  it("searches nested values and preserves selection across reordered actors", () => {
    render(<TracePlayback payload={payload} />);
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
    fireEvent.click(screen.getByTestId("trace-playback-graph-bar-0"));
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
    render(<TracePlayback payload={payload} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Changes", exact: true }),
    );
    const changes = screen.getByTestId("trace-snapshot-changes");
    expect(changes.textContent).toContain("Added");
    expect(changes.textContent).toContain("Removed");
    expect(changes.textContent).toContain("Health");
    expect(changes.textContent).toContain("100");
    expect(changes.textContent).toContain("75");
    fireEvent.click(screen.getByTestId("trace-playback-graph-bar-0"));
    expect(screen.getByText("No Previous Recorded Frame")).toBeTruthy();
  });

  it("shows recorded inputs and behaviour trees even without a world snapshot", () => {
    render(
      <TracePlayback
        payload={{
          ...payload,
          frames: [{ ...payload.frames[1]!, snapshotText: undefined }],
        }}
      />,
    );
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
    const { rerender } = render(
      <TracePlayback
        payload={{
          ...payload,
          frames: [{ ...payload.frames[0]!, snapshotText: "tick=501" }],
        }}
      />,
    );
    expect(screen.getByText("Snapshot Could Not Be Parsed")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Raw Snapshot", exact: true }),
    );
    expect(screen.getByTestId("trace-snapshot-raw").textContent).toBe(
      "tick=501",
    );
    rerender(<TracePlayback payload={{ ...payload, frames: [] }} />);
    expect(screen.getAllByText("No Recorded Frames").length).toBeGreaterThan(0);
    expect(
      screen
        .getByRole("button", { name: "Next Frame", exact: true })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("filters log metadata, reveals full messages and navigates to their frame", () => {
    render(<TracePlayback payload={payload} />);
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

  it("bounds graph bars for long recordings and zooms to exact frames without clipping spikes", () => {
    const frames = Array.from({ length: 500 }, (_, i) => ({
      ...payload.frames[0]!,
      tickIndex: 1000 + i,
      scriptMs: i === 250 ? 50 : 1,
      logs: [],
      prints: [],
    }));
    render(<TracePlayback payload={{ ...payload, frames }} />);
    const graph = screen.getByTestId("trace-playback-graph");
    expect(within(graph).getAllByRole("button").length).toBeLessThanOrEqual(
      200,
    );
    expect(screen.getByTestId("trace-budget-line")).toBeTruthy();
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

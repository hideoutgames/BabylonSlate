import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { TIMELINE_CLIPS_META, createTimelineClip, timelineClipSummaries } from "@haptic/core";
import { takeTimelineClipFocus } from "../lib/timeline-clip-focus";
import { TimelineAssetClipsPanel, TimelineAssetEventsPanel } from "./timeline-asset-editor";

const harness = vi.hoisted(() => ({
  applyAssetDocumentChange: vi.fn(async () => true),
  openDocument: vi.fn(async () => {}),
  setActiveDocument: vi.fn(),
  setSceneMode: vi.fn(),
}));

const intro = {
  ...createTimelineClip("intro", "Intro"),
  length: 8,
  timelineAsset: "hall",
  eventTracks: [{ id: "e", name: "On Subtitle", inputs: [{ name: "Line", typeId: "string", direction: "in" as const }], keys: [] }],
};
const assets = [
  { path: "assets/Hall.timeline.hasset", header: { type: "Timeline", guid: "hall", name: "Hall" } },
  { path: "assets/Main.scene.hasset", header: { type: "Scene", guid: "main", name: "Main Scene", payload: { [TIMELINE_CLIPS_META]: timelineClipSummaries([intro]) } } },
];

vi.mock("../context/document-workspace-context", () => ({ useDocumentWorkspace: () => ({ documentId: "timeline:assets/Hall.timeline.hasset" }) }));
vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
  openDocuments: [{ id: "timeline:assets/Hall.timeline.hasset", ref: { kind: "timeline", path: "assets/Hall.timeline.hasset" }, content: { description: "Cutscenes" } }],
  assetRegistry: {
    list: () => assets,
    getByPath: (path: string) => assets.find((asset) => asset.path === path),
  } as never,
  applyAssetDocumentChange: harness.applyAssetDocumentChange,
  openDocument: harness.openDocument,
  setActiveDocument: harness.setActiveDocument,
  setSceneMode: harness.setSceneMode,
})));

const panel = {} as IDockviewPanelProps;
afterEach(cleanup);

describe("Timeline Asset document", () => {
  it("lists its clips with where each lives, and opens one in its Scene's Timeline mode", async () => {
    render(<TimelineAssetClipsPanel {...panel} />);
    const list = screen.getByTestId("timeline-asset-clips");
    expect(within(list).getByText("Intro")).toBeTruthy();
    expect(within(list).getByText("Main Scene")).toBeTruthy();
    expect(within(list).getByText("8.00 s")).toBeTruthy();
    fireEvent.click(screen.getByTestId("timeline-asset-open-intro"));
    await vi.waitFor(() => expect(harness.setSceneMode).toHaveBeenCalledWith("scene:assets/Main.scene.hasset", "timeline"));
    expect(harness.openDocument).toHaveBeenCalledWith(expect.objectContaining({ kind: "scene", path: "assets/Main.scene.hasset" }));
    expect(takeTimelineClipFocus("scene:assets/Main.scene.hasset")).toBe("intro");
  });

  it("edits its Description", () => {
    render(<TimelineAssetClipsPanel {...panel} />);
    const description = screen.getByLabelText("Description") as HTMLInputElement;
    expect(description.value).toBe("Cutscenes");
    description.focus();
    fireEvent.change(description, { target: { value: "Hall cutscenes" } });
    fireEvent.blur(description);
    expect(harness.applyAssetDocumentChange).toHaveBeenCalledWith("timeline:assets/Hall.timeline.hasset", { description: "Hall cutscenes" }, "timeline-asset:description");
  });

  it("shows the selected clip's events, Custom Event Tracks then the built-in ones", () => {
    render(<TimelineAssetEventsPanel {...panel} />);
    const events = screen.getByTestId("timeline-asset-events");
    expect(within(events).getByDisplayValue("Line: String")).toBeTruthy();
    expect(within(events).getAllByDisplayValue("Built in")).toHaveLength(2);
    expect(within(events).getByText("On Finished")).toBeTruthy();
  });
});

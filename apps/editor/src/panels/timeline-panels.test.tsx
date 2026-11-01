import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { createTimelineClip, type SerializedScene, type SerializedTimelineClip } from "@haptic/core";
import { KeybindProvider } from "../context/keybind-context";
import { TimelineClipsPanel, TimelinePanel } from "./timeline-panels";

if (typeof window !== "undefined" && typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {}
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

const harness = vi.hoisted(() => ({
  clips: [] as SerializedTimelineClip[],
  selected: null as string | null,
  setTimelineClipId: vi.fn((id: string | null) => { harness.selected = id; }),
  applySceneChange: vi.fn<(id: string, scene: SerializedScene) => Promise<boolean>>(async (_id, scene) => {
    harness.clips = scene.timelineClips ?? [];
    return true;
  }),
}));

const scene = () => ({ actors: [], settings: {}, ...(harness.clips.length ? { timelineClips: harness.clips } : {}) }) as unknown as SerializedScene;

vi.mock("../context/document-workspace-context", () => ({ useDocumentWorkspace: () => ({ documentId: "scene:main" }) }));
vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
  openDocuments: [{ id: "scene:main", ref: { kind: "scene" }, content: scene() }],
  applySceneChange: harness.applySceneChange,
})));
vi.mock("../context/scene-tools-context", () => ({
  useSceneTools: () => ({ timelineClipId: harness.selected, setTimelineClipId: harness.setTimelineClipId }),
}));

const panel = {} as IDockviewPanelProps;
const renderClips = () => render(<KeybindProvider><TimelineClipsPanel {...panel} /></KeybindProvider>);
const lastScene = () => harness.applySceneChange.mock.calls.at(-1)![1];
const openMenu = (name: string) => fireEvent.contextMenu(screen.getByRole("treeitem", { name: new RegExp(name) }));

afterEach(() => {
  cleanup();
  harness.clips = [];
  harness.selected = null;
  harness.applySceneChange.mockClear();
  harness.setTimelineClipId.mockClear();
});

describe("Clips", () => {
  it("creates the first clip from the empty state, selects it and starts renaming it", () => {
    renderClips();
    fireEvent.click(screen.getByRole("button", { name: "New Clip" }));
    const [clip] = lastScene().timelineClips!;
    expect(clip).toMatchObject({ name: "Timeline Clip", length: 5, frameRate: 30, objects: [], eventTracks: [] });
    expect(harness.setTimelineClipId).toHaveBeenCalledWith(clip!.id);
  });

  it("duplicates, copies and pastes, and deletes clips from the row menu", () => {
    harness.clips = [createTimelineClip("intro", "Intro")];
    const view = renderClips();
    openMenu("Intro");
    fireEvent.click(screen.getByTestId("timeline-clip-menu-duplicate"));
    expect(lastScene().timelineClips!.map((clip) => clip.name)).toEqual(["Intro", "Intro 2"]);

    view.rerender(<KeybindProvider><TimelineClipsPanel {...panel} /></KeybindProvider>);
    openMenu("Intro 2");
    fireEvent.click(screen.getByTestId("timeline-clip-menu-copy"));
    openMenu("Intro 2");
    fireEvent.click(screen.getByTestId("timeline-clip-menu-paste"));
    expect(lastScene().timelineClips!.map((clip) => clip.name)).toEqual(["Intro", "Intro 2", "Intro 3"]);

    view.rerender(<KeybindProvider><TimelineClipsPanel {...panel} /></KeybindProvider>);
    openMenu("Intro 3");
    fireEvent.click(screen.getByTestId("timeline-clip-menu-delete"));
    expect(lastScene().timelineClips!.map((clip) => clip.name)).toEqual(["Intro", "Intro 2"]);
  });

  it("renames a clip from the row menu", () => {
    harness.clips = [createTimelineClip("intro", "Intro")];
    renderClips();
    openMenu("Intro");
    fireEvent.click(screen.getByTestId("timeline-clip-menu-rename"));
    const input = screen.getByDisplayValue("Intro");
    fireEvent.change(input, { target: { value: "Opening" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(lastScene().timelineClips!.map((clip) => clip.name)).toEqual(["Opening"]);
  });
});

describe("Timeline", () => {
  it("names the selected clip, or says how to get one", () => {
    const view = render(<TimelinePanel {...panel} />);
    expect(screen.getByTestId("scene-timeline-title").textContent).toBe("No Timeline Clips");
    harness.clips = [createTimelineClip("intro", "Intro")];
    view.rerender(<TimelinePanel {...panel} />);
    expect(screen.getByTestId("scene-timeline-title").textContent).toBe("No Clip Selected");
    harness.selected = "intro";
    view.rerender(<TimelinePanel {...panel} />);
    expect(screen.getByTestId("scene-timeline-title").textContent).toBe("Intro");
  });
});

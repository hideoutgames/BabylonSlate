import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { createTimelineClip, type SerializedScene, type SerializedTimelineClip } from "@haptic/core";
import { AssetCreateProvider } from "@haptic/editor-kit";
import { TIMELINE_CLIPS_META, timelineClipSummaries } from "@haptic/core";
import { KeybindProvider } from "../context/keybind-context";
import { TimelineClipsPanel } from "./timeline-panels";

if (typeof window !== "undefined" && typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {}
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

const harness = vi.hoisted(() => ({
  assets: [] as Array<{ path: string; header: { type: string; guid: string; name: string; payload?: Record<string, unknown> } }>,
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
  openDocuments: [{ id: "scene:main", ref: { kind: "scene", path: "assets/Main.scene.hasset" }, content: scene() }],
  applySceneChange: harness.applySceneChange,
  assetRegistry: {
    list: () => harness.assets,
    getByGuid: (guid: string) => harness.assets.find((asset) => asset.header.guid === guid),
  } as never,
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
  harness.assets = [];
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

  it("binds a clip to a Timeline Asset, refusing one that holds its name, and unbinds it", () => {
    harness.clips = [createTimelineClip("intro", "Intro")];
    harness.assets = [
      { path: "assets/Hall.timeline.hasset", header: { type: "Timeline", guid: "hall", name: "Hall" } },
      { path: "assets/Lobby.timeline.hasset", header: { type: "Timeline", guid: "lobby", name: "Lobby" } },
      { path: "assets/Other.scene.hasset", header: { type: "Scene", guid: "other", name: "Other", payload: {
        [TIMELINE_CLIPS_META]: timelineClipSummaries([{ ...createTimelineClip("x", "Intro"), timelineAsset: "lobby" }]),
      } } },
    ];
    const view = renderClips();
    openMenu("Intro");
    fireEvent.click(screen.getByTestId("timeline-clip-menu-bind"));
    expect(screen.getByTestId("timeline-bind-asset-lobby").getAttribute("data-disabled")).toBe("true");
    expect(screen.getByText("Already holds a clip named Intro (Other).")).toBeTruthy();
    fireEvent.click(screen.getByText("Hall"));
    fireEvent.click(screen.getByTestId("timeline-bind-dialog-confirm"));
    expect(lastScene().timelineClips![0]!.timelineAsset).toBe("hall");

    view.rerender(<KeybindProvider><TimelineClipsPanel {...panel} /></KeybindProvider>);
    expect(screen.getByLabelText("Bound to a Timeline Asset")).toBeTruthy();
    openMenu("Intro");
    fireEvent.click(screen.getByTestId("timeline-clip-menu-unbind"));
    expect(lastScene().timelineClips![0]).not.toHaveProperty("timelineAsset");
  });

  it("creates a Timeline Asset beside the scene and binds the clip to it", async () => {
    harness.clips = [createTimelineClip("intro", "Intro")];
    const createAsset = vi.fn(async () => "new-guid");
    render(<AssetCreateProvider value={{ canCreate: () => true, typeLabel: (type) => type, createAsset }}>
      <KeybindProvider><TimelineClipsPanel {...panel} /></KeybindProvider>
    </AssetCreateProvider>);
    openMenu("Intro");
    fireEvent.click(screen.getByTestId("timeline-clip-menu-new-bind"));
    const name = screen.getByLabelText("Name") as HTMLInputElement;
    expect(name.value).toBe("Intro Timeline");
    fireEvent.change(name, { target: { value: "Hall" } });
    fireEvent.click(screen.getByRole("button", { name: "Create and Bind" }));
    await vi.waitFor(() => expect(lastScene().timelineClips![0]!.timelineAsset).toBe("new-guid"));
    expect(createAsset).toHaveBeenCalledWith({ type: "Timeline", name: "Hall", ownerPath: "assets/Main.scene.hasset" });
  });
});

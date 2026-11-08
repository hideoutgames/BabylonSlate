import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement, useEffect } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  createActor,
  createTimelineClip,
  type SerializedScene,
  type SerializedTimelineClip,
  type TimelineKey,
} from "@haptic/core";
import type { KeyframeTimelineProps, KeyframeTimelineTrackRow } from "@haptic/editor-kit";
import { KeybindProvider } from "../context/keybind-context";
import { SceneToolsProvider, useSceneTools } from "../context/scene-tools-context";
import { TimelinePanel } from "./timeline-panel";
import { timelinePropertyEntries } from "../lib/timeline-property-catalog";

if (typeof window !== "undefined" && typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {}
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

const key = (id: string, Time: number, Value: unknown): TimelineKey => ({ id, Time, Value, Interpolation: "linear", ArriveTangent: 0, LeaveTangent: 0 });

const harness = vi.hoisted(() => ({
  scene: null as unknown as SerializedScene,
  selectedActorIds: [] as string[],
  selectActor: vi.fn<(id: string) => void>(),
  applySceneChange: vi.fn<(id: string, scene: SerializedScene) => Promise<boolean>>(async (_id, scene) => {
    harness.scene = scene;
    return true;
  }),
}));

vi.mock("../context/document-workspace-context", () => ({ useDocumentWorkspace: () => ({ documentId: "scene:main" }) }));
// The open documents change only with the Scene, as the provider's do; the mock advances every kind's revision with them.
const openScene = vi.hoisted(() => ({ scene: null as unknown, documents: [] as unknown[] }));
vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
  get openDocuments() {
    if (openScene.scene !== harness.scene) {
      openScene.scene = harness.scene;
      openScene.documents = [{ id: "scene:main", ref: { kind: "scene" }, content: harness.scene }];
    }
    return openScene.documents;
  },
  applySceneChange: harness.applySceneChange,
})));
// Counted: building the row structure reads each object's property entries.
vi.mock("../lib/timeline-property-catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/timeline-property-catalog")>();
  return { ...actual, timelinePropertyEntries: vi.fn(actual.timelinePropertyEntries) };
});
// Counted: the ids of the track list rows that render. Each row the panel passes gets one stand-in, so a row the
// panel keeps between renders stays the same row for the track list; the track list reads a row's depth to render it.
const trackListRenders = vi.hoisted(() => new Set<string>());
vi.mock("@haptic/editor-kit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@haptic/editor-kit")>();
  const standIns = new WeakMap<KeyframeTimelineTrackRow, KeyframeTimelineTrackRow>();
  const counted = (row: KeyframeTimelineTrackRow) => {
    let standIn = standIns.get(row);
    if (!standIn) {
      standIn = Object.defineProperty({ ...row }, "depth", {
        get: () => {
          trackListRenders.add(row.id);
          return row.depth;
        },
      });
      standIns.set(row, standIn);
    }
    return standIn;
  };
  return {
    ...actual,
    KeyframeTimeline: (props: KeyframeTimelineProps) =>
      createElement(actual.KeyframeTimeline, { ...props, rows: props.rows.map(counted) }),
  };
});
vi.mock("../context/scene-editing-context", () => ({
  useOptionalSceneEditing: () => ({ selectedActorIds: harness.selectedActorIds, selectActor: harness.selectActor }),
}));

const panel = {} as IDockviewPanelProps;
const clipOf = (scene: SerializedScene) => scene.timelineClips![0]!;
const lastClip = () => clipOf(harness.applySceneChange.mock.calls.at(-1)![1]);

function SelectClip({ id }: { id: string | null }) {
  const { setTimelineClipId } = useSceneTools();
  useEffect(() => setTimelineClipId(id), [id, setTimelineClipId]);
  return null;
}

function renderPanel(clipId: string | null = "intro") {
  const tree = () => <KeybindProvider><SceneToolsProvider><SelectClip id={clipId} /><TimelinePanel {...panel} /></SceneToolsProvider></KeybindProvider>;
  const view = render(tree());
  return { ...view, refresh: () => view.rerender(tree()) };
}

function sceneWith(clip: SerializedTimelineClip | null): SerializedScene {
  const door = createActor("door", "Door");
  const lamp = { ...createActor("lamp", "Lamp"), components: [{ id: "light", classId: "LightComponent", properties: { intensity: 2 } }] };
  return { actors: [door, lamp], settings: {}, ...(clip ? { timelineClips: [clip] } : {}) } as unknown as SerializedScene;
}

const animated = (): SerializedTimelineClip => ({
  ...createTimelineClip("intro", "Intro"),
  length: 4,
  objects: [{ id: "o-door", actorId: "door", tracks: [
    { id: "t-loc", target: { kind: "transform", property: "location" }, valueType: "vec3",
      keys: [key("k0", 0, { x: 0, y: 0, z: 0 }), key("k2", 2, { x: 4, y: 0, z: 0 })] },
  ] }],
});

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(200);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  harness.applySceneChange.mockClear();
  harness.selectedActorIds = [];
});

describe("Timeline window", () => {
  it("says how to get a clip, and names the selected one", () => {
    harness.scene = sceneWith(null);
    const first = renderPanel(null);
    expect(screen.getByTestId("scene-timeline-title").textContent).toBe("No Timeline Clips");
    first.unmount();
    harness.scene = sceneWith(createTimelineClip("intro", "Intro"));
    const second = renderPanel(null);
    expect(screen.getByTestId("scene-timeline-title").textContent).toBe("No Clip Selected");
    second.unmount();
    renderPanel("intro");
    expect(screen.getByTestId("scene-timeline-title").textContent).toBe("Intro");
    expect(screen.getByTestId("scene-timeline-empty")).toBeTruthy();
  });

  it("adds the selected actors from the Track menu", async () => {
    harness.scene = sceneWith(createTimelineClip("intro", "Intro"));
    harness.selectedActorIds = ["lamp", "door"];
    renderPanel();
    fireEvent.click(screen.getByTestId("timeline-add-menu"));
    fireEvent.click(await screen.findByTestId("timeline-track-menu-selected"));
    expect(lastClip().objects.map((object) => object.actorId)).toEqual(["lamp", "door"]);
  });

  it("lists objects and tracks with the value at the playhead, and steps between keys", () => {
    harness.scene = sceneWith(animated());
    renderPanel();
    const door = screen.getByTestId("timeline-row-o-door");
    expect(door.textContent).toContain("Door");
    const location = screen.getByTestId("timeline-row-t-loc");
    expect(location.textContent).toContain("Location");
    expect(location.textContent).toContain("0, 0, 0");
    fireEvent.click(screen.getByTestId("timeline-next-key"));
    expect(screen.getByTestId("timeline-row-t-loc").textContent).toContain("4, 0, 0");
    expect((screen.getByLabelText("Playhead Time") as HTMLInputElement).value).toContain("2");
    fireEvent.click(screen.getByTestId("timeline-previous-key"));
    expect(screen.getByTestId("timeline-row-t-loc").textContent).toContain("0, 0, 0");
    fireEvent.click(screen.getByTestId("timeline-go-end"));
    expect(screen.getByTestId("timeline-row-t-loc").textContent).toContain("4, 0, 0");
  });

  it("moves the playhead without rebuilding the row structure", () => {
    harness.scene = sceneWith(animated());
    renderPanel();
    expect(screen.getByTestId("timeline-row-t-loc").textContent).toContain("0, 0, 0");
    const builds = vi.mocked(timelinePropertyEntries).mock.calls.length;
    expect(builds).toBeGreaterThan(0);
    fireEvent.click(screen.getByTestId("timeline-next-key"));
    fireEvent.click(screen.getByTestId("timeline-go-end"));
    fireEvent.click(screen.getByTestId("timeline-go-start"));
    expect(screen.getByTestId("timeline-row-t-loc").textContent).toContain("0, 0, 0");
    expect(vi.mocked(timelinePropertyEntries).mock.calls.length).toBe(builds);
    // A collapsed object is a new structure.
    fireEvent.click(within(screen.getByTestId("timeline-row-o-door")).getByRole("button", { name: "Collapse" }));
    expect(vi.mocked(timelinePropertyEntries).mock.calls.length).toBeGreaterThan(builds);
  });

  it("re-renders only the track rows whose shown value a playhead move changes", () => {
    const [door] = animated().objects;
    harness.scene = sceneWith({
      ...animated(),
      objects: [{ ...door!, tracks: [
        ...door!.tracks,
        { id: "t-vis", target: { kind: "visible", property: "visible" }, valueType: "bool", keys: [key("v0", 0, true)] },
      ] }],
    });
    renderPanel();
    const ruler = screen.getByTestId("keyframe-timeline-ruler");
    act(() => ruler.focus());
    // One frame on, off every key: neither track is keyed at the playhead from here.
    fireEvent.keyDown(ruler, { key: "ArrowRight" });
    expect(screen.getByTestId("timeline-row-t-loc").textContent).toContain("0.07, 0, 0");
    trackListRenders.clear();
    fireEvent.keyDown(ruler, { key: "ArrowRight" });
    // Location moved; Visible and the Door group show what they showed, so their rows do not render again.
    expect(screen.getByTestId("timeline-row-t-loc").textContent).toContain("0.13, 0, 0");
    expect(screen.getByTestId("timeline-row-t-vis").textContent).toContain("True");
    expect([...trackListRenders]).toEqual(["t-loc"]);
  });

  it("sets and removes the key on the playhead's frame from a track row", () => {
    harness.scene = sceneWith(animated());
    const view = renderPanel();
    fireEvent.click(screen.getByTestId("timeline-go-end"));
    fireEvent.click(screen.getByTestId("timeline-key-toggle-t-loc"));
    const keys = lastClip().objects[0]!.tracks[0]!.keys;
    expect(keys.map((entry) => [entry.Time, entry.Value])).toEqual([[0, { x: 0, y: 0, z: 0 }], [2, { x: 4, y: 0, z: 0 }], [4, { x: 4, y: 0, z: 0 }]]);
    view.refresh();
    fireEvent.click(screen.getByTestId("timeline-key-toggle-t-loc"));
    expect(lastClip().objects[0]!.tracks[0]!.keys.map((entry) => entry.Time)).toEqual([0, 2]);
  });

  it("keys the selected row's tracks with K at the playhead", () => {
    harness.scene = sceneWith(animated());
    renderPanel();
    fireEvent.click(screen.getByTestId("timeline-row-o-door"));
    act(() => screen.getByTestId("keyframe-timeline-ruler").focus());
    fireEvent.keyDown(screen.getByTestId("keyframe-timeline-ruler"), { key: "ArrowRight" });
    fireEvent.keyDown(screen.getByTestId("keyframe-timeline-ruler"), { key: "k", code: "KeyK" });
    const keys = lastClip().objects[0]!.tracks[0]!.keys;
    expect(keys).toHaveLength(3);
    expect(keys[1]!.Time).toBeCloseTo(1 / 30);
    expect((keys[1]!.Value as { x: number }).x).toBeCloseTo(4 / 60);
  });

  it("adds tracks from the Add Track dialog, with properties the clip has checked", async () => {
    harness.scene = sceneWith({ ...animated(), objects: [...animated().objects, { id: "o-lamp", actorId: "lamp", tracks: [] }] });
    renderPanel();
    fireEvent.click(screen.getByTestId("timeline-add-track-o-door"));
    const dialog = await screen.findByTestId("timeline-add-track-dialog");
    expect(within(dialog).getByText("Add Track to Door")).toBeTruthy();
    expect(within(dialog).getByTestId("timeline-add-track-item-transform::location").getAttribute("data-included")).toBe("true");
    fireEvent.click(within(dialog).getByText("Add Tracks"));
    expect(harness.applySceneChange).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByText("Visible"));
    fireEvent.click(within(dialog).getByText("Scale"));
    expect(within(dialog).getByText("2 selected")).toBeTruthy();
    fireEvent.click(within(dialog).getByText("Add Tracks"));
    expect(lastClip().objects[0]!.tracks.map((track) => track.target.property)).toEqual(["location", "scale", "visible"]);
  });

  it("offers a Light's live properties for a component track", async () => {
    harness.scene = sceneWith({ ...createTimelineClip("intro", "Intro"), objects: [{ id: "o-lamp", actorId: "lamp", tracks: [] }] });
    renderPanel();
    fireEvent.click(screen.getByTestId("timeline-add-track-o-lamp"));
    const dialog = await screen.findByTestId("timeline-add-track-dialog");
    fireEvent.change(within(dialog).getByLabelText("Search Properties"), { target: { value: "inten" } });
    fireEvent.click(within(dialog).getByText("Intensity"));
    fireEvent.click(within(dialog).getByText("Add Tracks"));
    const [track] = lastClip().objects[0]!.tracks;
    expect(track).toMatchObject({ target: { kind: "component", componentId: "light", property: "intensity" }, valueType: "float", keys: [] });
  });

  it("adds a Custom Event Track from the Track menu and keys it at the playhead", async () => {
    harness.scene = sceneWith(animated());
    const view = renderPanel();
    fireEvent.click(screen.getByTestId("timeline-add-menu"));
    fireEvent.click(await screen.findByTestId("timeline-track-menu-event"));
    const track = lastClip().eventTracks[0]!;
    expect(track).toMatchObject({ name: "On Event", inputs: [], keys: [] });
    view.refresh();
    expect(screen.getByTestId("timeline-row-timeline:events").textContent).toContain("Events");
    expect(screen.getByTestId(`timeline-row-${track.id}`).textContent).toContain("On Event");
    fireEvent.click(screen.getByTestId("timeline-next-key"));
    fireEvent.click(screen.getByTestId(`timeline-key-toggle-${track.id}`));
    expect(lastClip().eventTracks[0]!.keys).toEqual([{ id: expect.any(String), time: 2, values: {} }]);
    view.refresh();
    fireEvent.click(screen.getByTestId(`timeline-key-toggle-${track.id}`));
    expect(lastClip().eventTracks[0]!.keys).toEqual([]);
  });

  it("deletes and reorders event tracks from their row menu", () => {
    harness.scene = sceneWith({ ...animated(), eventTracks: [
      { id: "e1", name: "On Open", inputs: [], keys: [{ id: "a", time: 1, values: {} }] },
      { id: "e2", name: "On Close", inputs: [], keys: [] },
    ] });
    const view = renderPanel();
    fireEvent.contextMenu(screen.getByTestId("timeline-row-e2"));
    fireEvent.click(screen.getByTestId("timeline-row-menu-up"));
    expect(lastClip().eventTracks.map((track) => track.id)).toEqual(["e2", "e1"]);
    view.refresh();
    fireEvent.contextMenu(screen.getByTestId("timeline-row-e1"));
    fireEvent.click(screen.getByTestId("timeline-row-menu-delete"));
    expect(lastClip().eventTracks.map((track) => track.id)).toEqual(["e2"]);
  });

  it("mutes and deletes tracks from the row menu", () => {
    harness.scene = sceneWith(animated());
    const view = renderPanel();
    fireEvent.contextMenu(screen.getByTestId("timeline-row-t-loc"));
    fireEvent.click(screen.getByTestId("timeline-row-menu-mute"));
    expect(lastClip().objects[0]!.tracks[0]!.muted).toBe(true);
    view.refresh();
    fireEvent.contextMenu(screen.getByTestId("timeline-row-t-loc"));
    fireEvent.click(screen.getByTestId("timeline-row-menu-delete"));
    expect(lastClip().objects[0]!.tracks).toEqual([]);
  });

  it("adds actors from the Actor From Outliner dialog, with the clip's actors checked", async () => {
    harness.scene = sceneWith(animated());
    renderPanel();
    fireEvent.click(screen.getByTestId("timeline-add-menu"));
    fireEvent.click(await screen.findByTestId("timeline-track-menu-actor"));
    const dialog = await screen.findByTestId("timeline-pick-actor");
    expect(within(dialog).getByTestId("timeline-pick-actor-door").getAttribute("data-included")).toBe("true");
    fireEvent.click(within(dialog).getByText("Lamp"));
    fireEvent.click(within(dialog).getByText("Add Actors"));
    expect(lastClip().objects.map((object) => object.actorId)).toEqual(["door", "lamp"]);
  });

  it("adds the selected actors with Shift+A while the window is shown", () => {
    harness.scene = sceneWith(animated());
    harness.selectedActorIds = ["lamp"];
    renderPanel();
    fireEvent.keyDown(document.body, { key: "A", code: "KeyA", shiftKey: true });
    expect(lastClip().objects.map((object) => object.actorId)).toEqual(["door", "lamp"]);
  });

  it("acts on a right-clicked key from its menu", async () => {
    harness.scene = sceneWith(animated());
    renderPanel();
    // 400 px lanes show the 4 s clip between gutters of 10 and 24 px; the Location row is the second.
    const lanes = screen.getByTestId("keyframe-timeline-lanes");
    vi.spyOn(lanes, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 400, 72));
    fireEvent.contextMenu(lanes, { clientX: 10 + 2 * 91.5, clientY: 36 });
    expect(await screen.findByTestId("timeline-key-menu-interpolation")).toBeTruthy();
    fireEvent.click(screen.getByTestId("timeline-key-menu-go"));
    expect(screen.getByTestId("timeline-row-t-loc").textContent).toContain("4, 0, 0");

    fireEvent.contextMenu(lanes, { clientX: 10 + 2 * 91.5, clientY: 36 });
    fireEvent.click(await screen.findByTestId("timeline-key-menu-delete"));
    expect(lastClip().objects[0]!.tracks[0]!.keys.map((entry) => entry.id)).toEqual(["k0"]);
  });

  it("selects a row's keys and moves rows from the row menu", () => {
    harness.scene = sceneWith({
      ...animated(),
      objects: [...animated().objects, { id: "o-lamp", actorId: "lamp", tracks: [] }],
    });
    const view = renderPanel();
    fireEvent.contextMenu(screen.getByTestId("timeline-row-o-door"));
    fireEvent.click(screen.getByTestId("timeline-row-menu-select-keys"));
    const lanes = screen.getByTestId("keyframe-timeline-lanes");
    act(() => lanes.focus());
    fireEvent.keyDown(lanes, { key: "Delete", code: "Delete" });
    expect(lastClip().objects[0]!.tracks[0]!.keys).toEqual([]);

    view.refresh();
    fireEvent.contextMenu(screen.getByTestId("timeline-row-o-door"));
    fireEvent.click(screen.getByTestId("timeline-row-menu-down"));
    expect(lastClip().objects.map((object) => object.id)).toEqual(["o-lamp", "o-door"]);
  });

  it("selects a row's actor in the viewport and Outliner from the row menu", () => {
    harness.scene = sceneWith(animated());
    harness.selectActor.mockClear();
    renderPanel();
    fireEvent.contextMenu(screen.getByTestId("timeline-row-t-loc"));
    const item = screen.getByTestId("timeline-row-menu-reveal");
    expect(item.textContent).toContain("Select in Viewport and Outliner");
    fireEvent.click(item);
    expect(harness.selectActor).toHaveBeenCalledWith("door");
  });

  it("keys an unkeyed change from the amber key button, and moving the playhead discards one", () => {
    harness.scene = sceneWith(animated());
    let tools: ReturnType<typeof useSceneTools> | null = null;
    function Probe() {
      tools = useSceneTools();
      return null;
    }
    const view = render(<KeybindProvider><SceneToolsProvider><SelectClip id="intro" /><Probe /><TimelinePanel {...panel} /></SceneToolsProvider></KeybindProvider>);
    act(() => tools!.setTimelineUnkeyed(new Map([["t-loc", { x: 9, y: 0, z: 0 }]])));
    const button = screen.getByTestId("timeline-key-toggle-t-loc");
    expect(button.getAttribute("data-unkeyed")).toBe("true");
    expect(button.getAttribute("aria-label")).toBe("Key Change on Location");
    fireEvent.click(button);
    expect(lastClip().objects[0]!.tracks[0]!.keys.find((entry) => entry.Time === 0)!.Value).toEqual({ x: 9, y: 0, z: 0 });
    expect(tools!.timelineUnkeyed.size).toBe(0);

    act(() => tools!.setTimelineUnkeyed(new Map([["t-loc", { x: 7, y: 0, z: 0 }]])));
    fireEvent.click(screen.getByTestId("timeline-next-key"));
    expect(tools!.timelineUnkeyed.size).toBe(0);

    fireEvent.click(screen.getByTestId("timeline-auto-key"));
    expect(tools!.timelineAutoKey).toBe(true);
    view.unmount();
  });

  it("shows the selected track's curves in the Curves view", () => {
    harness.scene = sceneWith(animated());
    renderPanel();
    fireEvent.click(screen.getByTestId("timeline-view-curves"));
    const curves = screen.getByTestId("timeline-curves");
    expect(within(curves).getByText("Pick a track to edit its curves.")).toBeTruthy();
    expect(within(curves).getByText("Door › Location")).toBeTruthy();
    // The track selected in the Keys view shows its curves.
    fireEvent.click(screen.getByTestId("timeline-view-keys"));
    fireEvent.click(screen.getByTestId("timeline-row-t-loc"));
    fireEvent.click(screen.getByTestId("timeline-view-curves"));
    expect(screen.getByTestId("timeline-curve-key-0-x")).toBeTruthy();
    expect(screen.getByTestId("timeline-curve-key-1-x")).toBeTruthy();
    // The shared curve editor's ends are fixed for a clip.
    expect(screen.queryByTestId("timeline-curve-before")).toBeNull();
    fireEvent.click(screen.getByTestId("timeline-view-keys"));
    expect(screen.getByTestId("keyframe-timeline-lanes")).toBeTruthy();
  });
});


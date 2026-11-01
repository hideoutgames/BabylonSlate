import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useEffect } from "react";
import { createActor, createTimelineClip, type SerializedScene, type SerializedTimelineClip, type TimelineKey } from "@haptic/core";
import { keyRefId } from "@haptic/editor-kit";
import { SceneToolsProvider, useSceneTools } from "../context/scene-tools-context";
import { TimelineInspector } from "./timeline-inspector";

const key = (id: string, Time: number, Value: unknown): TimelineKey => ({ id, Time, Value, Interpolation: "linear", ArriveTangent: 0, LeaveTangent: 0 });

const harness = vi.hoisted(() => ({
  scene: null as unknown as SerializedScene,
  applySceneChange: vi.fn<(id: string, scene: SerializedScene) => Promise<boolean>>(async (_id, scene) => {
    harness.scene = scene;
    return true;
  }),
}));

vi.mock("../context/document-workspace-context", () => ({ useDocumentWorkspace: () => ({ documentId: "scene:main" }) }));
vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
  get openDocuments() {
    return [{ id: "scene:main", ref: { kind: "scene" }, content: harness.scene }];
  },
  applySceneChange: harness.applySceneChange,
})));

const clip = (): SerializedTimelineClip => ({
  ...createTimelineClip("intro", "Intro"),
  length: 4,
  objects: [{ id: "o-door", actorId: "door", tracks: [
    { id: "t-loc", target: { kind: "transform", property: "location" }, valueType: "vec3",
      keys: [key("k0", 0, { x: 0, y: 0, z: 0 }), key("k2", 2, { x: 4, y: 0, z: 0 })] },
    { id: "t-vis", target: { kind: "visible", property: "visible" }, valueType: "bool", keys: [key("v1", 1, false)] },
  ] }],
});
const lastClip = () => harness.applySceneChange.mock.calls.at(-1)![1].timelineClips![0]!;
function choose(name: string) {
  const option = screen.getByRole("option", { name });
  fireEvent.pointerDown(option);
  fireEvent.click(option);
}

interface Selection { keys?: Array<[string, string]>; row?: string | null; time?: number; unkeyed?: Array<[string, unknown]> }

function Select({ keys = [], row = null, time = 0, unkeyed = [] }: Selection) {
  const tools = useSceneTools();
  useEffect(() => {
    tools.setTimelineClipId("intro");
    tools.setTimelineKeySelection(new Set(keys.map(([rowId, keyId]) => keyRefId({ rowId, keyId }))));
    tools.setTimelineRowId(row);
    tools.timelinePlayhead.set(time);
    // After the playhead, which discards unkeyed changes.
    if (unkeyed.length) tools.setTimelineUnkeyed(new Map(unkeyed));
    // Once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

function renderInspector(selection: Selection = {}) {
  const withEvents = { ...clip(), eventTracks: [{
    id: "e-line", name: "On Line",
    inputs: [{ name: "Text", typeId: "string", direction: "in" as const }, { name: "Loud", typeId: "bool", direction: "in" as const }],
    keys: [{ id: "ek", time: 1, values: { Text: "Hello" } }],
  }] };
  harness.scene = { actors: [createActor("door", "Door")], settings: {}, timelineClips: [withEvents] } as unknown as SerializedScene;
  return render(<SceneToolsProvider><Select {...selection} /><TimelineInspector /></SceneToolsProvider>);
}

afterEach(() => {
  cleanup();
  harness.applySceneChange.mockClear();
});

describe("TimelineInspector", () => {
  it("edits the selected key's value, time and interpolation", () => {
    renderInspector({ keys: [["t-loc", "k2"]] });
    const grid = screen.getByTestId("timeline-inspector-key");
    expect(within(grid).getByDisplayValue("Door › Location")).toBeTruthy();
    expect(within(grid).getByText("Frame 60")).toBeTruthy();

    fireEvent.click(within(grid).getByRole("combobox", { name: "Interpolation" }));
    choose("Ease In Out");
    expect(lastClip().objects[0]!.tracks[0]!.keys[1]!.Interpolation).toBe("cubicInOut");

    fireEvent.change(within(grid).getByLabelText("Time"), { target: { value: "3.01" } });
    // Committed on the nearest frame.
    expect(lastClip().objects[0]!.tracks[0]!.keys.map((entry) => entry.Time)).toEqual([0, 3]);
  });

  it("edits a Boolean key's value", () => {
    renderInspector({ keys: [["t-vis", "v1"]] });
    const grid = screen.getByTestId("timeline-inspector-key");
    expect(within(grid).queryByRole("combobox", { name: "Interpolation" })).toBeNull();
    expect(within(grid).getByRole("checkbox", { name: "Value" })).toBeTruthy();
    fireEvent.click(within(grid).getByText("Off"));
    expect(lastClip().objects[0]!.tracks[1]!.keys[0]!.Value).toBe(true);
  });

  it("sets one interpolation for several keys", () => {
    renderInspector({ keys: [["t-loc", "k0"], ["t-loc", "k2"]] });
    const grid = screen.getByTestId("timeline-inspector-keys");
    expect(within(grid).getByText("2 Keys")).toBeTruthy();
    fireEvent.click(within(grid).getByRole("combobox", { name: "Interpolation" }));
    choose("Constant");
    expect(lastClip().objects[0]!.tracks[0]!.keys.map((entry) => entry.Interpolation)).toEqual(["constant", "constant"]);
  });

  it("mutes the selected track", () => {
    renderInspector({ row: "t-vis" });
    const grid = screen.getByTestId("timeline-inspector-track");
    expect(within(grid).getByDisplayValue("Door › Visible")).toBeTruthy();
    expect(within(grid).getByRole("checkbox", { name: "Muted" })).toBeTruthy();
    fireEvent.click(within(grid).getByText("Off"));
    expect(lastClip().objects[0]!.tracks[1]!.muted).toBe(true);
  });

  it("shows every track's value at the playhead for an actor's row and keys an edit there", () => {
    renderInspector({ row: "o-door", time: 1 });
    const actor = screen.getByTestId("timeline-inspector-actor");
    expect(within(actor).getByDisplayValue("Door")).toBeTruthy();
    const values = screen.getByTestId("timeline-inspector-actor-values");
    // Halfway between the Location keys; Visible is keyed Off at 1 s.
    expect((within(values).getByLabelText("Location X") as HTMLInputElement).value).toBe("2");
    expect(within(values).getByRole("checkbox", { name: "Visible" }).getAttribute("aria-checked")).toBe("false");

    fireEvent.change(within(values).getByLabelText("Location X"), { target: { value: "3" } });
    const location = lastClip().objects[0]!.tracks[0]!;
    expect(location.keys.map((entry) => [entry.Time, entry.Value])).toEqual([
      [0, { x: 0, y: 0, z: 0 }], [1, { x: 3, y: 0, z: 0 }], [2, { x: 4, y: 0, z: 0 }]]);
  });

  it("shows only the selected track's value and edits the key on the playhead's frame", () => {
    renderInspector({ row: "t-vis", time: 1 });
    const values = screen.getByTestId("timeline-inspector-track-values");
    expect(within(values).queryByLabelText("Location X")).toBeNull();
    fireEvent.click(within(values).getByText("Off"));
    expect(lastClip().objects[0]!.tracks[1]!.keys.map((entry) => [entry.id, entry.Time, entry.Value])).toEqual([["v1", 1, true]]);
  });

  it("shows an unkeyed change and keys it when edited", async () => {
    renderInspector({ row: "t-loc", time: 3, unkeyed: [["t-loc", { x: 9, y: 0, z: 0 }]] });
    const values = screen.getByTestId("timeline-inspector-track-values");
    expect((await within(values).findByDisplayValue("9")).getAttribute("aria-label")).toBe("Location X");
    fireEvent.change(within(values).getByLabelText("Location Y"), { target: { value: "1" } });
    expect(lastClip().objects[0]!.tracks[0]!.keys.at(-1)).toMatchObject({ Time: 3, Value: { x: 9, y: 1, z: 0 } });
    expect((within(values).getByLabelText("Location X") as HTMLInputElement).value).toBe("9");
  });

  it("edits the clip's settings and keeps its name unique", () => {
    renderInspector();
    const grid = screen.getByTestId("timeline-inspector-clip");
    expect(within(grid).getByRole("checkbox", { name: "Auto Play" })).toBeTruthy();
    fireEvent.click(within(grid).getByText("Off"));
    expect(lastClip().autoPlay).toBe(true);
    fireEvent.click(within(grid).getByRole("combobox", { name: "Loop Mode" }));
    choose("Ping Pong");
    expect(lastClip().loopMode).toBe("pingPong");
    const name = within(grid).getByLabelText("Name");
    name.focus();
    fireEvent.change(name, { target: { value: "Opening" } });
    fireEvent.blur(name);
    expect(lastClip().name).toBe("Opening");
  });

  it("edits an event key's time and a value per input", () => {
    renderInspector({ keys: [["e-line", "ek"]] });
    const grid = screen.getByTestId("timeline-inspector-event-key");
    expect(within(grid).getByDisplayValue("On Line")).toBeTruthy();
    expect(within(grid).getByDisplayValue("Hello")).toBeTruthy();
    fireEvent.click(within(grid).getByText("Off"));
    expect(lastClip().eventTracks[0]!.keys[0]!.values).toEqual({ Text: "Hello", Loud: true });
    fireEvent.change(within(grid).getByLabelText("Time"), { target: { value: "2.5" } });
    expect(lastClip().eventTracks[0]!.keys[0]!.time).toBe(2.5);
  });

  it("renames a Custom Event Track and adds an input", async () => {
    renderInspector({ row: "e-line" });
    const grid = screen.getByTestId("timeline-inspector-event-track");
    const name = within(grid).getByLabelText("Event Name");
    name.focus();
    fireEvent.change(name, { target: { value: "On Finished" } });
    fireEvent.blur(name);
    // Built-in event names stay free.
    expect(lastClip().eventTracks[0]!.name).toBe("On Finished 2");
    fireEvent.click(screen.getByTestId("timeline-event-in-add"));
    const menu = within(await screen.findByTestId("timeline-event-in-add-menu"));
    expect(menu.queryByTestId("search-item-object")).toBeNull();
    fireEvent.click(menu.getByTestId("search-item-float"));
    expect(lastClip().eventTracks[0]!.inputs.map((input) => [input.name, input.typeId])).toEqual([["Text", "string"], ["Loud", "bool"], ["NewInput", "float"]]);
  });
});

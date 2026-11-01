import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { createDefaultTimelineClipAsset, normalizeTimelineClipAsset, type SerializedTimelineClipAsset } from "@haptic/core";
import { KeybindProvider } from "../context/keybind-context";
import { SceneToolsProvider } from "../context/scene-tools-context";
import { timelineProxyActor, timelineProxyScene } from "../lib/timeline-proxy-scene";
import { TimelineClipTimelinePanel, addTimelineProxy } from "./timeline-clip-asset-editor";

if (typeof window !== "undefined" && typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {}
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

const DOC = "timeline-clip-3d:assets/Swing.timelineclip3d.hasset";
const harness = vi.hoisted(() => ({
  content: null as unknown as SerializedTimelineClipAsset,
  applyAssetDocumentChange: vi.fn(async (_id: string, payload: unknown) => {
    harness.content = payload as SerializedTimelineClipAsset;
    return true;
  }),
}));
const assets = [{ path: "assets/Swing.timelineclip3d.hasset", header: { type: "TimelineClip3D", guid: "swing", name: "Door Swing" } }];

vi.mock("../context/document-workspace-context", () => ({ useDocumentWorkspace: () => ({ documentId: DOC }) }));
vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
  get openDocuments() {
    return [{ id: DOC, ref: { kind: "timeline-clip-3d", path: "assets/Swing.timelineclip3d.hasset" }, content: harness.content }];
  },
  assetRegistry: { generation: 1, list: () => assets, getByPath: (path: string) => assets.find((asset) => asset.path === path) } as never,
  applyAssetDocumentChange: harness.applyAssetDocumentChange,
})));

const panel = {} as IDockviewPanelProps;
const last = () => normalizeTimelineClipAsset(harness.applyAssetDocumentChange.mock.calls.at(-1)![1]);
function renderTimeline() {
  const tree = () => <KeybindProvider><SceneToolsProvider><TimelineClipTimelinePanel {...panel} /></SceneToolsProvider></KeybindProvider>;
  const view = render(tree());
  return { ...view, refresh: () => view.rerender(tree()) };
}

beforeEach(() => {
  let payload = addTimelineProxy(createDefaultTimelineClipAsset("story"), "actor", "Actor", "door");
  payload = addTimelineProxy(payload, "component", "LightComponent", "glow");
  harness.content = payload;
  harness.applyAssetDocumentChange.mockClear();
});
afterEach(cleanup);

describe("Timeline Clip asset proxies as actors", () => {
  it("makes an Actor proxy an actor of its Class with the Class's components, a Component proxy an actor holding it", () => {
    const graphs = { Door: { nodes: [], edges: [], components: [{ id: "hinge", classId: "LightComponent", properties: {}, parentId: null, transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } }] } } as never;
    const door = timelineProxyActor({ id: "door", name: "Door", represents: "actor", classId: "Door", tracks: [] }, undefined, graphs, false);
    expect(door).toMatchObject({ id: "door", name: "Door", classId: "Door", components: [{ id: "hinge" }] });
    const glow = timelineProxyActor({ id: "glow", name: "Glow", represents: "component", classId: "LightComponent", tracks: [] }, undefined, graphs, false);
    expect(glow.components).toEqual([expect.objectContaining({ id: "glow", classId: "LightComponent" })]);
    expect(glow.components[0]!.properties).toHaveProperty("intensity");
    const scene = timelineProxyScene(harness.content, "Door Swing", {}, false);
    expect(scene.actors.map((actor) => actor.id)).toEqual(["door", "glow"]);
    expect(scene.timelineClips?.[0]).toMatchObject({ id: "clip", name: "Door Swing" });
    expect(scene.timelineClips?.[0]?.objects.map((object) => object.actorId)).toEqual(["door", "glow"]);
  });
});

describe("Timeline window of a clip asset", () => {
  it("lists every proxy and adds only Custom Event Tracks from the Track menu", async () => {
    renderTimeline();
    expect(screen.getByTestId("timeline-row-door").textContent).toContain("Actor");
    expect(screen.getByTestId("timeline-row-glow").textContent).toContain("Light");
    fireEvent.click(screen.getByTestId("timeline-add-menu"));
    expect(await screen.findByTestId("timeline-track-menu-event")).toBeTruthy();
    expect(screen.queryByTestId("timeline-track-menu-actor")).toBeNull();
    expect(screen.queryByTestId("timeline-track-menu-selected")).toBeNull();
  });

  it("adds a component proxy's property track and keys it, written back to the asset", async () => {
    const view = renderTimeline();
    fireEvent.click(screen.getByTestId("timeline-add-track-glow"));
    const dialog = await screen.findByTestId("timeline-add-track-dialog");
    fireEvent.change(within(dialog).getByLabelText("Search Properties"), { target: { value: "inten" } });
    fireEvent.click(within(dialog).getByText("Intensity"));
    fireEvent.click(within(dialog).getByText("Add Tracks"));
    const glow = last().proxies.find((proxy) => proxy.id === "glow")!;
    expect(glow.tracks).toEqual([expect.objectContaining({ target: { kind: "component", componentId: "glow", property: "intensity" }, valueType: "float" })]);
    // The other proxy and the preview are untouched.
    expect(last().proxies.map((proxy) => proxy.id)).toEqual(["door", "glow"]);
    expect(Object.keys(last().editorPreview!.proxies)).toEqual(["door", "glow"]);

    view.refresh();
    const trackId = glow.tracks[0]!.id;
    fireEvent.click(screen.getByTestId(`timeline-key-toggle-${trackId}`));
    expect(last().proxies.find((proxy) => proxy.id === "glow")!.tracks[0]!.keys).toEqual([expect.objectContaining({ Time: 0 })]);
  });

  it("keeps a proxy's row on Delete and offers no Remove From Clip", () => {
    renderTimeline();
    fireEvent.contextMenu(screen.getByTestId("timeline-row-door"));
    expect(screen.queryByTestId("timeline-row-menu-remove")).toBeNull();
    expect(screen.queryByTestId("timeline-row-menu-reveal")).toBeNull();
  });
});

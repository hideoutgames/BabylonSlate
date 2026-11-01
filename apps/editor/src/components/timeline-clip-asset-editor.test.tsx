import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { createDefaultTimelineClipAsset, normalizeTimelineClipAsset, type SerializedTimelineClipAsset } from "@haptic/core";
import { SceneToolsProvider } from "../context/scene-tools-context";
import {
  TimelineClipInspectorPanel,
  TimelineClipProxiesPanel,
  addTimelineProxy,
  removeTimelineProxy,
  renameTimelineProxy,
  selectProxy,
  timelineProxyClassEntries,
} from "./timeline-clip-asset-editor";

const harness = vi.hoisted(() => ({
  kind: "timeline-clip-3d" as "timeline-clip-2d" | "timeline-clip-3d",
  content: null as unknown as SerializedTimelineClipAsset,
  applyAssetDocumentChange: vi.fn(async (_id: string, payload: unknown) => {
    harness.content = payload as SerializedTimelineClipAsset;
    return true;
  }),
}));

const assets = [
  { path: "assets/Story.timeline.hasset", header: { type: "Timeline", guid: "story", name: "Story" } },
  { path: "assets/Hall.timeline.hasset", header: { type: "Timeline", guid: "hall", name: "Hall" } },
  { path: "assets/Door.class.hasset", header: { type: "Class", guid: "door", name: "Door", parentClass: "Actor" } },
];
const DOC = "timeline-clip-3d:assets/Swing.timelineclip3d.hasset";

vi.mock("../context/document-workspace-context", () => ({ useDocumentWorkspace: () => ({ documentId: DOC }) }));
vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
  get openDocuments() {
    return [{ id: DOC, ref: { kind: harness.kind, path: "assets/Swing.timelineclip3d.hasset" }, content: harness.content }];
  },
  assetRegistry: { generation: 1, list: () => assets, getByPath: (path: string) => assets.find((asset) => asset.path === path) } as never,
  applyAssetDocumentChange: harness.applyAssetDocumentChange,
})));

const panel = {} as IDockviewPanelProps;
const last = () => normalizeTimelineClipAsset(harness.applyAssetDocumentChange.mock.calls.at(-1)![1]);
function renderBoth() {
  // The document's Timeline tools, which the Inspector's key and track grids read.
  const tree = () => <SceneToolsProvider><TimelineClipProxiesPanel {...panel} /><TimelineClipInspectorPanel {...panel} /></SceneToolsProvider>;
  const view = render(tree());
  return { ...view, refresh: () => view.rerender(tree()) };
}

beforeEach(() => {
  harness.kind = "timeline-clip-3d";
  harness.content = createDefaultTimelineClipAsset("story");
  harness.applyAssetDocumentChange.mockClear();
});
afterEach(cleanup);

describe("Timeline Clip asset proxies", () => {
  it("names a new proxy after its Class, numbered when taken, with the next preview colour", () => {
    let payload = addTimelineProxy(createDefaultTimelineClipAsset("story"), "actor", "Door", "a");
    payload = addTimelineProxy(payload, "actor", "Door", "b");
    payload = addTimelineProxy(payload, "component", "LightComponent", "c");
    expect(payload.proxies.map((proxy) => [proxy.name, proxy.represents])).toEqual([["Door", "actor"], ["Door 2", "actor"], ["Light", "component"]]);
    expect(new Set(Object.values(payload.editorPreview!.proxies).map((preview) => preview.color)).size).toBe(3);
    expect(renameTimelineProxy(payload, "b", "Door").proxies[1]!.name).toBe("Door 2");
    const removed = removeTimelineProxy(payload, "a");
    expect(removed.proxies.map((proxy) => proxy.id)).toEqual(["b", "c"]);
    expect(Object.keys(removed.editorPreview!.proxies)).toEqual(["b", "c"]);
  });

  it("offers Actor and component Classes for 3D or 2D", () => {
    const actors = timelineProxyClassEntries("actor", false, assets).map((entry) => entry.id);
    expect(actors).toEqual(expect.arrayContaining(["Actor", "Door"]));
    expect(actors).not.toContain("LightComponent");
    const world = timelineProxyClassEntries("component", false, assets).map((entry) => entry.id);
    const overlay = timelineProxyClassEntries("component", true, assets).map((entry) => entry.id);
    expect(world).toContain("LightComponent");
    expect(world).not.toContain("2DTextComponent");
    expect(overlay).toContain("2DTextComponent");
  });

  it("adds an Actor proxy from the Class list, and edits its name and Editor Preview in the Inspector", () => {
    const view = renderBoth();
    expect(screen.getByText("No Proxies")).toBeTruthy();
    fireEvent.click(screen.getByTestId("timeline-proxies-add"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Actor Proxy…" }));
    const dialog = screen.getByTestId("timeline-proxy-class-dialog");
    fireEvent.click(within(dialog).getByTestId("timeline-proxy-class-Door"));
    fireEvent.click(screen.getByTestId("timeline-proxy-class-dialog-confirm"));
    expect(last().proxies).toEqual([expect.objectContaining({ name: "Door", represents: "actor", classId: "Door" })]);

    view.refresh();
    const proxy = screen.getByTestId("timeline-clip-inspector-proxy");
    const name = within(proxy).getByLabelText("Name");
    name.focus();
    fireEvent.change(name, { target: { value: "Front Door" } });
    fireEvent.blur(name);
    expect(last().proxies[0]!.name).toBe("Front Door");

    // A 3D clip draws a proxy as an Outline, a Model or its Class.
    const preview = screen.getByTestId("timeline-clip-inspector-preview");
    fireEvent.click(within(preview).getByRole("combobox", { name: "Representation" }));
    expect(screen.queryByRole("option", { name: "Texture" })).toBeNull();
    const model = screen.getByRole("option", { name: "Model" });
    fireEvent.pointerDown(model);
    fireEvent.click(model);
    const proxyId = last().proxies[0]!.id;
    expect(last().editorPreview!.proxies[proxyId]!.representation).toBe("model");
  });

  it("offers Material and Texture in 2D, and keeps the Timeline Asset required", () => {
    harness.kind = "timeline-clip-2d";
    harness.content = addTimelineProxy(createDefaultTimelineClipAsset("story"), "component", "2DTextComponent", "badge");
    const view = renderBoth();
    expect(screen.getByRole("treeitem", { name: /2DText/ })).toBeTruthy();
    act(() => selectProxy(DOC, "badge"));
    view.refresh();
    const preview = screen.getByTestId("timeline-clip-inspector-preview");
    fireEvent.click(within(preview).getByRole("combobox", { name: "Representation" }));
    expect(screen.getByRole("option", { name: "Texture" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Material" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Model" })).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    const clip = screen.getByTestId("timeline-clip-inspector-clip");
    expect(within(clip).getByText("2D Timeline Clip")).toBeTruthy();
    expect(within(clip).getByText("Story")).toBeTruthy();
    fireEvent.click(within(clip).getByText("Story"));
    // The picker has no None row: the clip always names a Timeline Asset.
    expect(screen.queryByText("None")).toBeNull();
    fireEvent.click(screen.getByText("Hall"));
    expect(last().timelineAsset).toBe("hall");
  });
});

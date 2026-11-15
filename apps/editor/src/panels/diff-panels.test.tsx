import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceControlActionsProvider, useSourceControlDiff } from "../components/source-control-actions";
import { SourceControlDiffPickers } from "../components/source-control-diff-pickers";
import type { SourceControlSyncService } from "../services/source-control-sync";
import { sceneActor, sceneAsset, testAsset } from "../testing/diff-assets";
import { integratedSync } from "../testing/integrated-sync";
import { ChangesPanelContents } from "./changes-panel";
import { DiffActorsContents, DiffActorsPanel } from "./diff-actors-panel";
import { DiffContents, DiffPanel } from "./diff-panel";

// The Source Control tab's Changes, Actors and Diff windows and the toolbar's version pickers,
// together over the real sync and diff services on FakeSync, with real Scene files.

if (typeof window !== "undefined" && typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {}
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

const state = vi.hoisted(() => ({
  sync: null as SourceControlSyncService | null,
  openDocument: vi.fn(async () => {}),
}));

vi.mock("../context/document-context", async () =>
  (await import("../testing/document-context-mock")).documentContextMock(() => ({
    ...(state.sync ? { sourceControlSync: state.sync } : {}),
    openDocument: state.openDocument,
  })),
);

afterEach(() => {
  cleanup();
  state.sync?.dispose();
  state.sync = null;
  state.openDocument.mockClear();
});

const PATH = "assets/Forest.scene.hasset";

const light = (intensity: number) => sceneActor("sun", "Directional Light", {
  components: [{ id: "light", classId: "DirectionalLightComponent", properties: { intensity, mobility: "static" } }],
});

async function forest() {
  const base = await sceneAsset([light(2), sceneActor("sky", "Sky Atmosphere"), sceneActor("fence", "Fence 03")]);
  const sync = await integratedSync({ files: { [PATH]: base.bytes } });
  state.sync = sync.service;
  // This copy brightens the sun, removes the fence and adds a bridge.
  const edited = await sceneAsset([light(3.2), sceneActor("sky", "Sky Atmosphere"), sceneActor("bridge", "Bridge")]);
  await sync.storage.writeBinary(PATH, edited.bytes);
  await sync.service.refreshStatus();
  return sync;
}

/** A tap on a tree row, as the TreeView reads it (jsdom has no PointerEvent). */
function tap(element: Element) {
  for (const type of ["pointerdown", "pointerup"]) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
    Object.defineProperty(event, "pointerId", { value: 1 });
    Object.defineProperty(event, "pointerType", { value: "mouse" });
    Object.defineProperty(event, "isPrimary", { value: true });
    element.dispatchEvent(event);
  }
}

/** A dock window's API as the diff windows read it: whether it is on screen, and when that changes. */
function dockApi(visible: boolean) {
  const listeners = new Set<(event: { isVisible: boolean }) => void>();
  const api = {
    isVisible: visible,
    onDidVisibilityChange(listener: (event: { isVisible: boolean }) => void) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    show(next: boolean) {
      api.isVisible = next;
      for (const listener of listeners) listener({ isVisible: next });
    },
  };
  return api;
}

let diffService: ReturnType<typeof useSourceControlDiff> | null = null;
function CaptureDiff() {
  diffService = useSourceControlDiff();
  return null;
}

function renderTab() {
  return render(
    <SourceControlActionsProvider>
      <CaptureDiff />
      <SourceControlDiffPickers />
      <ChangesPanelContents />
      <DiffActorsContents />
      <DiffContents />
    </SourceControlActionsProvider>,
  );
}

describe("Source Control diff windows", () => {
  it("opens a Changes row's diff: actors marked with counts, and the chosen actor's properties side by side or inline", async () => {
    await forest();
    renderTab();
    expect(screen.getByTestId("diff-panel-placeholder").textContent).toContain("Choose a change");
    expect(screen.queryByTestId("diff-pickers")).toBeNull();

    fireEvent.click(await screen.findByTestId(`changes-open-${PATH}`));
    expect(screen.getByTestId(`changes-row-${PATH}`).dataset.selected).toBe("true");
    const tree = await screen.findByTestId("diff-actors-tree");
    expect(screen.getByTestId("diff-counts").textContent).toBe("1 Added1 Removed1 Changed");
    const label = (name: string) => within(tree).getByText(name);
    expect(label("Directional Light").dataset.tone).toBe("warning");
    expect(label("Bridge").dataset.tone).toBe("success");
    expect(label("Fence 03").dataset.tone).toBe("destructive");
    expect(label("Sky Atmosphere").className).toContain("text-muted-foreground");

    // The first changed actor is shown: its changed cells tinted, both versions named.
    expect(screen.getByTestId("diff-item-name").textContent).toBe("Directional Light");
    const intensity = screen.getByTestId("diff-row-properties.intensity");
    expect(intensity.dataset.changed).toBe("true");
    expect(intensity.textContent).toBe("Intensity23.2");
    expect(screen.getByTestId("diff-properties").textContent).toContain("Base (main · ");
    expect(screen.getByTestId("diff-properties").textContent).toContain("Working Copy");
    expect(screen.getByTestId("diff-row-properties.mobility").dataset.changed).toBeUndefined();

    fireEvent.click(screen.getByTestId("diff-changed-only"));
    await waitFor(() => expect(screen.queryByTestId("diff-row-properties.mobility")).toBeNull());
    fireEvent.click(screen.getByTestId("diff-layout-inline"));
    expect(within(screen.getByTestId("diff-row-properties.intensity")).getByText("2").tagName).toBe("DEL");

    // Search keeps matching actors; choosing one shows it.
    fireEvent.change(screen.getByTestId("diff-actors-search"), { target: { value: "bri" } });
    expect(within(tree).queryByText("Sky Atmosphere")).toBeNull();
    act(() => tap(screen.getByTestId("tree-row-bridge")));
    expect(screen.getByTestId("diff-item-name").textContent).toBe("Bridge");

    fireEvent.click(screen.getByTestId("diff-open-asset"));
    expect(state.openDocument).toHaveBeenCalledWith({ kind: "scene", path: PATH, label: "Forest" });
  });

  it("compares other versions from the toolbar's pickers, and offers no revert to the working copy", async () => {
    const { service } = await forest();
    renderTab();
    fireEvent.click(await screen.findByTestId(`changes-open-${PATH}`));
    await screen.findByTestId("diff-actors-tree");
    expect(screen.getByTestId("diff-base").textContent).toContain(`main · ${service.getSnapshot().head!.slice(0, 7)}`);
    expect(screen.getByTestId("diff-compare").textContent).toContain("Working Copy");
    expect((screen.getByTestId("diff-revert") as HTMLButtonElement).disabled).toBe(false);

    // Working copy as the base: both sides swap, and there is nothing to revert to.
    act(() => diffService!.setRefs({ base: { kind: "working" }, compare: { kind: "head" } }));
    await waitFor(() => expect(within(screen.getByTestId("diff-actors-tree")).getByText("Fence 03").dataset.tone).toBe("success"));
    expect(screen.getByTestId("diff-counts").textContent).toBe("1 Added1 Removed1 Changed");
    expect(screen.getByTestId("diff-base").textContent).toContain("Working Copy");
    expect((screen.getByTestId("diff-revert") as HTMLButtonElement).disabled).toBe(true);
  });

  it("asks before reverting the asset to its base version", async () => {
    const { storage } = await forest();
    renderTab();
    fireEvent.click(await screen.findByTestId(`changes-open-${PATH}`));
    await screen.findByTestId("diff-actors-tree");
    fireEvent.click(screen.getByTestId("diff-revert"));
    const confirm = await screen.findByTestId("source-control-revert-confirm");
    expect(confirm.textContent).toContain("Revert Forest?");
    expect(confirm.textContent).toContain("It cannot be undone.");
    const before = await storage.readBinary(PATH);
    fireEvent.click(screen.getByTestId("source-control-revert-cancel"));
    await waitFor(() => expect(screen.queryByTestId("source-control-revert-confirm")).toBeNull());
    expect(await storage.readBinary(PATH)).toEqual(before);
  });

  it("draws a graph diff on the read-only canvas: nodes tagged by what changed, the old pin value struck through beside the new", async () => {
    const pin = { id: "speed", name: "Max Walk Speed", kind: "data", direction: "in", type: { kind: "float" } };
    const node = (id: string, title: string, data: Record<string, unknown> = {}) => ({ id, type: "pinNode", position: { x: 0, y: 0 }, data: { __nodeType: "call.custom", title, __pins: [pin], ...data } });
    const graph = (speed: number, last: string) => ({ nodes: [node("set", "Set Max Walk Speed", { "default:speed": speed }), node(last, last)], edges: [], members: [] });
    const path = "assets/Player.class.hasset";
    const sync = await integratedSync({ files: { [path]: (await testAsset("Class", "Player", { document: graph(600, "Print String") })).bytes } });
    state.sync = sync.service;
    await sync.storage.writeBinary(path, (await testAsset("Class", "Player", { document: graph(750, "Play Sound 2D") })).bytes);
    await sync.service.refreshStatus();
    renderTab();
    act(() => diffService!.open({ path, name: "Player", type: "Class" }));
    const canvas = await screen.findByTestId("diff-graph", {}, { timeout: 5000 });
    await waitFor(() => expect(canvas.querySelectorAll("[data-diff-status]").length).toBe(3));
    const statuses = [...canvas.querySelectorAll<HTMLElement>("[data-diff-status]")].map((element) => [element.textContent?.includes("Play Sound 2D") ? "Play Sound 2D" : element.textContent?.includes("Print String") ? "Print String" : "Set Max Walk Speed", element.dataset.diffStatus]);
    expect(statuses).toEqual([["Set Max Walk Speed", "changed"], ["Play Sound 2D", "added"], ["Print String", "removed"]]);
    const values = within(canvas).getByTestId("diff-pin-changes");
    expect(within(values).getByText("600").tagName).toBe("DEL");
    expect(within(values).getByText("750").tagName).toBe("SPAN");
    // The Actors window lists the graph and its changed nodes.
    expect(within(screen.getByTestId("diff-actors-tree")).getByText("Play Sound 2D").dataset.tone).toBe("success");

    fireEvent.click(screen.getByTestId("diff-graph-base"));
    await waitFor(() => expect(canvas.querySelectorAll("[data-diff-status]").length).toBe(2));
  });

  it("compares a Texture's facts and counts the Materials that use it, with no preview where none decodes", async () => {
    const path = "assets/Rock.texture.hasset";
    const texture = (width: number) => testAsset("Texture", "Rock", { payload: { width, height: width, usage: "albedo" }, chunks: [{ id: "source", kind: "source", mime: "image/png", data: new Uint8Array(64).fill(width % 251) }] });
    const sync = await integratedSync({ files: { [path]: (await texture(1024)).bytes } });
    state.sync = sync.service;
    await sync.storage.writeBinary(path, (await texture(2048)).bytes);
    await sync.service.refreshStatus();
    renderTab();
    act(() => diffService!.open({ path, name: "Rock", type: "Texture" }));
    expect((await screen.findByTestId("diff-row-size")).textContent).toBe("Size1024 × 10242048 × 2048");
    expect(screen.getByTestId("diff-row-source").dataset.changed).toBe("true");
    expect(screen.getByTestId("diff-texture-base-none").textContent).toBe("No Preview");
    expect(screen.getByTestId("diff-texture-materials").textContent).toBe("Used By 0 Materials");
  });

  it("lists another graph family's node changes as properties, and the asset's own header and chunks from its row", async () => {
    const node = (value: number) => ({ id: "tint", type: "material.constant", position: { x: 0, y: 0 }, data: { title: "Tint", __pins: [{ id: "value", name: "Value", kind: "data", direction: "in", type: { kind: "float" } }], "default:value": value } });
    const path = "assets/Water.material.hasset";
    const material = (value: number) => testAsset("Material", "Water", { document: { nodes: [node(value)], edges: [] } });
    const sync = await integratedSync({ files: { [path]: (await material(0.25)).bytes } });
    state.sync = sync.service;
    await sync.storage.writeBinary(path, (await material(0.5)).bytes);
    await sync.service.refreshStatus();
    renderTab();
    act(() => diffService!.open({ path, name: "Water", type: "Material" }));
    const value = await screen.findByTestId("diff-row-pin:value");
    expect(value.textContent).toBe("Value0.250.5");
    expect(screen.queryByTestId("diff-graph")).toBeNull();
    // The node's row says what changed in it.
    expect(screen.getByTestId("tree-row-event/tint").textContent).toContain("Value: 0.25 → 0.5");

    act(() => tap(screen.getByTestId("tree-row-asset")));
    expect(screen.getByTestId("diff-item-name").textContent).toBe("Water");
    expect(screen.getByTestId("diff-row-chunk:document").dataset.changed).toBe("true");
    expect(screen.getByTestId("diff-row-name").dataset.changed).toBeUndefined();
  });

  it("reads nothing while neither window is on screen, and loads what changed once one is shown again", async () => {
    const { service, storage } = await forest();
    const reads = vi.spyOn(service, "readWorking");
    const stamps = vi.spyOn(service, "workingStamp");
    const loads = () => reads.mock.calls.filter(([path]) => path === PATH).length;
    const actors = dockApi(false);
    const diffWindow = dockApi(false);
    render(
      <SourceControlActionsProvider>
        <CaptureDiff />
        <DiffActorsPanel {...({ api: actors } as unknown as IDockviewPanelProps)} />
        <DiffPanel {...({ api: diffWindow } as unknown as IDockviewPanelProps)} />
      </SourceControlActionsProvider>,
    );
    // Opened while another tab is in front: nothing is read until a window shows it.
    act(() => diffService!.open({ path: PATH, name: "Forest", type: "Scene" }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(loads()).toBe(0);
    act(() => diffWindow.show(true));
    await screen.findByTestId("diff-item-name");
    expect(loads()).toBe(1);

    // The tab is left: an Auto-Save of the Scene and its status read nothing for the diff.
    act(() => diffWindow.show(false));
    stamps.mockClear();
    await storage.writeBinary(PATH, (await sceneAsset([light(5), sceneActor("sky", "Sky Atmosphere")])).bytes);
    await act(() => service.refreshStatus());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(stamps).not.toHaveBeenCalled();
    expect(loads()).toBe(1);

    // Back on screen: the save is found and loaded once.
    act(() => actors.show(true));
    await waitFor(() => expect(loads()).toBe(2));
    await waitFor(() => expect(screen.getByTestId("diff-counts").textContent).toBe("0 Added1 Removed1 Changed"));
  });

  it("shows why a version cannot be compared", async () => {
    await forest();
    renderTab();
    // Seeded as text, not an asset.
    act(() => diffService!.open({ path: "assets/Rock.texture.hasset", name: "Rock", type: "Texture" }));
    await waitFor(() => expect(screen.getByTestId("diff-actors-panel-placeholder").textContent).toContain("Could Not Compare Rock"));
    expect(screen.getByTestId("diff-panel-placeholder").textContent).toContain(".hasset");
  });
});

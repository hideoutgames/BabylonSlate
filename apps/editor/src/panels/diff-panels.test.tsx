import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceControlActionsProvider, useSourceControlDiff } from "../components/source-control-actions";
import { SourceControlDiffPickers } from "../components/source-control-diff-pickers";
import type { SourceControlSyncService } from "../services/source-control-sync";
import { sceneActor, sceneAsset } from "../testing/diff-assets";
import { integratedSync } from "../testing/integrated-sync";
import { ChangesPanelContents } from "./changes-panel";
import { DiffActorsContents } from "./diff-actors-panel";
import { DiffContents } from "./diff-panel";

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

  it("shows why a version cannot be compared", async () => {
    await forest();
    renderTab();
    // Seeded as text, not an asset.
    act(() => diffService!.open({ path: "assets/Rock.texture.hasset", name: "Rock", type: "Texture" }));
    await waitFor(() => expect(screen.getByTestId("diff-actors-panel-placeholder").textContent).toContain("Could Not Compare Rock"));
    expect(screen.getByTestId("diff-panel-placeholder").textContent).toContain(".hasset");
  });
});

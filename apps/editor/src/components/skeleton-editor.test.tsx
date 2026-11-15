import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { buildMinimalGlbFixture } from "@haptic/assets";
import { DocumentWorkspaceProvider } from "../context/document-workspace-context";
import { SkeletonEditingProvider } from "../context/skeleton-editing-context";
import { SkeletonDetailsPanel, SkeletonPreviewPanel } from "./skeleton-editor";

const documents = vi.hoisted(() => ({
  open: [] as { id: string; ref: { path: string }; content: Record<string, unknown> }[],
  assets: [] as { path: string; header: { guid: string; name: string; type: string; payload: Record<string, unknown> } }[],
  readAssetChunk: vi.fn<(path: string, chunkId: string) => Promise<Uint8Array | null>>(async () => null),
  applyAssetDocumentChange: vi.fn<(id: string, next: Record<string, unknown>) => Promise<boolean>>(async () => true),
}));

vi.mock("../context/document-context", async () =>
  (await import("../testing/document-context-mock")).documentContextMock(() => ({
    assetRegistry: {
      list: () => documents.assets,
      getByGuid: (guid: string) => documents.assets.find((asset) => asset.header.guid === guid),
      getByPath: (path: string) => documents.assets.find((asset) => asset.path === path),
    },
    applyAssetDocumentChange: documents.applyAssetDocumentChange,
    openDocuments: documents.open,
    readAssetChunk: documents.readAssetChunk,
  })),
);

afterEach(() => {
  cleanup();
  documents.open = [];
  documents.assets = [];
  documents.readAssetChunk.mockReset();
  documents.applyAssetDocumentChange.mockClear();
});

const bone = (name: string, parent: string | null, position = [0, 0.3, 0]) =>
  ({ name, parent, position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
const HERO_SKELETON = {
  modelGuid: "hero",
  kind: "skin",
  bones: [bone("hips", null, [0, 1, 0]), bone("spine", "hips"), bone("head", "spine"), bone("leg", "hips")],
};
const skeletonAsset = { path: "assets/Hero_Skeleton.hasset", header: { guid: "rig-guid", name: "Hero_Skeleton", type: "Skeleton", payload: HERO_SKELETON } };
const model = (guid: string, name: string, skeletonGuid: string | null) =>
  ({ path: `assets/${name}.hasset`, header: { guid, name, type: "Model", payload: { materialSlots: [], skeletonGuid } } });

const panelProps = {} as IDockviewPanelProps;

/** jsdom has no PointerEvent; a MouseEvent with pointer fields drives TreeView. */
function tapRow(id: string): void {
  const row = screen.getByTestId(`tree-row-${id}`);
  for (const type of ["pointerdown", "pointerup"]) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
    Object.defineProperty(event, "pointerId", { value: 1 });
    Object.defineProperty(event, "pointerType", { value: "mouse" });
    Object.defineProperty(event, "isPrimary", { value: true });
    act(() => { row.dispatchEvent(event); });
  }
}

describe("Skeleton editor", () => {
  it("highlights the bone selected in the Inspector in the Preview, and clears it on a second tap", async () => {
    documents.open = [{
      id: "rig",
      ref: { path: "assets/Hero_Skeleton.hasset" },
      content: HERO_SKELETON,
    }];
    documents.assets = [skeletonAsset, model("hero", "Hero", "rig-guid")];
    documents.readAssetChunk.mockResolvedValue(buildMinimalGlbFixture());
    render(
      <DocumentWorkspaceProvider documentId="rig">
        <SkeletonEditingProvider>
          <SkeletonDetailsPanel {...panelProps} />
          <SkeletonPreviewPanel {...panelProps} />
        </SkeletonEditingProvider>
      </DocumentWorkspaceProvider>,
    );
    const canvas = await screen.findByTestId("skeleton-preview-canvas");
    expect(canvas.getAttribute("data-selected-bone")).toBeNull();

    tapRow("spine");
    expect(canvas.getAttribute("data-selected-bone")).toBe("spine");

    tapRow("spine");
    expect(canvas.getAttribute("data-selected-bone")).toBeNull();
  });

  it("lists bones as a tree, shows the selected bone's rest pose, and collapses a branch", () => {
    documents.open = [{ id: "rig", ref: { path: "assets/Hero_Skeleton.hasset" }, content: HERO_SKELETON }];
    documents.assets = [skeletonAsset, model("hero", "Hero", "rig-guid")];
    render(
      <DocumentWorkspaceProvider documentId="rig">
        <SkeletonEditingProvider>
          <SkeletonDetailsPanel {...panelProps} />
        </SkeletonEditingProvider>
      </DocumentWorkspaceProvider>,
    );
    const rows = () => screen.getAllByTestId(/^tree-row-/).map((row) => row.getAttribute("data-testid")!.slice("tree-row-".length));
    expect(rows()).toEqual(["hips", "spine", "head", "leg"]);
    expect(screen.queryByTestId("skeleton-bone-details")).toBeNull();

    tapRow("spine");
    const details = screen.getByTestId("skeleton-bone-details");
    expect(details.textContent).toContain("Parent");
    expect(details.textContent).toContain("hips");
    expect(details.textContent).toContain("Rest Position");

    act(() => { screen.getByTestId("tree-row-spine").querySelector<HTMLElement>("[data-tree-disclosure], button")?.click(); });
    expect(rows()).toEqual(["hips", "spine", "leg"]);
  });

  it("offers only Models on this Skeleton as the Preview Model and counts its Models and Animations", () => {
    documents.open = [{ id: "rig", ref: { path: "assets/Hero_Skeleton.hasset" }, content: HERO_SKELETON }];
    documents.assets = [
      skeletonAsset,
      model("hero", "Hero", "rig-guid"),
      model("rogue", "Rogue", "rig-guid"),
      model("crate", "Crate", null),
      { path: "assets/Hero_Walk.hasset", header: { guid: "walk", name: "Hero_Walk", type: "Animation", payload: { clipName: "Walk", modelGuid: "hero", skeletonGuid: "rig-guid" } } },
    ];
    render(
      <DocumentWorkspaceProvider documentId="rig">
        <SkeletonEditingProvider>
          <SkeletonDetailsPanel {...panelProps} />
        </SkeletonEditingProvider>
      </DocumentWorkspaceProvider>,
    );
    const editor = screen.getByTestId("skeleton-editor");
    expect(editor.textContent).toMatch(/Models\s*2/);
    expect(editor.textContent).toMatch(/Animations\s*1/);
    act(() => { screen.getByTestId("property-model").click(); });
    const picker = screen.getByTestId("skeleton-preview-model-picker");
    expect(picker.textContent).toContain("Rogue");
    expect(picker.textContent).not.toContain("Crate");
    act(() => { screen.getByText("Rogue").click(); });
    expect(documents.applyAssetDocumentChange).toHaveBeenCalledWith("rig", expect.objectContaining({ modelGuid: "rogue" }));
  });
});

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
}));

vi.mock("../context/document-context", async () =>
  (await import("../testing/document-context-mock")).documentContextMock(() => ({
    assetRegistry: {
      list: () => documents.assets,
      getByGuid: (guid: string) => documents.assets.find((asset) => asset.header.guid === guid),
    },
    openDocuments: documents.open,
    readAssetChunk: documents.readAssetChunk,
  })),
);

afterEach(() => {
  cleanup();
  documents.open = [];
  documents.assets = [];
  documents.readAssetChunk.mockReset();
});

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
      content: { modelGuid: "hero", kind: "skin", boneNames: ["hips", "spine", "head"] },
    }];
    documents.assets = [{ path: "assets/Hero.hasset", header: { guid: "hero", name: "Hero", type: "Model", payload: {} } }];
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
});

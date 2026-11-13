import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { DocumentWorkspaceProvider } from "../context/document-workspace-context";
import { AnimationEditor, AnimationPreviewPanel } from "./animation-editor";

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
  documents.readAssetChunk.mockResolvedValue(null);
});

const durationInput = () => screen.getByTestId("property-durationMs") as HTMLInputElement;

describe("AnimationEditor", () => {
  it("edits Duration and keeps the clip's length as the reset default", () => {
    const onChange = vi.fn();
    render(
      <AnimationEditor
        payload={{ clipName: "Walk", modelGuid: "hero", durationMs: 1000, clipDurationMs: 1000 }}
        onChange={onChange}
      />,
    );
    fireEvent.change(durationInput(), { target: { value: "1500" } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ clipName: "Walk", modelGuid: "hero", durationMs: 1500, clipDurationMs: 1000 }),
      expect.any(String),
    );
  });

  it("resets an authored Duration to the clip's length", () => {
    const onChange = vi.fn();
    render(
      <AnimationEditor
        payload={{ clipName: "Walk", modelGuid: "hero", durationMs: 2500, clipDurationMs: 1000 }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Reset Duration" }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ durationMs: 1000, clipDurationMs: 1000 }),
      expect.any(String),
    );
  });

  it("shows Duration read-only without an owner to write it", () => {
    render(<AnimationEditor payload={{ clipName: "Walk", modelGuid: "hero", durationMs: 1000 }} />);
    expect(durationInput().disabled).toBe(true);
  });
});

describe("AnimationPreviewPanel", () => {
  it("reports a failed read of the owning Model's source instead of an empty mesh", async () => {
    documents.open = [{ id: "walk", ref: { path: "assets/Walk.anim3d.hasset" }, content: { clipName: "Walk", modelGuid: "hero" } }];
    documents.assets = [{ path: "assets/hero.model.hasset", header: { guid: "hero", name: "Hero", type: "Model", payload: {} } }];
    documents.readAssetChunk.mockRejectedValueOnce(new Error("Asset chunk assets/hero.model.hasset#source could not be read."));
    render(
      <DocumentWorkspaceProvider documentId="walk">
        <AnimationPreviewPanel {...({} as IDockviewPanelProps)} />
      </DocumentWorkspaceProvider>,
    );
    expect(await screen.findByText("Failed to Read Mesh")).toBeTruthy();
    expect(screen.getByText("Asset chunk assets/hero.model.hasset#source could not be read.")).toBeTruthy();
    expect(screen.queryByText("No Mesh")).toBeNull();
    expect(documents.readAssetChunk).toHaveBeenCalledWith("assets/hero.model.hasset", "source");
  });
});

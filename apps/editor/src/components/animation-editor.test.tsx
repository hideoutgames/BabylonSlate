import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { DocumentWorkspaceProvider } from "../context/document-workspace-context";
import { AnimationEditor, AnimationPreview, AnimationPreviewPanel } from "./animation-editor";

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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

describe("AnimationPreview playback", () => {
  /** A glTF file the preview accepts; without an Engine (jsdom) no clip loads, so the clock alone is under test. */
  const gltf = new TextEncoder().encode(JSON.stringify({ asset: { version: "2.0" } }));

  function stubFrames() {
    let now = 0;
    const raf = new Map<number, FrameRequestCallback>();
    let nextId = 1;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = nextId++;
      raf.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      raf.delete(id);
    });
    return (advanceMs: number) => {
      act(() => {
        now += advanceMs;
        const queued = [...raf.values()];
        raf.clear();
        for (const callback of queued) callback(now);
      });
    };
  }

  const position = () => screen.getByTestId("animation-preview-position").textContent;

  it("plays the authored Duration in real time, pauses, scrubs and restarts", () => {
    const flush = stubFrames();
    render(
      <AnimationPreview
        payload={{ clipName: "Walk", modelGuid: "hero", skeletonGuid: null, sourceAnimationGuid: null, durationMs: 2000, clipDurationMs: 1000 }}
        sourceBytes={gltf}
        materialSlots={[]}
      />,
    );
    expect(position()).toBe("Frame 1/1 · 0/2000 ms");
    flush(0);
    flush(50);
    expect(position()).toBe("Frame 1/1 · 50/2000 ms");
    fireEvent.click(screen.getByTestId("animation-preview-pause"));
    flush(50);
    expect(position()).toBe("Frame 1/1 · 50/2000 ms");
    // Scrubbing moves the playhead and stays paused.
    fireEvent.click(screen.getByTestId("animation-preview-play"));
    // jsdom never measures the track, so Base UI keeps the thumb (and its name) hidden.
    const scrubber = within(screen.getByTestId("animation-preview-scrubber")).getByRole("slider", { hidden: true });
    fireEvent.keyDown(scrubber, { key: "End" });
    expect(position()).toBe("Frame 1/1 · 2000/2000 ms");
    expect(screen.getByTestId("animation-preview-play")).toBeTruthy();
    fireEvent.click(screen.getByTestId("animation-preview-restart"));
    expect(position()).toBe("Frame 1/1 · 0/2000 ms");
  });

  it("stops a clip on its end with Loop off", () => {
    const flush = stubFrames();
    render(
      <AnimationPreview
        payload={{ clipName: "Walk", modelGuid: "hero", skeletonGuid: null, sourceAnimationGuid: null, durationMs: 150 }}
        sourceBytes={gltf}
        materialSlots={[]}
      />,
    );
    fireEvent.click(screen.getByTestId("animation-preview-loop"));
    flush(0);
    flush(100);
    flush(100);
    expect(position()).toBe("Frame 1/1 · 150/150 ms");
    expect(screen.getByTestId("animation-preview-play")).toBeTruthy();
  });

  it("holds time while the preview is not shown", () => {
    const flush = stubFrames();
    render(
      <AnimationPreview
        payload={{ clipName: "Walk", modelGuid: "hero", skeletonGuid: null, sourceAnimationGuid: null, durationMs: 1000 }}
        sourceBytes={gltf}
        materialSlots={[]}
        active={false}
      />,
    );
    flush(0);
    flush(50);
    expect(position()).toBe("Frame 1/1 · 0/1000 ms");
  });
});

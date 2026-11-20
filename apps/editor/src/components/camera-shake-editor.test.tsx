import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { createDefaultCameraShakePayload } from "@haptic/core";
import { CameraShakeDetailsPanel, CameraShakePreviewPanel } from "./camera-shake-editor";
import { setEditorQuiet } from "../lib/editor-quiet";

const DOC = "camera-shake:assets/Hit.shake.hasset";
const harness = vi.hoisted(() => ({
  applyAssetDocumentChange: vi.fn(async () => true),
  present: vi.fn(),
}));
const curves = [
  { header: { guid: "fade", name: "Fade", type: "FloatCurve", payload: {} }, path: "assets/Fade.floatcurve.hasset" },
  { header: { guid: "path", name: "Path", type: "VectorCurve", payload: {} }, path: "assets/Path.vectorcurve.hasset" },
];

vi.mock("../context/document-workspace-context", () => {
  const workspace = { documentId: "camera-shake:assets/Hit.shake.hasset" };
  return { useDocumentWorkspace: () => workspace, useOptionalDocumentWorkspace: () => workspace };
});
vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
  openDocuments: [{ id: "camera-shake:assets/Hit.shake.hasset", ref: { kind: "camera-shake", path: "assets/Hit.shake.hasset" }, content: createDefaultCameraShakePayload() }],
  activeDocumentId: "camera-shake:assets/Hit.shake.hasset",
  applyAssetDocumentChange: harness.applyAssetDocumentChange,
  assetRegistry: { list: () => curves } as never,
})));
// The preview's Scene and presenter need a GPU; the panel's own loop and shake clock are under test.
vi.mock("../context/play-context", () => {
  const play = { ensureSharedEngine: () => ({}) };
  return { useOptionalPlay: () => play };
});
vi.mock("@haptic/render", () => ({
  createCameraShakePreviewScene: () => ({ setOffset: () => {}, dispose: () => {} }),
  createMaterialPreviewPresenter: () => ({ present: harness.present, dispose: () => {} }),
}));

const panel = {} as IDockviewPanelProps;
beforeEach(() => harness.applyAssetDocumentChange.mockClear());
afterEach(() => {
  cleanup();
  setEditorQuiet(false);
  harness.present.mockClear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Camera Shake Inspector", () => {
  it("switches the Pattern as one undo entry", () => {
    render(<CameraShakeDetailsPanel {...panel} />);
    fireEvent.click(screen.getByRole("combobox", { name: "Pattern" }));
    const option = screen.getByRole("option", { name: "Sine Wave" });
    fireEvent.pointerDown(option);
    fireEvent.click(option);
    expect(harness.applyAssetDocumentChange).toHaveBeenCalledExactlyOnceWith(DOC, expect.objectContaining({ pattern: "sine" }), undefined);
  });

  it("picks an Intensity Curve from the project's Float Curves only", () => {
    render(<CameraShakeDetailsPanel {...panel} />);
    fireEvent.click(screen.getByTestId("property-row-intensityCurveGuid").querySelector("button")!);
    expect(screen.queryByText("Path")).toBeNull();
    fireEvent.click(screen.getByText("Fade"));
    expect(harness.applyAssetDocumentChange).toHaveBeenLastCalledWith(DOC, expect.objectContaining({ intensityCurveGuid: "fade" }), undefined);
  });
});

describe("Camera Shake Preview", () => {
  /** Browser frames on a clock the test moves; each flush runs the frames requested so far. */
  function stubFrames() {
    let now = 0;
    const frames = new Map<number, FrameRequestCallback>();
    let nextId = 1;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(nextId, callback);
      return nextId++;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    return {
      pending: () => frames.size,
      flush: (advanceMs: number) => act(() => {
        now += advanceMs;
        const queued = [...frames.values()];
        frames.clear();
        for (const callback of queued) callback(now);
      }),
    };
  }

  const stop = () => screen.getByTestId("camera-shake-preview-stop");

  it("holds a playing shake behind Play and resumes it without the time Play ran", () => {
    const frames = stubFrames();
    render(<CameraShakePreviewPanel {...panel} />);
    fireEvent.click(screen.getByTestId("camera-shake-preview-play"));
    frames.flush(100);
    frames.flush(100);
    expect(frames.pending()).toBe(1);

    act(() => setEditorQuiet(true));
    expect(frames.pending()).toBe(0);
    frames.flush(5000);

    harness.present.mockClear();
    act(() => setEditorQuiet(false));
    expect(harness.present).toHaveBeenCalledWith({ force: true });
    // The default shake lasts 0.5 s: 0.2 s ran before Play and 0.1 s after, so it still plays.
    frames.flush(100);
    expect(stop().hasAttribute("disabled")).toBe(false);
    frames.flush(100);
    frames.flush(100);
    expect(stop().hasAttribute("disabled")).toBe(true);
  });

  it("requests no frames while its window is hidden", () => {
    const frames = stubFrames();
    const listeners = new Set<(event: { isVisible: boolean }) => void>();
    const api = {
      isVisible: false,
      onDidVisibilityChange: (listener: (event: { isVisible: boolean }) => void) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
    };
    render(<CameraShakePreviewPanel {...({ api } as unknown as IDockviewPanelProps)} />);
    expect(frames.pending()).toBe(0);
    act(() => listeners.forEach((listener) => listener({ isVisible: true })));
    expect(harness.present).toHaveBeenCalledWith({ force: true });
    expect(frames.pending()).toBe(1);
  });
});

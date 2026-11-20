import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import type { DockviewPanelApi } from "dockview-react";
import { DocumentWorkspaceProvider } from "../context/document-workspace-context";
import { setEditorQuiet } from "./editor-quiet";
import { createPreviewFrameLoop, usePreviewLoopActive } from "./preview-loop";

const documents = vi.hoisted(() => ({ activeDocumentId: "model:a" as string | null }));

vi.mock("../context/document-context", async () =>
  (await import("../testing/document-context-mock")).documentContextMock(() => ({
    activeDocumentId: documents.activeDocumentId,
  })),
);

afterEach(() => {
  cleanup();
  setEditorQuiet(false);
  documents.activeDocumentId = "model:a";
  vi.unstubAllGlobals();
});

/** A dock window's API as `useDockPanelShown` reads it, with a way to show or hide the window. */
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

function inDocument(documentId: string) {
  return ({ children }: { children: ReactNode }) => (
    <DocumentWorkspaceProvider documentId={documentId}>{children}</DocumentWorkspaceProvider>
  );
}

describe("usePreviewLoopActive", () => {
  it("is active only while the window shows and no game view covers the editor", () => {
    const api = dockApi(true);
    const view = renderHook(() => usePreviewLoopActive(api as unknown as DockviewPanelApi), {
      wrapper: inDocument("model:a"),
    });
    expect(view.result.current).toBe(true);
    act(() => api.show(false));
    expect(view.result.current).toBe(false);
    act(() => api.show(true));
    expect(view.result.current).toBe(true);
    // Play or Preview Build covers the editor.
    act(() => setEditorQuiet(true));
    expect(view.result.current).toBe(false);
    act(() => setEditorQuiet(false));
    expect(view.result.current).toBe(true);
  });

  it("stops while another document tab is in front", () => {
    const api = dockApi(true);
    const view = renderHook(() => usePreviewLoopActive(api as unknown as DockviewPanelApi), {
      wrapper: inDocument("model:a"),
    });
    documents.activeDocumentId = "scene:b";
    view.rerender();
    expect(view.result.current).toBe(false);
  });

  it("keeps a preview outside a dock window running until a game view covers the editor", () => {
    // A dialog or Inspector preview: no dock window and no document workspace around it.
    documents.activeDocumentId = "scene:b";
    const view = renderHook(() => usePreviewLoopActive());
    expect(view.result.current).toBe(true);
    act(() => setEditorQuiet(true));
    expect(view.result.current).toBe(false);
  });
});

describe("createPreviewFrameLoop", () => {
  function stubFrames() {
    const queued = new Map<number, FrameRequestCallback>();
    let nextId = 1;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      queued.set(nextId, callback);
      return nextId++;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => queued.delete(id));
    return {
      pending: () => queued.size,
      /** Runs the frames requested so far, as one browser frame does. */
      flush: () => {
        const callbacks = [...queued.values()];
        queued.clear();
        for (const callback of callbacks) callback(0);
      },
    };
  }

  it("requests no frame until it is active, then forces a frame before the first tick", () => {
    const frames = stubFrames();
    const calls: string[] = [];
    const loop = createPreviewFrameLoop(() => calls.push("frame"), () => calls.push("resume"));
    expect(frames.pending()).toBe(0);
    loop.setActive(true);
    expect(calls).toEqual(["resume"]);
    expect(frames.pending()).toBe(1);
    frames.flush();
    frames.flush();
    expect(calls).toEqual(["resume", "frame", "frame"]);
    expect(frames.pending()).toBe(1);
  });

  it("cancels its frame when paused and resumes with a forced frame", () => {
    const frames = stubFrames();
    const calls: string[] = [];
    const loop = createPreviewFrameLoop(() => calls.push("frame"), () => calls.push("resume"));
    loop.setActive(true);
    frames.flush();
    loop.setActive(false);
    expect(frames.pending()).toBe(0);
    frames.flush();
    expect(calls).toEqual(["resume", "frame"]);
    // Showing it again twice in a row resumes once and runs one loop.
    loop.setActive(true);
    loop.setActive(true);
    expect(frames.pending()).toBe(1);
    frames.flush();
    expect(calls).toEqual(["resume", "frame", "resume", "frame"]);
  });

  it("stops for good on dispose, even when shown again", () => {
    const frames = stubFrames();
    const frame = vi.fn();
    const resume = vi.fn();
    const loop = createPreviewFrameLoop(frame, resume);
    loop.setActive(true);
    loop.dispose();
    expect(frames.pending()).toBe(0);
    loop.setActive(true);
    expect(frames.pending()).toBe(0);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(frame).not.toHaveBeenCalled();
  });

  it("requests no further frame when a frame pauses the loop", () => {
    const frames = stubFrames();
    const loop = createPreviewFrameLoop(() => loop.setActive(false), () => {});
    loop.setActive(true);
    frames.flush();
    expect(frames.pending()).toBe(0);
  });
});

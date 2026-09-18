import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AbstractEngine } from "@babylonjs/core";
import {
  publishPlayerSceneLoading,
  waitForPlayerLoadingPaint,
} from "./scene-loading-state";

const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;
let endFrame: Set<() => void>;
const engine = {
  onEndFrameObservable: {
    add: (callback: () => void) => (endFrame.add(callback), callback),
    remove: (callback: () => void) => {
      endFrame.delete(callback);
    },
  },
} as unknown as AbstractEngine;

beforeEach(() => {
  endFrame = new Set();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames.delete(id);
  });
});

afterEach(() => {
  frames.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function flush(count: number) {
  for (let i = 0; i < count; i++) {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(performance.now());
  }
}

describe("player scene loading state", () => {
  it("publishes phase, progress and identity on the root and clears loading", () => {
    const root = document.createElement("div");
    publishPlayerSceneLoading(root, {
      sceneAssetGuid: "world",
      sceneLoadId: 3,
      phase: "Warming Shaders",
      progress: 70.4,
    });
    expect(root.dataset.sceneLoading).toBe("true");
    expect(root.dataset.sceneLoadPhase).toBe("Warming Shaders");
    expect(root.dataset.sceneLoadProgress).toBe("70");
    expect(root.dataset.sceneLoadId).toBe("3");
    publishPlayerSceneLoading(root, null);
    expect(root.dataset.sceneLoading).toBe("false");
  });

  it("acknowledges paint after one engine end-frame", async () => {
    let resolved = false;
    const paint = waitForPlayerLoadingPaint(engine, new AbortController().signal)
      .then(() => {
        resolved = true;
      });
    expect(resolved).toBe(false);
    for (const callback of [...endFrame]) callback();
    await paint;
    expect(resolved).toBe(true);
    expect(endFrame.size).toBe(0);
  });

  it("falls back to two animation frames when no end-frame fires", async () => {
    let resolved = false;
    const paint = waitForPlayerLoadingPaint(engine, new AbortController().signal)
      .then(() => {
        resolved = true;
      });
    flush(1);
    expect(resolved).toBe(false);
    flush(1);
    await paint;
    expect(resolved).toBe(true);
    expect(endFrame.size).toBe(0);
  });

  it("rejects on abort and cancels its pending frame", async () => {
    const controller = new AbortController();
    const paint = waitForPlayerLoadingPaint(engine, controller.signal);
    const rejected = expect(paint).rejects.toThrow();
    controller.abort();
    await rejected;
    expect(frames.size).toBe(0);
    expect(endFrame.size).toBe(0);
  });
});

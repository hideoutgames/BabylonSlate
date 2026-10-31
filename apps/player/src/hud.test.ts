import { describe, expect, it, vi } from "vitest";
import {
  snapshotFloatCount,
  writeSnapshotHeader,
} from "@haptic/bridge";
import {
  applyPlayerFpsSample,
  applyPlayerSnapshotTick,
  applyWorkerPlayerStats,
  mountPlayerDebuggerOverlays,
  unlockAudioOnFirstGesture,
} from "./hud";

describe("applyPlayerFpsSample", () => {
  it("sets fps without zeroing worker script, physics and publish ms", () => {
    const fromWorker = applyWorkerPlayerStats(undefined, {
      scriptMs: 3,
      physicsMs: 2,
      publishMs: 0.5,
      liveActors: 300,
      snapshotCapacity: 512,
    });
    expect(fromWorker.fps).toBe(0);
    const afterFps = applyPlayerFpsSample(fromWorker, 60);
    expect(afterFps.fps).toBe(60);
    expect(afterFps.scriptMs).toBe(3);
    expect(afterFps.physicsMs).toBe(2);
    expect(afterFps.publishMs).toBe(0.5);
    expect(afterFps.ticks).toBe(0);
    expect(afterFps.liveActors).toBe(300);
    expect(afterFps.snapshotCapacity).toBe(512);
  });
});

describe("applyWorkerPlayerStats", () => {
  it("keeps rendered FPS when worker timing updates arrive afterward", () => {
    const rendered = applyPlayerFpsSample(undefined, 30);
    const next = applyWorkerPlayerStats(rendered, {
      fps: 60,
      scriptMs: 4,
      physicsMs: 2,
      ticks: 99,
    });
    expect(next).toMatchObject({ fps: 30, scriptMs: 4, physicsMs: 2, ticks: 99 });
  });

  it("keeps sampled fps when the worker command reports 0", () => {
    const sampled = applyPlayerFpsSample(
      { ticks: 12, fps: 60, scriptMs: 1, physicsMs: 1, draws: 4 },
      48,
    );
    const next = applyWorkerPlayerStats(sampled, {
      ticks: 13,
      fps: 0,
      scriptMs: 4,
      physicsMs: 5,
    });
    expect(next.fps).toBe(48);
    expect(next.ticks).toBe(13);
    expect(next.scriptMs).toBe(4);
    expect(next.physicsMs).toBe(5);
  });
});

describe("applyPlayerSnapshotTick", () => {
  it("keeps worker tickIndex from the snapshot when stats are sparse", () => {
    const unpublished = new Float32Array(snapshotFloatCount(1));
    expect(applyPlayerSnapshotTick(7, unpublished)).toBe(7);
    const published = new Float32Array(snapshotFloatCount(1));
    writeSnapshotHeader(published, {
      frameId: 3,
      tickIndex: 40,
      actorCount: 0,
      scriptMs: 1,
      physicsMs: 1,
    });
    expect(applyPlayerSnapshotTick(7, published)).toBe(40);
  });
});

describe("unlockAudioOnFirstGesture", () => {
  it("unlocks on the first pointerdown or touchstart", () => {
    const listeners = new Map<string, () => void>();
    const target = {
      addEventListener: (type: string, fn: EventListenerOrEventListenerObject) => {
        if (typeof fn === "function") listeners.set(type, fn as () => void);
      },
      removeEventListener: (type: string) => {
        listeners.delete(type);
      },
    };
    const unlocks: string[] = [];
    const release = unlockAudioOnFirstGesture(() => unlocks.push("unlock"), target);
    listeners.get("pointerdown")?.();
    listeners.get("touchstart")?.();
    expect(unlocks).toEqual(["unlock", "unlock"]);
    release();
    expect(listeners.has("pointerdown")).toBe(false);
    expect(listeners.has("touchstart")).toBe(false);
  });

  it("binds unlock to the game canvas instead of the window", () => {
    const windowListeners = new Map<string, () => void>();
    const canvasListeners = new Map<string, () => void>();
    const canvas = {
      addEventListener: (type: string, fn: EventListenerOrEventListenerObject) => {
        if (typeof fn === "function") canvasListeners.set(type, fn as () => void);
      },
      removeEventListener: (type: string) => {
        canvasListeners.delete(type);
      },
    };
    const unlocks: string[] = [];
    const release = unlockAudioOnFirstGesture(() => unlocks.push("unlock"), canvas);
    expect(windowListeners.size).toBe(0);
    canvasListeners.get("pointerdown")?.();
    expect(unlocks).toEqual(["unlock"]);
    release();
    expect(canvasListeners.has("pointerdown")).toBe(false);
  });
});

describe("mountPlayerDebuggerOverlays", () => {
  it("shows the occlusion overlay's caption while showocclusion is on, its canvas only while culling, and removes it when off", () => {
    let frame: FrameRequestCallback | undefined;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { frame = callback; return 1; });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    // jsdom has no 2D context; the overlay draws nothing then, and its caption still shows.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    let overlay: ReturnType<NonNullable<Parameters<typeof mountPlayerDebuggerOverlays>[1]["occlusionOverlay"]>> = {
      buffer: { width: 2, height: 1, depth: new Float32Array([4, Infinity]) }, text: "occlusion culled 3/9 · 1 occluders",
    };
    const parent = document.createElement("div");
    const stop = mountPlayerDebuggerOverlays(parent, { bundleDebugger: true, occlusionOverlay: () => overlay });
    const element = () => parent.querySelector<HTMLElement>("[data-testid=occlusion-debug-overlay]");
    frame!(0);
    expect(element()?.textContent).toBe("occlusion culled 3/9 · 1 occluders");
    expect(element()?.querySelector("canvas")?.style.display).toBe("block");
    overlay = { buffer: null, text: "occlusion culling off" };
    frame!(0);
    expect(element()?.textContent).toBe("occlusion culling off");
    expect(element()?.querySelector("canvas")?.style.display).toBe("none");
    overlay = null;
    frame!(0);
    expect(element()).toBeNull();
    stop();
    vi.restoreAllMocks();
  });
});

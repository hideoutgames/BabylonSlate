import { describe, expect, it, vi } from "vitest";
import { NullEngine } from "@babylonjs/core";
import { HardwareScalingController } from "./hardware-scaling";
import { applyPlayConsoleRenderCommand } from "./play-console-apply";

describe("play console rendering", () => {
  it("uses the chosen resolution bounds and leaves fixed scaling unchanged under load", () => {
    const engine = new NullEngine();
    const scaling = new HardwareScalingController(engine);
    scaling.configureQuality({ scale: 0.75, minScale: 0.5, targetFps: 60, dynamic: true });
    expect(scaling.getLevel()).toBeCloseTo(4 / 3);
    for (let i = 0; i < 100; i++) scaling.noteFramePressure({ presentationMs: null, cpuMs: 100, gpuMs: null });
    expect(scaling.getLevel()).toBe(2);
    scaling.configureQuality({ scale: 1, minScale: 1, targetFps: 60, dynamic: false });
    for (let i = 0; i < 100; i++) scaling.noteFramePressure({ presentationMs: null, cpuMs: 100, gpuMs: null });
    expect(scaling.getLevel()).toBe(1);
    engine.dispose();
  });
  it("applies frame caps without consuming unrelated commands", () => {
    const setFrameCap = vi.fn();
    expect(applyPlayConsoleRenderCommand({ scheduler: { setFrameCap } }, { type: "setFrameCap", fps: 30 })).toBe(true);
    expect(setFrameCap).toHaveBeenCalledWith(30);
    expect(applyPlayConsoleRenderCommand({ scheduler: { setFrameCap } }, { type: "setGlobalVolume", volume: 0.5 })).toBe(false);
  });
});

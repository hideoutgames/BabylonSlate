import { describe, expect, it, vi } from "vitest";
import { NullEngine } from "@babylonjs/core";
import { HardwareScalingController } from "./hardware-scaling";
import {
  applyPlayConsoleRenderCommand,
  applyPlayRenderQuality,
  applyPlayResolutionScale,
  hardwareScaleForQuality,
} from "./play-console-apply";

describe("play console render apply", () => {
  it("maps quality onto the 1..2 hardware-scaling ladder", () => {
    expect(hardwareScaleForQuality("high")).toBe(1);
    expect(hardwareScaleForQuality("medium")).toBe(1.5);
    expect(hardwareScaleForQuality("low")).toBe(2);
  });

  it("applies renderquality as the Play scaling floor", () => {
    const engine = new NullEngine();
    const scaling = new HardwareScalingController(engine, {
      minLevel: 1,
      maxLevel: 2,
      initialLevel: 1,
    });
    expect(applyPlayRenderQuality(scaling, "medium")).toBe(1.5);
    expect(scaling.getLevel()).toBe(1.5);
    applyPlayRenderQuality(scaling, "low");
    expect(scaling.getLevel()).toBe(2);
    applyPlayRenderQuality(scaling, "high");
    expect(scaling.getLevel()).toBe(1);
    engine.dispose();
  });

  it("applies resolutionscale and framecap from console commands", () => {
    const engine = new NullEngine();
    const scaling = new HardwareScalingController(engine, {
      minLevel: 1,
      maxLevel: 2,
      initialLevel: 1,
    });
    const setFrameCap = vi.fn();
    applyPlayResolutionScale(scaling, 1.25);
    expect(scaling.getLevel()).toBe(1.25);
    applyPlayResolutionScale(scaling, 0.25);
    expect(scaling.getLevel()).toBe(1);
    const wide = new HardwareScalingController(engine, {
      minLevel: 1,
      maxLevel: 4,
      initialLevel: 1,
    });
    applyPlayResolutionScale(wide, 8);
    expect(wide.getLevel()).toBe(2);
    expect(
      applyPlayConsoleRenderCommand(
        { scaling, scheduler: { setFrameCap } },
        { type: "setFrameCap", fps: 30 },
      ),
    ).toBe(true);
    expect(setFrameCap).toHaveBeenCalledWith(30);
    expect(
      applyPlayConsoleRenderCommand(
        { scaling, scheduler: { setFrameCap } },
        { type: "setRenderQuality", level: "low" },
      ),
    ).toBe(true);
    expect(scaling.getLevel()).toBe(2);
    applyPlayRenderQuality(scaling, "high");
    expect(
      applyPlayConsoleRenderCommand(
        { scaling, scheduler: { setFrameCap } },
        { type: "setResolutionScale", scale: 1.5 },
      ),
    ).toBe(true);
    expect(scaling.getLevel()).toBe(1.5);
    expect(
      applyPlayConsoleRenderCommand(
        { scaling, scheduler: { setFrameCap } },
        { type: "setGlobalVolume", volume: 0.2 },
      ),
    ).toBe(false);
    engine.dispose();
  });
});

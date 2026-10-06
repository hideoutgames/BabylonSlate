import { describe, expect, it, vi } from "vitest";
import { NullEngine } from "@babylonjs/core";
import {
  HardwareScalingController,
  type FramePressureSample,
} from "./hardware-scaling";

function controller(
  options: Partial<ConstructorParameters<typeof HardwareScalingController>[1]> = {},
): HardwareScalingController {
  const engine = {
    setHardwareScalingLevel: vi.fn(),
  } as unknown as NullEngine;
  return new HardwareScalingController(engine, {
    minLevel: 1,
    maxLevel: 4,
    cooldownFrames: 0,
    initialLevel: 1,
    targetFrameMs: 1000 / 60,
    ...options,
  });
}

function sample(
  presentationMs: number | null,
  cpuMs: number,
  gpuMs: number | null = null,
): FramePressureSample {
  return { presentationMs, cpuMs, gpuMs };
}

describe("frame pressure scaling", () => {
  it("scales down on presentation pressure even when CPU time is cheap", () => {
    // GPU-bound devices report low render-call CPU while the display drops
    // frames — the presented interval is what exposes the pressure.
    const scaling = controller();
    for (let i = 0; i < 5; i++) scaling.noteFramePressure(sample(33, 3));
    expect(scaling.getLevel()).toBe(1.25);
  });

  it("scales down on CPU-bound frames", () => {
    const scaling = controller();
    for (let i = 0; i < 5; i++) scaling.noteFramePressure(sample(33, 25));
    expect(scaling.getLevel()).toBe(1.25);
  });

  it("scales down on an attributed GPU cost", () => {
    const scaling = controller();
    for (let i = 0; i < 5; i++) scaling.noteFramePressure(sample(16.7, 3, 40));
    expect(scaling.getLevel()).toBe(1.25);
  });

  it("climbs back when presentation sits at target and CPU leaves headroom", () => {
    const scaling = controller({ initialLevel: 2 });
    for (let i = 0; i < 5; i++) scaling.noteFramePressure(sample(16.7, 4));
    expect(scaling.getLevel()).toBe(1.75);
  });

  it("scales up only after the cooldown once recovery holds", () => {
    const scaling = controller({ cooldownFrames: 30 });
    for (let i = 0; i < 5; i++) scaling.noteFramePressure(sample(40, 40));
    expect(scaling.getLevel()).toBe(1.25);
    for (let i = 0; i < 30; i++) scaling.noteFramePressure(sample(16.7, 4));
    expect(scaling.getLevel()).toBe(1.25);
    scaling.noteFramePressure(sample(16.7, 4));
    expect(scaling.getLevel()).toBe(1);
  });

  it("never climbs while presentation intervals are partially unknown", () => {
    // Skipped/capped frames report null — a window mixing known and unknown
    // intervals cannot prove the display kept up.
    const scaling = controller({ initialLevel: 2 });
    for (let i = 0; i < 20; i++)
      scaling.noteFramePressure(sample(i % 3 === 0 ? null : 16.7, 4));
    expect(scaling.getLevel()).toBe(2);
  });

  it("falls back to cost headroom for views that never report presentation", () => {
    // Free-running editor viewports feed cpuMs only: an all-unknown window is
    // the cpu-only input contract, not missing evidence, so headroom can climb.
    const scaling = controller({ initialLevel: 2 });
    for (let i = 0; i < 5; i++) scaling.noteFramePressure(sample(null, 4));
    expect(scaling.getLevel()).toBe(1.75);
  });

  it("still scales down on cpu-bound frames without presentation evidence", () => {
    const scaling = controller();
    for (let i = 0; i < 5; i++) scaling.noteFramePressure(sample(null, 25));
    expect(scaling.getLevel()).toBe(1.25);
  });

  it("never climbs while presentation runs below the target cadence", () => {
    const scaling = controller({ initialLevel: 2 });
    for (let i = 0; i < 20; i++) scaling.noteFramePressure(sample(18, 4));
    expect(scaling.getLevel()).toBe(2);
  });

  it("lets a known healthy GPU share the scale-up decision", () => {
    const scaling = controller({ initialLevel: 2 });
    for (let i = 0; i < 5; i++) scaling.noteFramePressure(sample(16.7, 4, 10));
    expect(scaling.getLevel()).toBe(1.75);
  });

  it("blocks scale-up while a known GPU still lacks headroom", () => {
    const scaling = controller({ initialLevel: 2 });
    for (let i = 0; i < 20; i++) scaling.noteFramePressure(sample(16.7, 4, 15));
    expect(scaling.getLevel()).toBe(2);
  });

  it("respects the minimum level on recovered frames", () => {
    const scaling = controller({ minLevel: 1, initialLevel: 1 });
    for (let i = 0; i < 10; i++) scaling.noteFramePressure(sample(16.7, 4));
    expect(scaling.getLevel()).toBe(1);
  });

  it("respects the maximum level under sustained pressure", () => {
    const scaling = controller({ maxLevel: 2 });
    for (let i = 0; i < 30; i++) scaling.noteFramePressure(sample(40, 40));
    expect(scaling.getLevel()).toBe(2);
  });
});

describe("Engine Settings floor", () => {
  it("raises the floor when Engine Settings hardware scaling changes so the valve cannot hunt back", () => {
    const scaling = controller({ targetFrameMs: 1000 / 30 });
    scaling.setSettingsLevel(2);
    expect(scaling.getLevel()).toBe(2);
    for (let i = 0; i < 20; i++) scaling.noteFramePressure(sample(null, 4));
    expect(scaling.getLevel()).toBe(2);
  });

  it("noteRestore returns to the Engine Settings floor and clears hitch samples", () => {
    const scaling = controller();
    scaling.setLevel(1.25);
    expect(scaling.getLevel()).toBe(1.25);
    scaling.noteRestore();
    expect(scaling.getLevel()).toBe(1);
    for (let i = 0; i < 4; i++) scaling.noteFramePressure(sample(null, 200));
    expect(scaling.getLevel()).toBe(1);
  });
});

describe("quality resolution bounds", () => {
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
});

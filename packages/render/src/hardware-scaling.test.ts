import { describe, expect, it, vi } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
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

describe("scaling target", () => {
  it("sends every level to `apply` and leaves the Engine's hardware scaling alone", () => {
    const setHardwareScalingLevel = vi.fn();
    const applied: number[] = [];
    const scaling = new HardwareScalingController({ setHardwareScalingLevel } as unknown as NullEngine, {
      minLevel: 1, maxLevel: 4, cooldownFrames: 0, initialLevel: 1.5, apply: (level) => applied.push(level),
    });
    for (let i = 0; i < 5; i++) scaling.noteFramePressure(sample(33, 3));
    scaling.setSettingsLevel(3);
    expect(applied).toEqual([1.5, 1.75, 3]);
    expect(setHardwareScalingLevel).not.toHaveBeenCalled();
  });
});

describe("raise backoff", () => {
  /** iPad at a 60 fps cap with no GPU timer: full resolution costs 19.9 ms, one step down is capped at 16.7 ms. */
  function capped(level: number): FramePressureSample {
    return sample(level === 1 ? 19.9 : 16.7, 4);
  }

  function run(scaling: HardwareScalingController, frames: number, frame: (level: number) => FramePressureSample): number {
    let changes = 0;
    for (let i = 0; i < frames; i++) {
      const before = scaling.getLevel();
      scaling.noteFramePressure(frame(before));
      if (scaling.getLevel() !== before) changes += 1;
    }
    return changes;
  }

  it("settles at the lower level instead of flipping when only that level fits", () => {
    const scaling = controller({ cooldownFrames: 30 });
    // Without backoff this load flips every ~31 frames: about 20 changes per 600 frames, about 100 per 3000.
    expect(run(scaling, 600, capped)).toBeLessThanOrEqual(10);
    // The wait doubles to its cap of 16 cooldowns, so one raise attempt every ~9 s at most.
    expect(run(scaling, 2400, capped)).toBeLessThanOrEqual(10);
  });

  it("does not ratchet down under recurring hitches the resolution does not cause", () => {
    // Full resolution fits; 8 frames of 25 ms every second are hitches that no level would remove.
    const scaling = controller({ cooldownFrames: 30, maxLevel: 2 });
    let lowest = 1;
    for (let frame = 0; frame < 3600; frame++) {
      scaling.noteFramePressure(frame % 60 < 8 ? sample(25, 4) : sample(16.7, 4));
      lowest = Math.max(lowest, scaling.getLevel());
    }
    expect(lowest).toBeLessThanOrEqual(1.25);
  });

  it("retries a level after one cooldown once the level below it has held", () => {
    // Levels 1 and 1.25 fit only 1.5 at first, which drives the wait to its cap.
    let fits = 1.5;
    const frame = (level: number) => sample(level < fits ? 19.9 : 16.7, 4);
    const scaling = controller({ cooldownFrames: 30 });
    run(scaling, 1500, frame);
    // Now 1.25 fits: the raise to it holds, so the next raise to 1 starts a fresh backoff.
    fits = 1.25;
    const changes: { frame: number; level: number }[] = [];
    for (let i = 0; i < 2000; i++) {
      const before = scaling.getLevel();
      scaling.noteFramePressure(frame(before));
      if (scaling.getLevel() !== before) changes.push({ frame: i, level: scaling.getLevel() });
    }
    const firstAtOne = changes.findIndex((change) => change.level === 1);
    expect(changes[firstAtOne + 1]?.level).toBe(1.25);
    const retry = changes[firstAtOne + 2]!;
    expect(retry.level).toBe(1);
    expect(retry.frame - changes[firstAtOne + 1]!.frame).toBeLessThanOrEqual(65);
  });

  it.each([
    ["configureQuality", (scaling: HardwareScalingController) =>
      scaling.configureQuality({ scale: 1, minScale: 0.25, targetFps: 60, dynamic: true })],
    ["setSettingsLevel", (scaling: HardwareScalingController) => scaling.setSettingsLevel(1)],
    ["noteRestore", (scaling: HardwareScalingController) => scaling.noteRestore()],
  ] as const)("starts a fresh backoff after %s", (_name, reset) => {
    const scaling = controller({ cooldownFrames: 30 });
    // Build the wait to its cap, then reset just after a raise, when the next drop would double it again.
    run(scaling, 600, capped);
    for (let i = 0; i < 600 && scaling.getLevel() !== 1; i++) scaling.noteFramePressure(capped(scaling.getLevel()));
    expect(scaling.getLevel()).toBe(1);
    reset(scaling);
    const changes: number[] = [];
    for (let i = 0; i < 200; i++) {
      const before = scaling.getLevel();
      scaling.noteFramePressure(capped(before));
      if (scaling.getLevel() !== before) changes.push(i);
    }
    // Drop, then the first raise back after one cooldown, not after the 480-frame wait built before.
    expect(changes.length).toBeGreaterThanOrEqual(2);
    expect(changes[1]! - changes[0]!).toBeLessThanOrEqual(35);
  });

  it("clears the backoff once a raise holds, so a later drop recovers after one cooldown", () => {
    const scaling = controller({ cooldownFrames: 30 });
    run(scaling, 600, capped);
    // The load gets lighter: full resolution fits, so the next raise holds.
    run(scaling, 1000, () => sample(16.7, 4));
    expect(scaling.getLevel()).toBe(1);
    // One unrelated spike drops a level well after that raise; recovery waits only the cooldown.
    for (let i = 0; i < 8; i++) scaling.noteFramePressure(sample(40, 4));
    expect(scaling.getLevel()).toBe(1.25);
    for (let i = 0; i < 31; i++) scaling.noteFramePressure(sample(16.7, 4));
    expect(scaling.getLevel()).toBe(1);
  });

  it("reads each sample's values when noted, so the caller may reuse one sample object", () => {
    const scaling = controller();
    const reused = sample(33, 4);
    for (let i = 0; i < 4; i++) scaling.noteFramePressure(reused);
    // Four heavy frames and one light one: the window's median is still heavy.
    Object.assign(reused, sample(16.7, 4));
    scaling.noteFramePressure(reused);
    expect(scaling.getLevel()).toBe(1.25);
  });

  it("decides without allocating or sorting arrays on each frame", () => {
    const scaling = controller({ initialLevel: 2 });
    const sort = vi.spyOn(Array.prototype, "sort");
    const map = vi.spyOn(Array.prototype, "map");
    // Over a full window, through a raise (the climb back) and the GPU median it reads.
    for (let i = 0; i < 15; i++) scaling.noteFramePressure(sample(16.7, 4, i % 2 ? 4 : null));
    expect(scaling.getLevel()).toBe(1);
    expect(sort).not.toHaveBeenCalled();
    expect(map).not.toHaveBeenCalled();
    sort.mockRestore();
    map.mockRestore();
  });
});


import { describe, expect, it, vi } from "vitest";
import type { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { HardwareScalingController } from "./hardware-scaling";

function controller(initialLevel?: number) {
  const setHardwareScalingLevel = vi.fn();
  const scaling = new HardwareScalingController({ setHardwareScalingLevel } as unknown as NullEngine, { initialLevel });
  return { scaling, applied: () => setHardwareScalingLevel.mock.calls.map(([level]) => level as number) };
}

describe("static resolution level", () => {
  it("applies the initial level, then 1 / Resolution Scale, and only when the level changes", () => {
    const { scaling, applied } = controller(1.5);
    scaling.configureQuality({ scale: 0.5 });
    scaling.configureQuality({ scale: 0.5, preset: "custom" });
    scaling.configureQuality({ scale: 1 });
    expect(applied()).toEqual([1.5, 2, 1]);
    expect(scaling.getLevel()).toBe(1);
  });

  it("lets the last of Resolution Scale and Engine Settings decide the level", () => {
    const { scaling } = controller();
    scaling.configureQuality({ scale: 0.8 });
    expect(scaling.getLevel()).toBe(1.25);
    // Engine Settings may draw sharper or coarser than the scale.
    scaling.setSettingsLevel(1);
    expect(scaling.getLevel()).toBe(1);
    scaling.setSettingsLevel(2);
    expect(scaling.getLevel()).toBe(2);
    scaling.configureQuality({ scale: 0.5 });
    expect(scaling.getLevel()).toBe(2);
    scaling.configureQuality({ scale: 0.8 });
    expect(scaling.getLevel()).toBe(1.25);
  });

  it("ignores an invalid Engine Settings level and caps a coarse one at a quarter resolution", () => {
    const { scaling } = controller(1.5);
    for (const level of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) scaling.setSettingsLevel(level);
    expect(scaling.getLevel()).toBe(1.5);
    scaling.setSettingsLevel(6);
    expect(scaling.getLevel()).toBe(4);
  });

  it("sends every level to `apply` and leaves the Engine's hardware scaling alone", () => {
    const setHardwareScalingLevel = vi.fn();
    const applied: number[] = [];
    const scaling = new HardwareScalingController({ setHardwareScalingLevel } as unknown as NullEngine, {
      initialLevel: 1.5, apply: (level) => applied.push(level),
    });
    scaling.configureQuality({ scale: 0.8 });
    scaling.setSettingsLevel(3);
    expect(applied).toEqual([1.5, 1.25, 3]);
    expect(setHardwareScalingLevel).not.toHaveBeenCalled();
  });
});

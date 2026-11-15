import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractAnimationRootMotion, normalizeAnimationRootMotion, rootMotionAt } from "./animation-root-motion";

const kaykit = (file: string) => new Uint8Array(readFileSync(new URL(`../../../engine-content/kaykit-assets/Adventurers/${file}`, import.meta.url)));

describe("root motion extraction", () => {
  it("samples the hips' travel across the ground in a clip that moves", () => {
    const motion = extractAnimationRootMotion(kaykit("Rig_Medium_General.glb"), "Death_A", "hips");
    expect(motion?.bone).toBe("hips");
    const track = motion!.track;
    expect(track.x[0]).toBe(0);
    expect(track.z[0]).toBe(0);
    // Death_A falls back 0.45 along the file's Z; it does not turn.
    expect(track.z[track.z.length - 1]).toBeCloseTo(-0.45, 2);
    expect(Math.abs(track.x[track.x.length - 1]!)).toBeLessThan(0.01);
    expect(Math.max(...track.yaw.map(Math.abs))).toBeLessThan(1);
    expect(track.x).toHaveLength(Math.ceil(track.durationMs / track.stepMs) + 1);
  });

  it("finds no travel in an in-place cycle, and nothing for a missing clip or bone", () => {
    const walk = extractAnimationRootMotion(kaykit("Rig_Medium_MovementBasic.glb"), "Walking_A", "hips")!;
    expect(Math.max(...walk.track.z.map(Math.abs), ...walk.track.x.map(Math.abs))).toBeLessThan(1e-3);
    expect(extractAnimationRootMotion(kaykit("Rig_Medium_MovementBasic.glb"), "Nope", "hips")).toBeNull();
    expect(extractAnimationRootMotion(kaykit("Rig_Medium_MovementBasic.glb"), "Walking_A", "tail")).toBeNull();
  });

  it("reads a track between samples and cleans a stored one", () => {
    const track = { durationMs: 100, stepMs: 50, x: [0, 1, 3], z: [0, 0, 0], yaw: [0, 10, 20] };
    expect(rootMotionAt(track, 75)).toEqual({ x: 2, z: 0, yaw: 15 });
    expect(rootMotionAt(track, 500)).toEqual({ x: 3, z: 0, yaw: 20 });
    expect(normalizeAnimationRootMotion({ bone: " hips ", track })).toEqual({ bone: "hips", track });
    expect(normalizeAnimationRootMotion({ bone: "", track })).toBeUndefined();
    expect(normalizeAnimationRootMotion({ bone: "hips", track: { ...track, durationMs: 0 } })).toBeUndefined();
  });
});

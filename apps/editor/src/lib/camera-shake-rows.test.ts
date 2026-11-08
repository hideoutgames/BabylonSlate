import { describe, expect, it, vi } from "vitest";
import { createDefaultCameraShakePayload, type CameraShakePayload } from "@haptic/core";
import { cameraShakeDetailRows } from "./camera-shake-rows";

const ids = (shake: CameraShakePayload) => cameraShakeDetailRows(shake, () => {}, () => {}, () => undefined).map((row) => row.id);

describe("Camera Shake Inspector rows", () => {
  it("shows the wave channels for Perlin Noise and Sine Wave and the curves for Curves", () => {
    const shake = createDefaultCameraShakePayload();
    const common = ["pattern", "duration", "blendInTime", "blendOutTime"];
    expect(ids(shake)).toEqual([...common, "locationAmplitude", "locationFrequency", "rotationAmplitude", "rotationFrequency",
      "fovAmplitude", "fovFrequency", "intensityCurveGuid"]);
    expect(ids({ ...shake, pattern: "sine" })).toEqual(ids(shake));
    expect(ids({ ...shake, pattern: "curves" })).toEqual([...common, "locationCurveGuid", "rotationCurveGuid", "fovCurveGuid", "intensityCurveGuid"]);
  });

  it("commits each edit into the payload and opens the picker for the curve field", () => {
    const shake = { ...createDefaultCameraShakePayload(), pattern: "curves" as const, rotationCurveGuid: "spin" };
    const commit = vi.fn();
    const pick = vi.fn();
    const rows = cameraShakeDetailRows(shake, commit, pick, (guid) => guid === "spin" ? "Spin" : undefined);
    const byId = (id: string) => rows.find((row) => row.id === id)!;
    (byId("duration") as { onChange(value: number): void }).onChange(2);
    expect(commit).toHaveBeenLastCalledWith({ ...shake, duration: 2 }, "duration");
    expect(byId("rotationCurveGuid")).toMatchObject({ value: "spin", displayLabel: "Spin", assetTypes: ["VectorCurve"] });
    (byId("fovCurveGuid") as { onPick(): void }).onPick();
    expect(pick).toHaveBeenCalledWith("fovCurveGuid");
    (byId("rotationCurveGuid") as { onChange(value: string | null): void }).onChange(null);
    expect(commit).toHaveBeenLastCalledWith({ ...shake, rotationCurveGuid: null });
    const noise = cameraShakeDetailRows(createDefaultCameraShakePayload(), commit, pick, () => undefined);
    (noise.find((row) => row.id === "rotationAmplitude") as { onChange(value: number[]): void }).onChange([1, 2, 3]);
    expect(commit.mock.lastCall![0].rotationAmplitude).toEqual({ pitch: 1, yaw: 2, roll: 3 });
  });
});

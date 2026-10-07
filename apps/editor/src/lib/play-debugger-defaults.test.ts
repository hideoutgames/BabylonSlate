import { describe, expect, it } from "vitest";
import {
  nextPlayInspectorOpen,
  playDebuggerOverlayFromSettings,
  profileDefaultsFromSettings,
  simulationDefaultsFromSettings,
} from "./play-debugger-defaults";

describe("playDebuggerOverlayFromSettings", () => {
  it("keeps overlay chrome on when saved defaults omit the new fields", () => {
    expect(
      playDebuggerOverlayFromSettings({ pauseOnPlay: true }),
    ).toEqual({
      overlayStats: true,
      overlayConsole: true,
      overlayInspector: true,
      pauseOnPlay: true,
    });
  });

  it("honors explicit overlay chrome off", () => {
    expect(
      playDebuggerOverlayFromSettings({
        overlayStats: false,
        overlayConsole: false,
        overlayInspector: false,
        pauseOnPlay: false,
      }),
    ).toEqual({
      overlayStats: false,
      overlayConsole: false,
      overlayInspector: false,
      pauseOnPlay: false,
    });
  });
});

it("snapshots Simulation preferences and bounds explicit recording defaults", () => {
  const saved = { keepSimulationChanges: true, graphObservation: false };
  const launch = simulationDefaultsFromSettings(saved);
  saved.keepSimulationChanges = false;
  expect(launch.keepChanges).toBe(true);
  expect(Object.isFrozen(launch)).toBe(true);
  expect(simulationDefaultsFromSettings()).toEqual({ keepChanges: false, graphObservation: false });
  expect(profileDefaultsFromSettings()).toEqual({ durationMs: 10_000, byteBudget: 16 * 1024 * 1024, gpuTiming: false });
  expect(profileDefaultsFromSettings({ profileDurationSeconds: Infinity, profileByteBudget: 1 })).toMatchObject({ durationMs: 10_000, byteBudget: 4 * 1024 * 1024 });
});

describe("nextPlayInspectorOpen", () => {
  it("closes the inspector dialog when Debug Overlay Inspector is unchecked", () => {
    expect(nextPlayInspectorOpen(true, false)).toBe(false);
    expect(nextPlayInspectorOpen(false, false)).toBe(false);
  });

  it("keeps the dialog closed until the overlay Inspector toggle opens it", () => {
    expect(nextPlayInspectorOpen(false, true)).toBe(false);
    expect(nextPlayInspectorOpen(true, true)).toBe(true);
  });
});

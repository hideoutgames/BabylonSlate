import { describe, expect, it } from "vitest";
import { DEFAULT_RENDER_PROJECT_SETTINGS } from "@babylonslate/core";
import { INFINITE_LOOP_DIAGNOSTIC_CODE } from "@babylonslate/debugger";
import type { GameManifest } from "@babylonslate/exporter";
import {
  loopGuardLoadFields,
  shouldHaltPlayerOnDiagnostic,
} from "./debug-load";

function manifest(partial: Partial<GameManifest>): GameManifest {
  return {
    startupSceneGuid: "scene-1",
    bundleDebugger: false,
    mode: "packed",
    render: DEFAULT_RENDER_PROJECT_SETTINGS,
    playFrameCap: 60,
    pixelsPerUnit: 100,
    pixelPerfect: false,
    packs: [],
    scriptsFile: "scripts.js",
    physicsWorld: "3d",
    assets: [],
    ...partial,
  };
}

describe("loopGuardLoadFields", () => {
  it("omits loop settings when the debugger is not bundled", () => {
    expect(loopGuardLoadFields(manifest({ bundleDebugger: false }))).toEqual({
      includeDebugCommands: false,
    });
  });

  it("forwards live loop settings when the debugger is bundled", () => {
    expect(
      loopGuardLoadFields(
        manifest({
          bundleDebugger: true,
          infiniteLoopDetection: false,
          loopCount: 50,
        }),
      ),
    ).toEqual({
      includeDebugCommands: true,
      infiniteLoopDetection: false,
      loopCount: 50,
    });
  });
});

describe("shouldHaltPlayerOnDiagnostic", () => {
  it("stops the player rAF only for infinite loops", () => {
    expect(shouldHaltPlayerOnDiagnostic(INFINITE_LOOP_DIAGNOSTIC_CODE)).toBe(
      true,
    );
    expect(shouldHaltPlayerOnDiagnostic("runtime.uncaught")).toBe(false);
  });
});

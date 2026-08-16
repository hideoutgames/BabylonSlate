import { INFINITE_LOOP_DIAGNOSTIC_CODE } from "@babylonslate/debugger";
import type { GameManifest } from "@babylonslate/exporter";

export function loopGuardLoadFields(manifest: GameManifest): {
  includeDebugCommands: boolean;
  infiniteLoopDetection?: boolean;
  loopCount?: number;
} {
  if (!manifest.bundleDebugger) {
    return { includeDebugCommands: false };
  }
  return {
    includeDebugCommands: true,
    infiniteLoopDetection: manifest.infiniteLoopDetection !== false,
    loopCount: manifest.loopCount,
  };
}

export function shouldHaltPlayerOnDiagnostic(code: unknown): boolean {
  return code === INFINITE_LOOP_DIAGNOSTIC_CODE;
}

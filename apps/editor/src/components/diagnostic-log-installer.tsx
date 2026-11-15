import { useEffect } from "react";
import { installGlErrorTrace } from "@haptic/render/gl-error-trace";
import { useDebugMode, useGraphicsErrorTrace } from "../context/app-settings-context";
import { installDiagnosticLog } from "../lib/diagnostic-info";
import { gitBenchmarkAvailable, installGitBenchmark } from "../lib/git-benchmark-hook";

/**
 * In Debug Mode, keeps recent console errors and warnings (and, when enabled, WebGL call
 * failures) for copied reports, and on iOS and Android offers the Git benchmark to the console.
 */
export function DiagnosticLogInstaller() {
  const debugMode = useDebugMode();
  const traceGraphics = useGraphicsErrorTrace();
  useEffect(() => (debugMode ? installDiagnosticLog() : undefined), [debugMode]);
  useEffect(() => (traceGraphics ? installGlErrorTrace() : undefined), [traceGraphics]);
  useEffect(() => (debugMode && gitBenchmarkAvailable() ? installGitBenchmark() : undefined), [debugMode]);
  return null;
}

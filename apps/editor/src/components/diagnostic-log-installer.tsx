import { useEffect } from "react";
import { installGlErrorTrace } from "@babylonslate/render";
import { useDebugMode, useGraphicsErrorTrace } from "../context/app-settings-context";
import { installDiagnosticLog } from "../lib/diagnostic-info";

/** In Debug Mode, keeps recent console errors and warnings (and, when enabled, WebGL call failures) for copied reports. */
export function DiagnosticLogInstaller() {
  const debugMode = useDebugMode();
  const traceGraphics = useGraphicsErrorTrace();
  useEffect(() => (debugMode ? installDiagnosticLog() : undefined), [debugMode]);
  useEffect(() => (traceGraphics ? installGlErrorTrace() : undefined), [traceGraphics]);
  return null;
}

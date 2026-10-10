import { useEffect } from "react";
import { useDebugMode } from "../context/app-settings-context";
import { installDiagnosticLog } from "../lib/diagnostic-info";

/** In Debug Mode, keeps recent console errors and warnings for copied reports. */
export function DiagnosticLogInstaller() {
  const debugMode = useDebugMode();
  useEffect(() => (debugMode ? installDiagnosticLog() : undefined), [debugMode]);
  return null;
}

import { TooltipProvider } from "@haptic/ui/components/tooltip";
import { DocumentProvider } from "./context/document-context";
import { AppSettingsProvider } from "./context/app-settings-context";
import { EditorThemeProvider } from "./context/theme-context";
import { AppRoutes } from "./app-routes";
import { DiagnosticLogInstaller } from "./components/diagnostic-log-installer";
import { GlobalParameterDefaultsSync } from "./components/global-parameter-defaults-sync";

export default function App() {
  return (
    <TooltipProvider>
      <AppSettingsProvider>
        <DiagnosticLogInstaller />
        <EditorThemeProvider>
          <DocumentProvider>
            <GlobalParameterDefaultsSync />
            <AppRoutes />
          </DocumentProvider>
        </EditorThemeProvider>
      </AppSettingsProvider>
    </TooltipProvider>
  );
}

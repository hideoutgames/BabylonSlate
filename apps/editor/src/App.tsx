import { TooltipProvider } from "@babylonslate/ui/components/tooltip";
import { DocumentProvider } from "./context/document-context";
import { AppSettingsProvider } from "./context/app-settings-context";
import { EditorThemeProvider } from "./context/theme-context";
import { AppRoutes } from "./app-routes";

export default function App() {
  return (
    <TooltipProvider>
      <AppSettingsProvider>
        <EditorThemeProvider>
          <DocumentProvider>
            <AppRoutes />
          </DocumentProvider>
        </EditorThemeProvider>
      </AppSettingsProvider>
    </TooltipProvider>
  );
}

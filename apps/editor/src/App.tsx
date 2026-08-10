import { useCallback } from "react";
import type { DockviewApi } from "dockview";
import { EditorToolbar } from "./components/editor-toolbar";
import { ProjectProvider, useProject } from "./context/project-context";
import { DockviewShell } from "./shell/dockview-shell";

function EditorLayout() {
  const { projectState, setDockviewApi } = useProject();

  const handleReady = useCallback(
    (api: DockviewApi) => {
      setDockviewApi(api);
    },
    [setDockviewApi],
  );

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <EditorToolbar />
      <main className="min-h-0 flex-1">
        <DockviewShell
          onReady={handleReady}
          initialLayout={projectState?.layout ?? null}
        />
      </main>
    </div>
  );
}

export default function App() {
  return (
    <ProjectProvider>
      <EditorLayout />
    </ProjectProvider>
  );
}

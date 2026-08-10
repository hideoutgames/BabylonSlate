import { FolderOpenIcon, SaveIcon } from "lucide-react";
import { Button } from "@babylonslate/ui/components/button";
import { Separator } from "@babylonslate/ui/components/separator";
import { isTestModeEnabled } from "@babylonslate/storage";
import { useProject } from "../context/project-context";

export function EditorToolbar() {
  const { projectName, openProject, saveProject } = useProject();
  const testMode = isTestModeEnabled();

  return (
    <header
      className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-card px-3"
      data-testid="editor-toolbar"
    >
      <div className="text-sm font-semibold">BabylonSlate</div>
      {testMode ? (
        <span
          className="rounded-md bg-secondary px-2 py-0.5 text-xs text-secondary-foreground"
          data-testid="test-mode-badge"
        >
          Test mode
        </span>
      ) : null}
      <Separator orientation="vertical" className="h-6" />
      <Button
        size="sm"
        variant="outline"
        data-testid="open-project"
        onClick={() => void openProject()}
      >
        <FolderOpenIcon data-icon="inline-start" />
        Open
      </Button>
      <Button
        size="sm"
        variant="outline"
        data-testid="save-project"
        onClick={() => void saveProject()}
      >
        <SaveIcon data-icon="inline-start" />
        Save
      </Button>
      <div
        className="ml-auto text-xs text-muted-foreground"
        data-testid="project-name"
      >
        {projectName ?? "No project open"}
      </div>
    </header>
  );
}

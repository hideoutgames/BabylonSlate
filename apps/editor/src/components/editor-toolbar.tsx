import { FolderOpenIcon, SaveIcon } from "lucide-react";
import { Button } from "@babylonslate/ui/components/button";
import { Separator } from "@babylonslate/ui/components/separator";
import { useProject } from "../context/project-context";

export function EditorToolbar() {
  const { projectName, openProject, saveProject } = useProject();

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
      <div className="text-sm font-semibold">BabylonSlate</div>
      <Separator orientation="vertical" className="h-6" />
      <Button size="sm" variant="outline" onClick={() => void openProject()}>
        <FolderOpenIcon data-icon="inline-start" />
        Open
      </Button>
      <Button size="sm" variant="outline" onClick={() => void saveProject()}>
        <SaveIcon data-icon="inline-start" />
        Save
      </Button>
      <div className="ml-auto text-xs text-muted-foreground">
        {projectName ?? "No project open"}
      </div>
    </header>
  );
}

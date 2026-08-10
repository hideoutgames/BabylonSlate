import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@babylonslate/ui/components/sheet";
import { useDocuments } from "../context/document-context";

interface ProjectSettingsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ProjectSettingsSheet({
  open,
  onOpenChange,
}: ProjectSettingsSheetProps) {
  const { projectDocument } = useDocuments();

  if (!open || !projectDocument) {
    return null;
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>Project Settings</SheetTitle>
          <SheetDescription>
            Configuration for {projectDocument.metadata.name}
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-4 px-4 pb-4">
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              Project name
            </span>
            <span className="text-sm">{projectDocument.metadata.name}</span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              Version
            </span>
            <span className="text-sm">{projectDocument.metadata.version}</span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              Touch target minimum
            </span>
            <span className="text-sm">
              {projectDocument.settings.touchMinTargetPx}px
            </span>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

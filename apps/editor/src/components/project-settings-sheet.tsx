import { Button } from "@babylonslate/ui/components/button";
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
  const { projectDocument, exportProject, retryFailedTextureEncoding } =
    useDocuments();

  if (!open || !projectDocument) {
    return null;
  }

  const handleExport = async () => {
    const bytes = await exportProject();
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: "application/zip" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${projectDocument.metadata.name.replace(/\s+/g, "_")}.babproject`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

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
          <div className="flex flex-col gap-2 border-t border-border pt-4">
            <span className="text-xs font-medium text-muted-foreground">
              Textures
            </span>
            <p className="text-sm text-muted-foreground">
              Max dimension {projectDocument.settings.textures.maxTextureDimension}
              px. Auto re-queue uncompressed:{" "}
              {projectDocument.settings.textures.autoRequeueUncompressed
                ? "on"
                : "off"}
              .
            </p>
            <Button
              variant="secondary"
              data-testid="retry-texture-encoding"
              onClick={() => void retryFailedTextureEncoding()}
            >
              Retry encoding
            </Button>
          </div>
          <div className="flex flex-col gap-2 border-t border-border pt-4">
            <span className="text-xs font-medium text-muted-foreground">
              Export
            </span>
            <Button
              data-testid="export-project"
              onClick={() => void handleExport()}
            >
              Export Project
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

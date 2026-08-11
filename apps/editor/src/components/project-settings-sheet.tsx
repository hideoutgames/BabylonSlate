import { Button } from "@babylonslate/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@babylonslate/ui/components/field";
import { Separator } from "@babylonslate/ui/components/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@babylonslate/ui/components/sheet";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@babylonslate/ui/components/tabs";
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
      <SheetContent side="right" className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Project Settings</SheetTitle>
          <SheetDescription>
            Configuration for {projectDocument.metadata.name}
          </SheetDescription>
        </SheetHeader>
        <Tabs defaultValue="general" className="px-4 pb-4">
          <TabsList className="w-full">
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="textures">Textures</TabsTrigger>
            <TabsTrigger value="export">Export</TabsTrigger>
          </TabsList>
          <TabsContent value="general" className="pt-4">
            <FieldGroup>
              <Field>
                <FieldLabel>Project name</FieldLabel>
                <p className="text-sm">{projectDocument.metadata.name}</p>
              </Field>
              <Field>
                <FieldLabel>Version</FieldLabel>
                <p className="text-sm">{projectDocument.metadata.version}</p>
              </Field>
              <Field>
                <FieldLabel>Touch target minimum</FieldLabel>
                <p className="text-sm">
                  {projectDocument.settings.touchMinTargetPx}px
                </p>
                <FieldDescription>
                  Matches shell <code>--touch-target</code> on this device.
                </FieldDescription>
              </Field>
            </FieldGroup>
          </TabsContent>
          <TabsContent value="textures" className="flex flex-col gap-4 pt-4">
            <FieldGroup>
              <Field>
                <FieldLabel>Texture policy</FieldLabel>
                <FieldDescription>
                  Max dimension {projectDocument.settings.textures.maxTextureDimension}
                  px. Auto re-queue uncompressed:{" "}
                  {projectDocument.settings.textures.autoRequeueUncompressed
                    ? "on"
                    : "off"}
                  .
                </FieldDescription>
              </Field>
            </FieldGroup>
            <Button
              variant="secondary"
              data-testid="retry-texture-encoding"
              onClick={() => void retryFailedTextureEncoding()}
            >
              Retry encoding
            </Button>
          </TabsContent>
          <TabsContent value="export" className="flex flex-col gap-4 pt-4">
            <Separator />
            <Field>
              <FieldLabel>Export Project</FieldLabel>
              <FieldDescription>
                Download a zip of the project directory layout.
              </FieldDescription>
            </Field>
            <Button
              data-testid="export-project"
              onClick={() => void handleExport()}
            >
              Export Project
            </Button>
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}

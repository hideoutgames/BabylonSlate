import { Button } from "@babylonslate/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@babylonslate/ui/components/field";
import { Input } from "@babylonslate/ui/components/input";
import { Textarea } from "@babylonslate/ui/components/textarea";
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
  const { projectDocument, exportProject, retryFailedTextureEncoding, updateProjectSettings } =
    useDocuments();

  if (!open || !projectDocument) {
    return null;
  }

  const twoD = projectDocument.settings.twoD;

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
          <TabsList className="w-full flex-wrap h-auto">
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="input">Input</TabsTrigger>
            <TabsTrigger value="twoD">2D</TabsTrigger>
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
          <TabsContent value="input" className="flex flex-col gap-4 pt-4">
            <FieldGroup>
              <Field>
                <FieldLabel>Actions</FieldLabel>
                <FieldDescription>
                  Named actions resolve through the input mapping model. Edit
                  the JSON below; each binding needs a device and code.
                </FieldDescription>
                <Textarea
                  className="min-h-32 font-mono text-xs"
                  value={JSON.stringify(
                    projectDocument.settings.input.actions,
                    null,
                    2,
                  )}
                  onChange={(event) => {
                    try {
                      const actions = JSON.parse(event.target.value) as unknown;
                      if (!Array.isArray(actions)) return;
                      updateProjectSettings({
                        input: {
                          ...projectDocument.settings.input,
                          actions: actions as typeof projectDocument.settings.input.actions,
                        },
                      });
                    } catch {
                      // Keep typing until the JSON is valid again.
                    }
                  }}
                  data-testid="settings-input-actions"
                />
              </Field>
              <Field>
                <FieldLabel>Axes</FieldLabel>
                <Textarea
                  className="min-h-32 font-mono text-xs"
                  value={JSON.stringify(
                    projectDocument.settings.input.axes,
                    null,
                    2,
                  )}
                  onChange={(event) => {
                    try {
                      const axes = JSON.parse(event.target.value) as unknown;
                      if (!Array.isArray(axes)) return;
                      updateProjectSettings({
                        input: {
                          ...projectDocument.settings.input,
                          axes: axes as typeof projectDocument.settings.input.axes,
                        },
                      });
                    } catch {
                      // Keep typing until the JSON is valid again.
                    }
                  }}
                  data-testid="settings-input-axes"
                />
              </Field>
            </FieldGroup>
          </TabsContent>
          <TabsContent value="twoD" className="flex flex-col gap-4 pt-4">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="pixels-per-unit">Pixels per unit</FieldLabel>
                <Input
                  id="pixels-per-unit"
                  type="number"
                  min={1}
                  step={1}
                  className="min-h-11"
                  value={twoD.pixelsPerUnit}
                  onChange={(event) =>
                    updateProjectSettings({
                      twoD: {
                        ...twoD,
                        pixelsPerUnit: Number(event.target.value) || 100,
                      },
                    })
                  }
                  data-testid="settings-pixels-per-unit"
                />
                <FieldDescription>
                  Texture pixels that span one world unit in 2D scenes.
                </FieldDescription>
              </Field>
              <Field>
                <label className="flex min-h-11 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={twoD.pixelPerfect}
                    onChange={(event) =>
                      updateProjectSettings({
                        twoD: { ...twoD, pixelPerfect: event.target.checked },
                      })
                    }
                    data-testid="settings-pixel-perfect"
                  />
                  Pixel-perfect mode
                </label>
                <FieldDescription>
                  Ortho bounds from canvas size, nearest sampling, camera snapped
                  to the pixel grid.
                </FieldDescription>
              </Field>
              <Field>
                <label className="flex min-h-11 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={twoD.integerZoomSteps}
                    onChange={(event) =>
                      updateProjectSettings({
                        twoD: {
                          ...twoD,
                          integerZoomSteps: event.target.checked,
                        },
                      })
                    }
                    data-testid="settings-integer-zoom"
                  />
                  Integer zoom steps
                </label>
              </Field>
              <Field>
                <FieldLabel htmlFor="sorting-layers">Sorting layers</FieldLabel>
                <Input
                  id="sorting-layers"
                  className="min-h-11"
                  value={twoD.sortingLayers.join(", ")}
                  onChange={(event) =>
                    updateProjectSettings({
                      twoD: {
                        ...twoD,
                        sortingLayers: event.target.value
                          .split(",")
                          .map((layer) => layer.trim())
                          .filter(Boolean),
                      },
                    })
                  }
                  data-testid="settings-sorting-layers"
                />
                <FieldDescription>
                  Comma-separated, back to front. Compiles to one alphaIndex sort
                  key per sprite.
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

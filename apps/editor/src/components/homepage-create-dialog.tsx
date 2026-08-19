import { BoxIcon, Grid2x2Icon, LayoutTemplateIcon } from "lucide-react";
import {
  DEFAULT_RENDER_HEIGHT,
  DEFAULT_RENDER_WIDTH,
} from "@babylonslate/core";
import {
  isCoarsePointerEnvironment,
  NumberField,
} from "@babylonslate/editor-kit";
import type { HostPlatform } from "@babylonslate/vfs";
import { Button } from "@babylonslate/ui/components/button";
import { Checkbox } from "@babylonslate/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@babylonslate/ui/components/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@babylonslate/ui/components/field";
import { Input } from "@babylonslate/ui/components/input";
import { TemplatePickCard } from "./homepage-template-card";

function nativeLocationStatus(
  hostPlatform: HostPlatform,
  pickFolder: boolean,
): string {
  if (pickFolder) return "Choose a folder when you create";
  if (hostPlatform === "electron") return "Projects folder";
  return "App Documents";
}

export function HomepageCreateDialog({
  open,
  onOpenChange,
  busy,
  name,
  onNameChange,
  nameIssue,
  templateId,
  onTemplateIdChange,
  templates,
  hostPlatform,
  pickFolder,
  onPickFolderChange,
  width,
  onWidthChange,
  height,
  onHeightChange,
  blackBars,
  onBlackBarsChange,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  name: string;
  onNameChange: (name: string) => void;
  nameIssue: string | null;
  templateId: string;
  onTemplateIdChange: (id: string) => void;
  templates: Array<{ id: string; name: string }>;
  hostPlatform: HostPlatform;
  pickFolder: boolean;
  onPickFolderChange: (pick: boolean) => void;
  width: number;
  onWidthChange: (value: number) => void;
  height: number;
  onHeightChange: (value: number) => void;
  blackBars: boolean;
  onBlackBarsChange: (value: boolean) => void;
  onSubmit: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onOpenChange(false);
      }}
    >
      <DialogContent
        className="flex h-[min(90dvh,52rem)] max-h-[90dvh] w-[min(96vw,56rem)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
        data-testid="create-project-dialog"
      >
        <DialogHeader className="shrink-0 border-b px-6 py-4">
          <DialogTitle>Create Project</DialogTitle>
          <DialogDescription>
            Name the project, pick Empty or 2D, then create.
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
          <div
            className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-y-contain p-4"
            data-testid="create-project-templates"
          >
            <div className="flex flex-wrap gap-3">
              <TemplatePickCard
                title="Empty"
                description="Blank 3D project"
                testId="create-project-empty"
                selected={templateId === "empty"}
                icon={BoxIcon}
                onSelect={() => onTemplateIdChange("empty")}
              />
              <TemplatePickCard
                title="2D"
                description="Pixel-perfect Rapier"
                testId="create-project-2d"
                selected={templateId === "2d"}
                icon={Grid2x2Icon}
                onSelect={() => onTemplateIdChange("2d")}
              />
              {templates.map((template) => (
                <TemplatePickCard
                  key={template.id}
                  title={template.name}
                  testId={`create-project-template-${template.id}`}
                  selected={templateId === template.id}
                  icon={LayoutTemplateIcon}
                  onSelect={() => onTemplateIdChange(template.id)}
                />
              ))}
            </div>
          </div>
          <div
            className="flex w-full min-w-0 shrink-0 flex-col overflow-x-hidden border-t md:w-80 md:border-t-0 md:border-l"
            data-testid="create-project-details"
          >
            <div
              className="flex min-h-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto overscroll-y-contain p-6"
              data-testid="create-project-form"
            >
              <FieldGroup>
                <Field data-invalid={Boolean(nameIssue) || undefined}>
                  <FieldLabel htmlFor="create-project-name">Name</FieldLabel>
                  <Input
                    id="create-project-name"
                    data-testid="create-project-name"
                    autoFocus={!isCoarsePointerEnvironment()}
                    aria-invalid={Boolean(nameIssue) || undefined}
                    value={name}
                    onChange={(event) => onNameChange(event.target.value)}
                  />
                  {nameIssue ? (
                    <FieldError data-testid="create-project-name-issue">
                      {nameIssue}
                    </FieldError>
                  ) : null}
                </Field>
                <Field>
                  <FieldLabel>Location</FieldLabel>
                  {hostPlatform === "web" ? (
                    <p
                      className="text-sm text-muted-foreground"
                      data-testid="create-project-location"
                    >
                      On this device.
                    </p>
                  ) : (
                    <div className="flex w-full min-w-0 flex-col gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="touch"
                        className="w-full min-w-0"
                        aria-pressed={!pickFolder}
                        data-testid="create-project-app-documents"
                        onClick={() => onPickFolderChange(false)}
                      >
                        {hostPlatform === "electron"
                          ? "Projects Folder"
                          : "App Documents"}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="touch"
                        className="w-full min-w-0"
                        aria-pressed={pickFolder}
                        data-testid="create-project-choose-location"
                        onClick={() => onPickFolderChange(true)}
                      >
                        Choose Location…
                      </Button>
                      <p
                        className="text-sm text-muted-foreground"
                        data-testid="create-project-location"
                      >
                        {nativeLocationStatus(hostPlatform, pickFolder)}
                      </p>
                    </div>
                  )}
                </Field>
                <Field>
                  <FieldLabel htmlFor="create-project-width">
                    Render Size
                  </FieldLabel>
                  <div className="flex min-w-0 items-center gap-2">
                    <NumberField
                      id="create-project-width"
                      min={1}
                      step={1}
                      className="min-h-[var(--touch-target,44px)] min-w-0"
                      value={width}
                      onChange={onWidthChange}
                      data-testid="create-project-width"
                      aria-label="Render Width"
                    />
                    <span aria-hidden="true">×</span>
                    <NumberField
                      id="create-project-height"
                      min={1}
                      step={1}
                      className="min-h-[var(--touch-target,44px)] min-w-0"
                      value={height}
                      onChange={onHeightChange}
                      data-testid="create-project-height"
                      aria-label="Render Height"
                    />
                  </div>
                  <FieldDescription>
                    Play and export resolution (default{" "}
                    {DEFAULT_RENDER_WIDTH}×{DEFAULT_RENDER_HEIGHT}).
                  </FieldDescription>
                </Field>
                <Field orientation="horizontal">
                  <Checkbox
                    id="create-project-black-bars"
                    checked={blackBars}
                    onCheckedChange={(checked) =>
                      onBlackBarsChange(checked === true)
                    }
                    data-testid="create-project-black-bars"
                  />
                  <FieldLabel htmlFor="create-project-black-bars">
                    Black Bars
                  </FieldLabel>
                </Field>
                <FieldDescription>
                  Renders black bars to force desired resolution.
                </FieldDescription>
              </FieldGroup>
            </div>
            <DialogFooter
              className="mx-0 mb-0 shrink-0 gap-2 sm:justify-end"
              data-testid="create-project-footer"
            >
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                data-testid="create-project-submit"
                disabled={busy || Boolean(nameIssue)}
                onClick={onSubmit}
              >
                Create
              </Button>
            </DialogFooter>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

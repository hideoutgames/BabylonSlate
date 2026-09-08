import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRightIcon,
  BoxIcon,
  CheckIcon,
  Grid2x2Icon,
  ImagePlusIcon,
  LayoutTemplateIcon,
  LoaderCircleIcon,
  XIcon,
} from "lucide-react";
import {
  DEFAULT_RENDER_HEIGHT,
  DEFAULT_RENDER_WIDTH,
  type ProjectAppearance,
} from "@babylonslate/core";
import {
  isCoarsePointerEnvironment,
  NumberField,
} from "@babylonslate/editor-kit";
import type { HostPlatform } from "@babylonslate/vfs";
import { Alert, AlertDescription } from "@babylonslate/ui/components/alert";
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
  FieldLegend,
  FieldSet,
} from "@babylonslate/ui/components/field";
import { Input } from "@babylonslate/ui/components/input";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@babylonslate/ui/components/toggle-group";
import { TemplatePickCard } from "./homepage-template-card";
import { ProjectIdentityBadge } from "./homepage-project-identity";
import {
  PROJECT_COLOR_PRESETS,
  PROJECT_ICON_PRESETS,
  prepareProjectPicture,
} from "./homepage-project-appearance";

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
  mode = "create",
  name,
  onNameChange,
  nameIssue,
  appearance,
  onAppearanceChange,
  error,
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
  mode?: "create" | "edit";
  name: string;
  onNameChange: (name: string) => void;
  nameIssue: string | null;
  appearance: ProjectAppearance;
  onAppearanceChange: (appearance: ProjectAppearance) => void;
  error?: string | null;
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
  const editing = mode === "edit";
  const nameId = editing ? "homepage-rename-input" : "create-project-name";
  const fileInput = useRef<HTMLInputElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const importRequest = useRef<AbortController | null>(null);
  const [imageIssue, setImageIssue] = useState<string | null>(null);
  const [imageBusy, setImageBusy] = useState(false);
  const templateName =
    templateId === "empty"
      ? "Empty Project"
      : templateId === "2d"
        ? "2D Project"
        : (templates.find((template) => template.id === templateId)?.name ??
          "Project");

  useEffect(() => {
    setImageBusy(false);
    setImageIssue(null);
    return () => {
      importRequest.current?.abort();
      importRequest.current = null;
    };
  }, [open]);

  const changeAppearance = (next: ProjectAppearance) => {
    importRequest.current?.abort();
    importRequest.current = null;
    setImageBusy(false);
    setImageIssue(null);
    onAppearanceChange(next);
  };
  const uploadPicture = async (file: File) => {
    importRequest.current?.abort();
    const request = new AbortController();
    importRequest.current = request;
    setImageBusy(true);
    setImageIssue(null);
    try {
      const image = await prepareProjectPicture(file, request.signal);
      if (!request.signal.aborted) onAppearanceChange({ ...appearance, image });
    } catch (cause) {
      if (!request.signal.aborted)
        setImageIssue(
          cause instanceof Error
            ? cause.message
            : "This picture could not be opened.",
        );
    } finally {
      if (importRequest.current === request) {
        importRequest.current = null;
        setImageBusy(false);
      }
    }
  };
  const canSubmit = !busy && !imageBusy && !nameIssue && Boolean(name.trim());
  const submit = () => {
    if (canSubmit) onSubmit();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onOpenChange(false);
      }}
    >
      <DialogContent
        ref={popup}
        initialFocus={() =>
          isCoarsePointerEnvironment() ? popup.current : nameInput.current
        }
        className="homepage-theme homepage-composer flex h-[min(90dvh,52rem)] max-h-[90dvh] w-[min(96vw,68rem)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
        data-testid={
          editing ? "homepage-rename-dialog" : "create-project-dialog"
        }
        data-mode={mode}
        showCloseButton={!busy}
      >
        <div className="homepage-composer-layout flex min-h-0 min-w-0 flex-1">
          <aside
            className="homepage-composer-preview"
            data-testid="project-identity-preview"
          >
            <p className="homepage-eyebrow">
              {editing ? "Make It Yours" : "A New Beginning"}
            </p>
            <div className="homepage-composer-preview-stage">
              <ProjectIdentityBadge
                appearance={appearance}
                className="homepage-composer-badge"
              />
            </div>
            <div className="homepage-composer-preview-caption">
              <h2>{name.trim() || "Your Next World"}</h2>
              <p>{editing ? "Your Project, Your Signature" : templateName}</p>
            </div>
            <span
              className="homepage-composer-preview-index"
              aria-hidden="true"
            >
              SLATE / {editing ? "EDIT" : "CREATE"}
            </span>
          </aside>
          <div
            className="homepage-composer-details flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden"
            data-testid="create-project-details"
          >
            <DialogHeader className="homepage-composer-header shrink-0">
              <p className="homepage-eyebrow">
                {editing ? "Project Identity" : "Project Studio"}
              </p>
              <DialogTitle>
                {editing ? "Edit Project" : "Create Project"}
              </DialogTitle>
              <DialogDescription>
                {editing
                  ? "Give your project a new name or a fresh look."
                  : "Every great world starts with a little possibility."}
              </DialogDescription>
            </DialogHeader>
            <form
              id="homepage-project-form"
              className="homepage-composer-form flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto overscroll-y-contain"
              data-testid="create-project-form"
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
            >
              <FieldGroup>
                <Field
                  data-invalid={Boolean(nameIssue) || undefined}
                  data-disabled={busy || undefined}
                >
                  <FieldLabel htmlFor={nameId}>Project Name</FieldLabel>
                  <Input
                    ref={nameInput}
                    id={nameId}
                    data-testid={nameId}
                    placeholder="Name Your Next World"
                    autoComplete="off"
                    disabled={busy}
                    aria-invalid={Boolean(nameIssue) || undefined}
                    aria-describedby={
                      nameIssue ? "project-name-issue" : undefined
                    }
                    value={name}
                    onChange={(event) => onNameChange(event.target.value)}
                  />
                  {nameIssue ? (
                    <FieldError
                      id="project-name-issue"
                      data-testid="create-project-name-issue"
                    >
                      {nameIssue}
                    </FieldError>
                  ) : null}
                </Field>
                <FieldSet
                  disabled={busy}
                  className="homepage-composer-identity"
                >
                  <FieldLegend
                    variant="label"
                    className="homepage-badge-legend"
                  >
                    <span>Project Badge</span>
                    <ProjectIdentityBadge
                      appearance={appearance}
                      className="homepage-composer-inline-preview"
                    />
                  </FieldLegend>
                  <div
                    className="homepage-composer-icon-grid"
                    role="group"
                    aria-label="Project Icon"
                  >
                    {PROJECT_ICON_PRESETS.map(({ id, label, icon: Icon }) => (
                      <Button
                        key={id}
                        type="button"
                        variant="outline"
                        size="icon"
                        className="homepage-icon-choice"
                        aria-label={label}
                        title={label}
                        aria-pressed={
                          !appearance.image && appearance.icon === id
                        }
                        onClick={() =>
                          changeAppearance({
                            icon: id,
                            color: appearance.color,
                          })
                        }
                      >
                        <Icon />
                      </Button>
                    ))}
                  </div>
                  <ToggleGroup
                    className="homepage-composer-color-grid"
                    aria-label="Badge Color"
                    value={[appearance.color]}
                    onValueChange={(values) => {
                      if (values[0])
                        changeAppearance({ ...appearance, color: values[0] });
                    }}
                  >
                    {PROJECT_COLOR_PRESETS.map(({ id, label }) => (
                      <ToggleGroupItem
                        key={id}
                        value={id}
                        aria-label={label}
                        title={label}
                        className="homepage-color-choice"
                        data-color={id}
                      >
                        <span
                          className="homepage-color-blob"
                          aria-hidden="true"
                        >
                          {appearance.color === id ? <CheckIcon /> : null}
                        </span>
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                  <div className="homepage-composer-upload flex flex-wrap items-center gap-2">
                    <Input
                      ref={fileInput}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      aria-label="Upload Picture"
                      className="sr-only"
                      tabIndex={-1}
                      data-testid="project-picture-input"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = "";
                        if (file) void uploadPicture(file);
                      }}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => fileInput.current?.click()}
                      disabled={imageBusy}
                    >
                      {imageBusy ? (
                        <LoaderCircleIcon
                          data-icon="inline-start"
                          className="animate-spin"
                        />
                      ) : (
                        <ImagePlusIcon data-icon="inline-start" />
                      )}
                      {imageBusy
                        ? "Preparing Picture"
                        : appearance.image
                          ? "Replace Picture"
                          : "Upload Picture"}
                    </Button>
                    {appearance.image ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          changeAppearance({
                            icon: appearance.icon,
                            color: appearance.color,
                          })
                        }
                      >
                        <XIcon data-icon="inline-start" />
                        Remove Picture
                      </Button>
                    ) : null}
                    <FieldDescription>
                      PNG, JPEG, Or WebP · Up To 10 MB
                    </FieldDescription>
                  </div>
                  {imageIssue ? (
                    <Alert variant="destructive">
                      <AlertDescription>{imageIssue}</AlertDescription>
                    </Alert>
                  ) : null}
                </FieldSet>
                {!editing ? (
                  <>
                    <FieldSet disabled={busy}>
                      <FieldLegend variant="label">Starting Point</FieldLegend>
                      <div
                        className="homepage-composer-templates"
                        data-testid="create-project-templates"
                      >
                        <TemplatePickCard
                          title="Empty"
                          description="A Blank 3D Canvas"
                          testId="create-project-empty"
                          selected={templateId === "empty"}
                          disabled={busy}
                          icon={BoxIcon}
                          onSelect={() => onTemplateIdChange("empty")}
                        />
                        <TemplatePickCard
                          title="2D"
                          description="A Pixel-Perfect Start"
                          testId="create-project-2d"
                          selected={templateId === "2d"}
                          disabled={busy}
                          icon={Grid2x2Icon}
                          onSelect={() => onTemplateIdChange("2d")}
                        />
                        {templates.map((template) => (
                          <TemplatePickCard
                            key={template.id}
                            title={template.name}
                            testId={`create-project-template-${template.id}`}
                            selected={templateId === template.id}
                            disabled={busy}
                            icon={LayoutTemplateIcon}
                            onSelect={() => onTemplateIdChange(template.id)}
                          />
                        ))}
                      </div>
                    </FieldSet>
                    {hostPlatform !== "web" ? (
                      <Field>
                        <FieldLabel id="project-location-label">
                          Location
                        </FieldLabel>
                        <ToggleGroup
                          aria-labelledby="project-location-label"
                          value={[pickFolder ? "folder" : "default"]}
                          disabled={busy}
                          onValueChange={(values) => {
                            if (values[0])
                              onPickFolderChange(values[0] === "folder");
                          }}
                        >
                          <ToggleGroupItem
                            value="default"
                            data-testid="create-project-app-documents"
                          >
                            {hostPlatform === "electron"
                              ? "Projects Folder"
                              : "App Documents"}
                          </ToggleGroupItem>
                          <ToggleGroupItem
                            value="folder"
                            data-testid="create-project-choose-location"
                          >
                            Choose Location…
                          </ToggleGroupItem>
                        </ToggleGroup>
                        <FieldDescription data-testid="create-project-location">
                          {nativeLocationStatus(hostPlatform, pickFolder)}
                        </FieldDescription>
                      </Field>
                    ) : null}
                    <FieldSet
                      disabled={busy}
                      className="homepage-composer-render-settings"
                    >
                      <FieldLegend variant="label">Canvas Settings</FieldLegend>
                      <Field>
                        <FieldLabel htmlFor="create-project-width">
                          Render Size
                        </FieldLabel>
                        <div className="flex min-w-0 items-center gap-2">
                          <NumberField
                            id="create-project-width"
                            min={1}
                            step={1}
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
                    </FieldSet>
                  </>
                ) : null}
                {error ? (
                  <Alert variant="destructive">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                ) : null}
              </FieldGroup>
            </form>
            <DialogFooter
              className="homepage-composer-footer mx-0 mb-0 shrink-0"
              data-testid="create-project-footer"
            >
              <Button
                type="button"
                variant="ghost"
                onClick={() => onOpenChange(false)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                form="homepage-project-form"
                data-testid={
                  editing ? "homepage-rename-confirm" : "create-project-submit"
                }
                disabled={!canSubmit}
              >
                {busy ? (
                  <LoaderCircleIcon
                    className="animate-spin"
                    data-icon="inline-start"
                  />
                ) : null}
                {busy
                  ? editing
                    ? "Saving"
                    : "Creating"
                  : editing
                    ? "Save Changes"
                    : "Create Project"}
                {!busy ? <ArrowUpRightIcon data-icon="inline-end" /> : null}
              </Button>
            </DialogFooter>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

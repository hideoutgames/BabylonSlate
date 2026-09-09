import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRightIcon,
  ArrowLeftIcon,
  CheckIcon,
  ImagePlusIcon,
  LoaderCircleIcon,
  XIcon,
} from "lucide-react";
import { type ProjectAppearance } from "@babylonslate/core";
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
import { HomepageTemplateBrowser } from "./homepage-template-browser";
import { ProjectIdentityBadge } from "./homepage-project-identity";
import {
  PROJECT_COLOR_PRESETS,
  PROJECT_ICON_PRESETS,
  prepareProjectPicture,
} from "./homepage-project-appearance";

function hasTouchInput() {
  return (
    isCoarsePointerEnvironment() ||
    Boolean(window.matchMedia?.("(any-pointer: coarse)").matches)
  );
}

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
  chooseTemplate = false,
  name,
  onNameChange,
  nameIssue,
  appearance,
  onAppearanceChange,
  error,
  templateId,
  onTemplateIdChange,
  templates,
  onImportTemplate,
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
  chooseTemplate?: boolean;
  name: string;
  onNameChange: (name: string) => void;
  nameIssue: string | null;
  appearance: ProjectAppearance;
  onAppearanceChange: (appearance: ProjectAppearance) => void;
  error?: string | null;
  templateId: string;
  onTemplateIdChange: (id: string) => void;
  onImportTemplate?: () => void;
  templates: Array<{ id: string; name: string; imageUrl?: string }>;
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
  const [nameTouched, setNameTouched] = useState(false);
  const visibleNameIssue = nameTouched || name.length > 0 ? nameIssue : null;
  const [step, setStep] = useState<"templates" | "details">("details");
  useEffect(() => {
    if (open) setStep(!editing && chooseTemplate ? "templates" : "details");
  }, [open, editing, chooseTemplate]);
  const nameId = editing ? "homepage-rename-input" : "create-project-name";
  const fileInput = useRef<HTMLInputElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const importRequest = useRef<AbortController | null>(null);
  const [imageIssue, setImageIssue] = useState<string | null>(null);
  const [imageBusy, setImageBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const viewport = window.visualViewport;
    const resize = () => {
      // The software keyboard changes the visible viewport on iOS without
      // changing dvh. Preserve the layout when the user deliberately zooms.
      if (viewport && viewport.scale !== 1) return;
      const element = popup.current;
      const height = viewport?.height ?? window.innerHeight;
      if (!element || height <= 0) return;
      element.style.setProperty("--homepage-visible-height", `${height}px`);
      element.style.setProperty(
        "--homepage-visible-top",
        `${viewport?.offsetTop ?? 0}px`,
      );
    };
    resize();
    const frame = requestAnimationFrame(resize);
    viewport?.addEventListener("resize", resize);
    viewport?.addEventListener("scroll", resize);
    window.addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(frame);
      viewport?.removeEventListener("resize", resize);
      viewport?.removeEventListener("scroll", resize);
      window.removeEventListener("resize", resize);
    };
  }, [open]);

  useEffect(() => {
    setImageBusy(false);
    setImageIssue(null);
    setNameTouched(false);
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
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent
        ref={popup}
        initialFocus={() =>
          hasTouchInput() || step === "templates"
            ? popup.current
            : nameInput.current
        }
        className="homepage-theme homepage-composer"
        data-testid={
          editing ? "homepage-rename-dialog" : "create-project-dialog"
        }
        data-mode={mode}
        data-step={step}
        showCloseButton={!busy}
      >
        <DialogHeader className="homepage-composer-header">
          {!editing && step === "details" && (
            <Button
              variant="ghost"
              size="touch-icon"
              aria-label="Choose Template"
              disabled={busy}
              onClick={() => setStep("templates")}
            >
              <ArrowLeftIcon />
            </Button>
          )}
          <DialogTitle>
            {editing
              ? "Edit Project"
              : step === "templates"
                ? "Start With"
                : "New Project"}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {editing
              ? "Edit project name and appearance."
              : "Choose a starting point, then name and customize your project."}
          </DialogDescription>
        </DialogHeader>
        {step === "templates" && !editing ? (
          <div
            className="homepage-template-step"
            data-testid="create-project-templates"
          >
            <HomepageTemplateBrowser
              templates={templates}
              selected={templateId}
              disabled={busy}
              composing
              onImport={onImportTemplate}
              onSelect={(id) => {
                onTemplateIdChange(id);
                setStep("details");
                requestAnimationFrame(() => {
                  const target = hasTouchInput()
                    ? popup.current
                    : nameInput.current;
                  target?.focus({ preventScroll: true });
                });
              }}
            />
          </div>
        ) : (
          <div className="homepage-composer-layout" key="details">
            <aside
              className="homepage-composer-preview"
              data-testid="project-identity-preview"
            >
              <div className="homepage-composer-preview-stage">
                <ProjectIdentityBadge appearance={appearance} />
              </div>
              <span>{name.trim() || "Untitled"}</span>
            </aside>
            <div
              className="homepage-composer-details"
              data-testid="create-project-details"
            >
              <form
                id="homepage-project-form"
                className="homepage-composer-form"
                data-testid="create-project-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  submit();
                }}
              >
                <FieldGroup>
                  <Field data-invalid={Boolean(visibleNameIssue)}>
                    <FieldLabel htmlFor={nameId}>Name</FieldLabel>
                    <Input
                      ref={nameInput}
                      onBlur={() => setNameTouched(true)}
                      id={nameId}
                      data-testid={nameId}
                      placeholder="Untitled"
                      autoComplete="off"
                      disabled={busy}
                      value={name}
                      onChange={(event) => onNameChange(event.target.value)}
                      aria-invalid={Boolean(visibleNameIssue)}
                    />
                    {visibleNameIssue && (
                      <FieldError data-testid="create-project-name-issue">
                        {visibleNameIssue}
                      </FieldError>
                    )}
                  </Field>
                  <FieldSet
                    disabled={busy}
                    className="homepage-composer-identity"
                  >
                    <FieldLegend
                      className="homepage-badge-legend"
                      variant="label"
                    >
                      <span>Icon</span>
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
                          variant="ghost"
                          size="touch-icon"
                          className="homepage-icon-choice"
                          aria-label={label}
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
                    <div className="homepage-composer-color-row">
                      <div
                        className="homepage-composer-color-grid"
                        role="group"
                        aria-label="Badge Color"
                      >
                        {PROJECT_COLOR_PRESETS.map(({ id, label }) => (
                          <Button
                            key={id}
                            type="button"
                            variant="ghost"
                            size="touch-icon"
                            className="homepage-color-choice"
                            aria-label={label}
                            aria-pressed={appearance.color === id}
                            onClick={() =>
                              changeAppearance({ ...appearance, color: id })
                            }
                          >
                            <span
                              className="homepage-color-blob"
                              data-color={id}
                            >
                              {appearance.color === id && <CheckIcon />}
                            </span>
                          </Button>
                        ))}
                      </div>
                      <div className="homepage-composer-upload">
                        <input
                          ref={fileInput}
                          type="file"
                          accept="image/png,image/jpeg,image/webp"
                          aria-label="Upload Picture"
                          className="sr-only"
                          tabIndex={-1}
                          disabled={busy || imageBusy}
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            event.target.value = "";
                            if (file) void uploadPicture(file);
                          }}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          disabled={busy || imageBusy}
                          onClick={() => fileInput.current?.click()}
                        >
                          {imageBusy ? (
                            <LoaderCircleIcon
                              data-icon="inline-start"
                              className="animate-spin"
                            />
                          ) : (
                            <ImagePlusIcon data-icon="inline-start" />
                          )}
                          {appearance.image
                            ? "Replace Picture"
                            : "Upload Picture"}
                        </Button>
                        {appearance.image && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="touch-icon"
                            aria-label="Remove Picture"
                            disabled={busy || imageBusy}
                            onClick={() =>
                              changeAppearance({
                                icon: appearance.icon,
                                color: appearance.color,
                              })
                            }
                          >
                            <XIcon />
                          </Button>
                        )}
                      </div>
                    </div>
                    {imageIssue && <FieldError>{imageIssue}</FieldError>}
                  </FieldSet>
                  {!editing && (
                    <details className="homepage-project-options">
                      <summary>Options</summary>
                      <FieldGroup>
                        {hostPlatform !== "web" && (
                          <Field>
                            <FieldLabel>Location</FieldLabel>
                            <ToggleGroup
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
                                Choose Folder
                              </ToggleGroupItem>
                            </ToggleGroup>
                            <FieldDescription data-testid="create-project-location">
                              {nativeLocationStatus(hostPlatform, pickFolder)}
                            </FieldDescription>
                          </Field>
                        )}
                        <Field>
                          <FieldLabel htmlFor="create-project-width">
                            Resolution
                          </FieldLabel>
                          <div className="homepage-resolution">
                            <NumberField
                              disabled={busy}
                              id="create-project-width"
                              min={1}
                              step={1}
                              value={width}
                              onChange={onWidthChange}
                              data-testid="create-project-width"
                              aria-label="Render Width"
                            />
                            <span>&times;</span>
                            <NumberField
                              disabled={busy}
                              id="create-project-height"
                              min={1}
                              step={1}
                              value={height}
                              onChange={onHeightChange}
                              data-testid="create-project-height"
                              aria-label="Render Height"
                            />
                          </div>
                        </Field>
                        <Field orientation="horizontal">
                          <Checkbox
                            disabled={busy}
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
                      </FieldGroup>
                    </details>
                  )}
                  {error && (
                    <Alert variant="destructive">
                      <AlertDescription>{error}</AlertDescription>
                    </Alert>
                  )}
                </FieldGroup>
              </form>
              <DialogFooter
                className="homepage-composer-footer"
                data-testid="create-project-footer"
              >
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => onOpenChange(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  form="homepage-project-form"
                  disabled={!canSubmit}
                  data-testid={
                    editing
                      ? "homepage-rename-confirm"
                      : "create-project-submit"
                  }
                >
                  {busy && (
                    <LoaderCircleIcon
                      data-icon="inline-start"
                      className="animate-spin"
                    />
                  )}
                  {editing ? "Save" : "Create"}
                  <ArrowUpRightIcon data-icon="inline-end" />
                </Button>
              </DialogFooter>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

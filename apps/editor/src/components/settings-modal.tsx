import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CatalogDialog,
  NumberField,
  type CatalogCategory,
  type CatalogCategoryGroup,
} from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@babylonslate/ui/components/field";
import { Input } from "@babylonslate/ui/components/input";
import { Switch } from "@babylonslate/ui/components/switch";
import { Textarea } from "@babylonslate/ui/components/textarea";
import {
  createAppSettingsStore,
  defaultEngineSettings,
  type EngineSettings,
} from "@babylonslate/vfs";
import { LogOutIcon } from "lucide-react";
import { useDocuments } from "../context/document-context";
import { dispatchEngineSettingsChanged } from "../lib/viewport-render-gate";
import {
  EngineSettingsForm,
  type EngineSettingsCategoryId,
} from "./engine-settings-form";

export type SettingsScope = "project" | "engine";

interface SettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: SettingsScope;
  onCloseProject?: () => void;
  onEngineSaved?: () => void | Promise<void>;
  "data-testid"?: string;
}

const PROJECT_CATEGORIES: Array<CatalogCategory & { keywords: string }> = [
  {
    id: "general",
    label: "General",
    keywords: "project name version touch target",
  },
  {
    id: "input",
    label: "Input",
    keywords: "actions axes bindings gamepad keyboard",
  },
  {
    id: "twoD",
    label: "2D",
    keywords: "pixels per unit pixel perfect integer zoom sorting layers",
  },
  {
    id: "rendering",
    label: "Rendering",
    keywords: "frame cap fps play preview",
  },
  {
    id: "textures",
    label: "Textures",
    keywords: "max dimension encoding retry compression",
  },
  {
    id: "export",
    label: "Export",
    keywords: "export project zip download",
  },
  {
    id: "project",
    label: "Close",
    keywords: "close project homepage dirty save",
  },
];

const PROJECT_GROUPS: CatalogCategoryGroup[] = [
  { label: "Project", ids: ["general", "input", "twoD", "rendering", "textures", "export"] },
  { label: "Session", ids: ["project"] },
];

const ENGINE_CATEGORIES: Array<
  CatalogCategory & { keywords: string; id: EngineSettingsCategoryId }
> = [
  {
    id: "appearance",
    label: "Appearance",
    keywords: "theme coarse pointer target scale",
  },
  {
    id: "undo",
    label: "Undo",
    keywords: "undo history length stack",
  },
  {
    id: "viewport",
    label: "Viewport",
    keywords: "frame cap hardware scaling",
  },
  {
    id: "thumbnails",
    label: "Thumbnails",
    keywords: "generate thumbnails",
  },
  {
    id: "templates",
    label: "Templates",
    keywords: "templates folder homepage",
  },
];

const ENGINE_GROUPS: CatalogCategoryGroup[] = [
  { label: "Editor", ids: ["appearance", "undo", "viewport", "thumbnails"] },
  { label: "Projects", ids: ["templates"] },
];

function matchesSearch(
  label: string,
  keywords: string,
  needle: string,
): boolean {
  return !needle || `${label} ${keywords}`.toLowerCase().includes(needle);
}

export function SettingsModal({
  open,
  onOpenChange,
  scope,
  onCloseProject,
  onEngineSaved,
  "data-testid": testId,
}: SettingsModalProps) {
  const resolvedTestId =
    testId ?? (scope === "engine" ? "engine-settings-modal" : "settings-modal");
  const {
    projectDocument,
    exportProject,
    retryFailedTextureEncoding,
    updateProjectSettings,
  } = useDocuments();
  const [search, setSearch] = useState("");
  const [activeCategoryId, setActiveCategoryId] = useState(
    scope === "engine" ? "appearance" : "general",
  );
  const store = useMemo(() => createAppSettingsStore(), []);
  const [engineSettings, setEngineSettings] = useState<EngineSettings>(
    defaultEngineSettings(),
  );

  useEffect(() => {
    if (!open) return;
    setSearch("");
    setActiveCategoryId(scope === "engine" ? "appearance" : "general");
    if (scope === "engine") {
      void store.load().then(setEngineSettings);
    }
  }, [open, scope, store]);

  const saveEngine = useCallback(
    async (patch: Partial<EngineSettings>) => {
      const next = { ...engineSettings, ...patch };
      setEngineSettings(next);
      await store.save(next);
      dispatchEngineSettingsChanged({
        viewportFrameCap: next.viewportFrameCap,
        theme: next.appearance.theme,
      });
      await onEngineSaved?.();
    },
    [engineSettings, onEngineSaved, store],
  );

  const source = scope === "engine" ? ENGINE_CATEGORIES : PROJECT_CATEGORIES;
  const groups = scope === "engine" ? ENGINE_GROUPS : PROJECT_GROUPS;

  const categories = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return source.filter((category) =>
      matchesSearch(category.label, category.keywords, needle),
    );
  }, [search, source]);

  useEffect(() => {
    if (!categories.some((category) => category.id === activeCategoryId)) {
      setActiveCategoryId(categories[0]?.id ?? source[0]?.id ?? "general");
    }
  }, [activeCategoryId, categories, source]);

  const handleExport = async () => {
    if (!projectDocument) return;
    const bytes = await exportProject();
    const blob = new Blob([bytes.buffer as ArrayBuffer], {
      type: "application/zip",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${projectDocument.metadata.name.replace(/\s+/g, "_")}.babproject`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const twoD = projectDocument?.settings.twoD;
  const showProjectBody = scope === "project" && Boolean(projectDocument);

  return (
    <CatalogDialog
      open={open}
      onOpenChange={onOpenChange}
      title={scope === "engine" ? "Engine Settings" : "Project Settings"}
      description={
        scope === "engine"
          ? "Global editor preferences stored outside any project"
          : projectDocument
            ? `Configuration for ${projectDocument.metadata.name}`
            : "Open a project to edit project settings"
      }
      categories={categories}
      groups={groups}
      activeCategoryId={activeCategoryId}
      onCategoryChange={setActiveCategoryId}
      search={search}
      onSearchChange={setSearch}
      searchPlaceholder="Search settings"
      data-testid={resolvedTestId}
    >
      {scope === "engine" ? (
        <EngineSettingsForm
          settings={engineSettings}
          onChange={saveEngine}
          categoryId={activeCategoryId as EngineSettingsCategoryId}
        />
      ) : null}

      {showProjectBody && projectDocument && twoD && activeCategoryId === "general" ? (
        <FieldGroup>
          <FieldSet>
            <FieldLegend>General</FieldLegend>
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
          </FieldSet>
        </FieldGroup>
      ) : null}

      {showProjectBody && projectDocument && activeCategoryId === "input" ? (
        <FieldGroup className="gap-4">
          <FieldSet>
            <FieldLegend>Input</FieldLegend>
            <Field>
              <FieldLabel>Actions</FieldLabel>
              <FieldDescription>
                Named actions resolve through the input mapping model. Edit the
                JSON below; each binding needs a device and code.
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
                        actions:
                          actions as typeof projectDocument.settings.input.actions,
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
          </FieldSet>
        </FieldGroup>
      ) : null}

      {showProjectBody && projectDocument && twoD && activeCategoryId === "twoD" ? (
        <FieldGroup className="gap-4">
          <FieldSet>
            <FieldLegend>2D</FieldLegend>
            <Field>
              <FieldLabel htmlFor="pixels-per-unit">Pixels per unit</FieldLabel>
              <NumberField
                id="pixels-per-unit"
                min={1}
                step={1}
                className="min-h-[var(--touch-target,44px)]"
                value={twoD.pixelsPerUnit}
                onChange={(pixelsPerUnit) =>
                  updateProjectSettings({
                    twoD: {
                      ...twoD,
                      pixelsPerUnit,
                    },
                  })
                }
                data-testid="settings-pixels-per-unit"
              />
              <FieldDescription>
                Texture pixels that span one world unit in 2D scenes.
              </FieldDescription>
            </Field>
            <Field orientation="horizontal">
              <FieldLabel htmlFor="settings-pixel-perfect">
                Pixel-perfect mode
              </FieldLabel>
              <Switch
                id="settings-pixel-perfect"
                checked={twoD.pixelPerfect}
                onCheckedChange={(checked) =>
                  updateProjectSettings({
                    twoD: { ...twoD, pixelPerfect: checked === true },
                  })
                }
                data-testid="settings-pixel-perfect"
              />
            </Field>
            <FieldDescription>
              Ortho bounds from canvas size, nearest sampling, camera snapped to
              the pixel grid.
            </FieldDescription>
            <Field orientation="horizontal">
              <FieldLabel htmlFor="settings-integer-zoom">
                Integer zoom steps
              </FieldLabel>
              <Switch
                id="settings-integer-zoom"
                checked={twoD.integerZoomSteps}
                onCheckedChange={(checked) =>
                  updateProjectSettings({
                    twoD: { ...twoD, integerZoomSteps: checked === true },
                  })
                }
                data-testid="settings-integer-zoom"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="sorting-layers">Sorting layers</FieldLabel>
              <Input
                id="sorting-layers"
                className="min-h-[var(--touch-target,44px)]"
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
          </FieldSet>
        </FieldGroup>
      ) : null}

      {showProjectBody && projectDocument && activeCategoryId === "rendering" ? (
        <FieldGroup className="gap-4">
          <FieldSet>
            <FieldLegend>Rendering</FieldLegend>
            <Field>
              <FieldLabel htmlFor="setting-play-frame-cap">
                Play frame cap
              </FieldLabel>
              <Input
                id="setting-play-frame-cap"
                type="number"
                min={1}
                step={1}
                className="min-h-[var(--touch-target,44px)]"
                data-testid="setting-play-frame-cap"
                value={projectDocument.settings.playFrameCap}
                onChange={(event) =>
                  updateProjectSettings({
                    playFrameCap: Number(event.target.value) || 60,
                  })
                }
              />
              <FieldDescription>
                Caps Play and Preview. The editor viewport cap lives in Engine
                Settings.
              </FieldDescription>
            </Field>
          </FieldSet>
        </FieldGroup>
      ) : null}

      {showProjectBody && projectDocument && activeCategoryId === "textures" ? (
        <FieldGroup className="gap-4">
          <FieldSet>
            <FieldLegend>Textures</FieldLegend>
            <Field>
              <FieldLabel>Texture policy</FieldLabel>
              <FieldDescription>
                Max dimension{" "}
                {projectDocument.settings.textures.maxTextureDimension}
                px. Auto re-queue uncompressed:{" "}
                {projectDocument.settings.textures.autoRequeueUncompressed
                  ? "on"
                  : "off"}
                .
              </FieldDescription>
            </Field>
            <Button
              variant="outline"
              className="min-h-[var(--touch-target,44px)] w-fit"
              data-testid="retry-texture-encoding"
              onClick={() => void retryFailedTextureEncoding()}
            >
              Retry encoding
            </Button>
          </FieldSet>
        </FieldGroup>
      ) : null}

      {showProjectBody && projectDocument && activeCategoryId === "export" ? (
        <FieldGroup className="gap-4">
          <FieldSet>
            <FieldLegend>Export</FieldLegend>
            <Field>
              <FieldLabel>Export Project</FieldLabel>
              <FieldDescription>
                Download a zip of the project directory layout.
              </FieldDescription>
            </Field>
            <Button
              className="min-h-[var(--touch-target,44px)] w-fit"
              data-testid="export-project"
              onClick={() => void handleExport()}
            >
              Export Project
            </Button>
          </FieldSet>
        </FieldGroup>
      ) : null}

      {showProjectBody &&
      projectDocument &&
      activeCategoryId === "project" &&
      onCloseProject ? (
        <FieldGroup className="gap-4">
          <FieldSet>
            <FieldLegend>Close</FieldLegend>
            <Field>
              <FieldLabel>Close Project</FieldLabel>
              <FieldDescription>
                Returns to the Homepage after a dirty-document check.
              </FieldDescription>
            </Field>
            <Button
              variant="destructive"
              data-testid="close-project"
              className="min-h-[var(--touch-target,44px)] w-fit"
              onClick={() => {
                onOpenChange(false);
                onCloseProject();
              }}
            >
              <LogOutIcon data-icon="inline-start" />
              Close Project
            </Button>
          </FieldSet>
        </FieldGroup>
      ) : null}
    </CatalogDialog>
  );
}

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AssetPicker,
  CatalogDialog,
  ClassPicker,
  InputMappingEditor,
  NamedListEditor,
  NumberField,
  type CatalogCategory,
  type CatalogCategoryGroup,
} from "@babylonslate/editor-kit";
import type { ProjectInputSettings } from "@babylonslate/core";
import { normalizeInputMappings } from "@babylonslate/input";
import { Button } from "@babylonslate/ui/components/button";
import { Checkbox } from "@babylonslate/ui/components/checkbox";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@babylonslate/ui/components/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@babylonslate/ui/components/select";
import { Switch } from "@babylonslate/ui/components/switch";
import {
  createAppSettingsStore,
  defaultEngineSettings,
  type EngineSettings,
} from "@babylonslate/vfs";
import { LogOutIcon } from "lucide-react";
import { useDocuments } from "../context/document-context";
import { dispatchEngineSettingsChanged } from "../lib/viewport-render-gate";
import { editorUtilityObjectClassEntries } from "../lib/editor-utility-classes";
import {
  EngineSettingsForm,
  type EngineSettingsCategoryId,
} from "./engine-settings-form";
import { PlayPreviewSettingsFields } from "./play-preview-settings-fields";

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
    keywords: "project name version touch target editor utility objects",
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
    id: "fonts",
    label: "Fonts",
    keywords: "default font fallback family stack",
  },
  {
    id: "rendering",
    label: "Rendering",
    keywords:
      "frame cap fps play preview aspect ratio letterbox follow system custom resolution width height black bars",
  },
  {
    id: "textures",
    label: "Textures",
    keywords: "max dimension encoding retry compression",
  },
  {
    id: "export",
    label: "Export",
    keywords: "export project zip download startup scene packaged player",
  },
  {
    id: "project",
    label: "Close",
    keywords: "close project homepage dirty save",
  },
];

const PROJECT_GROUPS: CatalogCategoryGroup[] = [
  { label: "Project", ids: ["general", "input", "twoD", "fonts", "rendering", "textures", "export"] },
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
    id: "graph",
    label: "Graph",
    keywords: "graph default zoom node canvas fit view",
  },
  {
    id: "ui",
    label: "User Interface",
    keywords: "ui designer preset canvas size safe area",
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
  {
    id: "focus",
    label: "Focus",
    keywords: "focus keep tabs panels layout",
  },
];

const GENERIC_FONT_FALLBACKS = [
  "sans-serif",
  "serif",
  "monospace",
  "system-ui",
] as const;

const ENGINE_GROUPS: CatalogCategoryGroup[] = [
  { label: "Editor", ids: ["appearance", "undo", "viewport", "graph", "ui", "thumbnails", "focus"] },
  { label: "Projects", ids: ["templates"] },
];

function matchesSearch(
  label: string,
  keywords: string,
  needle: string,
): boolean {
  return !needle || `${label} ${keywords}`.toLowerCase().includes(needle);
}

function collectTouchControlIds(
  documents: ReadonlyArray<{ ref: { kind: string }; content: unknown }>,
): string[] {
  const ids = new Set(["joystick-x", "joystick-y", "dpad-x", "dpad-y"]);
  for (const doc of documents) {
    if (doc.ref.kind !== "ui") continue;
    const payload =
      doc.content && typeof doc.content === "object"
        ? (doc.content as Record<string, unknown>)
        : {};
    const widgets =
      payload.widgets && typeof payload.widgets === "object"
        ? (payload.widgets as Record<string, { props?: Record<string, unknown> }>)
        : {};
    for (const widget of Object.values(widgets)) {
      const props = widget.props ?? {};
      for (const key of ["controlId", "controlIdX", "controlIdY"] as const) {
        const value = props[key];
        if (typeof value === "string" && value.trim()) ids.add(value.trim());
      }
    }
  }
  return [...ids];
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
    assetRegistry,
    openDocuments,
  } = useDocuments();
  const [search, setSearch] = useState("");
  const [fontPickerOpen, setFontPickerOpen] = useState(false);
  const [scenePickerOpen, setScenePickerOpen] = useState(false);
  const [utilityPick, setUtilityPick] = useState<"new" | number | null>(null);
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
        graphDefaultZoom: next.graphDefaultZoom,
        uiDesignerPresets: next.uiDesignerPresets,
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
    <>
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
            <Field orientation="horizontal">
              <FieldLabel htmlFor="settings-compile-on-save">
                Compile on save
              </FieldLabel>
              <Switch
                id="settings-compile-on-save"
                checked={projectDocument.settings.compileOnSave}
                onCheckedChange={(checked) =>
                  updateProjectSettings({ compileOnSave: checked === true })
                }
                data-testid="settings-compile-on-save"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="settings-autosave-interval">
                Auto-save interval (seconds)
              </FieldLabel>
              <NumberField
                id="settings-autosave-interval"
                min={1}
                className="min-h-[var(--chrome-row,28px)]"
                value={Math.round(
                  projectDocument.settings.autoSaveIntervalMs / 1000,
                )}
                onChange={(seconds) => {
                  updateProjectSettings({
                    autoSaveIntervalMs: Math.round(seconds * 1000),
                  });
                }}
                data-testid="settings-autosave-interval"
              />
            </Field>
            <Field>
              <FieldLabel>Editor Utility Objects</FieldLabel>
              <NamedListEditor
                values={projectDocument.settings.editorUtilityObjects}
                onChange={(editorUtilityObjects) =>
                  updateProjectSettings({ editorUtilityObjects })
                }
                addLabel="Add Class"
                onAdd={() => setUtilityPick("new")}
                data-testid="settings-editor-utility-objects"
                renderItem={({ value, index }) => (
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-[var(--touch-target,44px)] w-full justify-start"
                    data-testid={`settings-editor-utility-objects-${index}`}
                    onClick={() => setUtilityPick(index)}
                  >
                    {value}
                  </Button>
                )}
              />
              <FieldDescription>
                EditorUtilityObject classes that run in the editor ScriptHost.
                They are not compiled into Play.
              </FieldDescription>
            </Field>
          </FieldSet>
        </FieldGroup>
      ) : null}

      {showProjectBody && projectDocument && activeCategoryId === "input" ? (
        <FieldGroup className="gap-4">
          <FieldSet>
            <FieldLegend>Input</FieldLegend>
            <FieldDescription>
              Named actions and axes bind keys, gamepad, and touch controls.
              Tap Bind, then press a key or button.
            </FieldDescription>
            <InputMappingEditor
              value={normalizeInputMappings(projectDocument.settings.input)}
              onChange={(input) =>
                updateProjectSettings({
                  input: input as unknown as ProjectInputSettings,
                })
              }
              touchControlIds={collectTouchControlIds(openDocuments)}
              data-testid="settings-input-mapping"
            />
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
            <FieldDescription>
              Does not step the editor camera. Pinch and wheel stay continuous;
              pixel-perfect still snaps pan to the pixel grid.
            </FieldDescription>
            <Field>
              <FieldLabel>Sorting Layers</FieldLabel>
              <NamedListEditor
                values={twoD.sortingLayers}
                onChange={(sortingLayers) =>
                  updateProjectSettings({
                    twoD: { ...twoD, sortingLayers },
                  })
                }
                addPlaceholder="Layer"
                addLabel="Add Layer"
                data-testid="settings-sorting-layers"
              />
              <FieldDescription>
                Back to front. Compiles to one alphaIndex sort key per sprite.
              </FieldDescription>
            </Field>
          </FieldSet>
        </FieldGroup>
      ) : null}

      {showProjectBody && projectDocument && activeCategoryId === "fonts" ? (
        <FieldGroup>
          <FieldSet>
            <FieldLegend>Fonts</FieldLegend>
            <Field>
              <FieldLabel>Default Font</FieldLabel>
              <Button
                type="button"
                variant="outline"
                className="min-h-[var(--touch-target,44px)] w-full justify-start"
                onClick={() => setFontPickerOpen(true)}
                data-testid="settings-default-font"
              >
                {assetRegistry
                  ?.list()
                  .find(
                    (asset) =>
                      asset.header.guid ===
                      projectDocument.settings.fonts.defaultFontGuid,
                  )?.header.name ?? "None"}
              </Button>
              <FieldDescription>
                Font asset used when a widget omits a family. Empty means the
                compiled stack starts from the widget family plus the global
                fallback.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="settings-global-fallback">
                Global Fallback
              </FieldLabel>
              <Select
                value={projectDocument.settings.fonts.globalFallback}
                onValueChange={(value) =>
                  updateProjectSettings({
                    fonts: {
                      ...projectDocument.settings.fonts,
                      globalFallback: String(value),
                    },
                  })
                }
              >
                <SelectTrigger
                  id="settings-global-fallback"
                  className="min-h-[var(--touch-target,44px)] w-full"
                  data-testid="settings-global-fallback"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[
                    ...GENERIC_FONT_FALLBACKS,
                    projectDocument.settings.fonts.globalFallback,
                  ]
                    .filter(
                      (family, index, all) => all.indexOf(family) === index,
                    )
                    .map((family) => (
                      <SelectItem key={family} value={family}>
                        {family}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <FieldDescription>
                Generic CSS family appended to every compiled stack (never silent
                Arial).
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
              <NumberField
                id="setting-play-frame-cap"
                min={1}
                className="min-h-[var(--touch-target,44px)]"
                data-testid="setting-play-frame-cap"
                value={projectDocument.settings.playFrameCap}
                onChange={(playFrameCap) =>
                  updateProjectSettings({ playFrameCap })
                }
              />
              <FieldDescription>
                Caps Play and Preview. The editor viewport cap lives in Engine
                Settings.
              </FieldDescription>
            </Field>
            <Field orientation="horizontal">
              <FieldLabel htmlFor="setting-render-custom">
                Custom Resolution
              </FieldLabel>
              <Switch
                id="setting-render-custom"
                checked={projectDocument.settings.render.customResolution}
                onCheckedChange={(checked) =>
                  updateProjectSettings({
                    render: {
                      ...projectDocument.settings.render,
                      customResolution: checked === true,
                    },
                  })
                }
                data-testid="setting-render-custom"
              />
            </Field>
            <FieldDescription>
              Lock Play and packaged builds to a fixed framebuffer. Off keeps
              Follow System fill. Editor viewports still fill the panel.
            </FieldDescription>
            <Field>
              <FieldLabel htmlFor="setting-render-width">
                Render Size
              </FieldLabel>
              <div className="flex items-center gap-2">
                <NumberField
                  id="setting-render-width"
                  min={1}
                  step={1}
                  disabled={!projectDocument.settings.render.customResolution}
                  className="min-h-[var(--touch-target,44px)]"
                  value={projectDocument.settings.render.width}
                  onChange={(width) =>
                    updateProjectSettings({
                      render: { ...projectDocument.settings.render, width },
                    })
                  }
                  data-testid="setting-render-width"
                  aria-label="Render Width"
                />
                <span aria-hidden="true">×</span>
                <NumberField
                  id="setting-render-height"
                  min={1}
                  step={1}
                  disabled={!projectDocument.settings.render.customResolution}
                  className="min-h-[var(--touch-target,44px)]"
                  value={projectDocument.settings.render.height}
                  onChange={(height) =>
                    updateProjectSettings({
                      render: { ...projectDocument.settings.render, height },
                    })
                  }
                  data-testid="setting-render-height"
                  aria-label="Render Height"
                />
              </div>
            </Field>
            <Field orientation="horizontal">
              <Checkbox
                id="setting-render-black-bars"
                checked={projectDocument.settings.render.blackBars}
                disabled={!projectDocument.settings.render.customResolution}
                onCheckedChange={(checked) =>
                  updateProjectSettings({
                    render: {
                      ...projectDocument.settings.render,
                      blackBars: checked === true,
                    },
                  })
                }
                data-testid="setting-render-black-bars"
              />
              <FieldLabel htmlFor="setting-render-black-bars">
                Black Bars
              </FieldLabel>
            </Field>
            <FieldDescription>
              Off stretches the framebuffer to fill Play. On letterboxes with
              unused overlay space black.
            </FieldDescription>
            <PlayPreviewSettingsFields
              settings={projectDocument.settings.playPreview}
              onChange={(playPreview) =>
                updateProjectSettings({ playPreview })
              }
            />
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
              Retry Encoding
            </Button>
          </FieldSet>
        </FieldGroup>
      ) : null}

      {showProjectBody && projectDocument && activeCategoryId === "export" ? (
        <FieldGroup className="gap-4">
          <FieldSet>
            <FieldLegend>Export</FieldLegend>
            <Field>
              <FieldLabel>Startup Scene</FieldLabel>
              <Button
                type="button"
                variant="outline"
                className="min-h-[var(--touch-target,44px)] w-full justify-start"
                onClick={() => setScenePickerOpen(true)}
                data-testid="settings-startup-scene"
              >
                {assetRegistry
                  ?.list()
                  .find(
                    (asset) =>
                      asset.header.guid ===
                      projectDocument.settings.startupSceneGuid,
                  )?.header.name ?? "None"}
              </Button>
              <FieldDescription>
                Packaged builds boot this scene. Editor Play uses the open scene
                tab.
              </FieldDescription>
            </Field>
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
      {scope === "project" ? (
        <AssetPicker
          open={fontPickerOpen}
          onOpenChange={setFontPickerOpen}
          assets={(assetRegistry?.list() ?? [])
            .filter((asset) => asset.header.type === "Font")
            .map((asset) => ({
              guid: asset.header.guid,
              name: asset.header.name,
              type: asset.header.type,
              path: asset.path,
            }))}
          allowedTypes={["Font"]}
          title="Pick Font"
          allowNone
          onPick={(guid) => {
            if (!projectDocument) return;
            updateProjectSettings({
              fonts: {
                ...projectDocument.settings.fonts,
                defaultFontGuid: guid,
              },
            });
            setFontPickerOpen(false);
          }}
          data-testid="settings-default-font-picker"
        />
      ) : null}
      {scope === "project" ? (
        <AssetPicker
          open={scenePickerOpen}
          onOpenChange={setScenePickerOpen}
          assets={(assetRegistry?.list() ?? [])
            .filter((asset) => asset.header.type === "Scene")
            .map((asset) => ({
              guid: asset.header.guid,
              name: asset.header.name,
              type: asset.header.type,
              path: asset.path,
            }))}
          allowedTypes={["Scene"]}
          title="Pick Scene"
          allowNone={false}
          onPick={(guid) => {
            if (!projectDocument || !guid) return;
            updateProjectSettings({ startupSceneGuid: guid });
            setScenePickerOpen(false);
          }}
          data-testid="settings-startup-scene-picker"
        />
      ) : null}
      {scope === "project" ? (
        <ClassPicker
          open={utilityPick !== null}
          onOpenChange={(next) => {
            if (!next) setUtilityPick(null);
          }}
          classes={editorUtilityObjectClassEntries(assetRegistry?.list() ?? [])}
          title="Pick Editor Utility Object"
          allowNone={false}
          onPick={(classId) => {
            if (!projectDocument || !classId) {
              setUtilityPick(null);
              return;
            }
            const current = projectDocument.settings.editorUtilityObjects;
            if (utilityPick === "new") {
              if (!current.includes(classId)) {
                updateProjectSettings({
                  editorUtilityObjects: [...current, classId],
                });
              }
            } else if (typeof utilityPick === "number") {
              const next = [...current];
              next[utilityPick] = classId;
              updateProjectSettings({
                editorUtilityObjects: [...new Set(next)],
              });
            }
            setUtilityPick(null);
          }}
          data-testid="settings-editor-utility-object-picker"
        />
      ) : null}
    </>
  );
}

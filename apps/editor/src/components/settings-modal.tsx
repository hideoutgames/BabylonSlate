import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AssetPicker,
  AssetPickerControl,
  CatalogDialog,
  ClassPicker,
  NamedListEditor,
  NumberField,
  assetRowIdentity,
  classRowIdentity,
  selectedPickerIdentity,
  type CatalogCategory,
  type CatalogCategoryGroup,
} from "@babylonslate/editor-kit";
import {
  defaultExportPreset,
  isErr,
  MAX_COLLISION_LAYERS,
} from "@babylonslate/core";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@babylonslate/ui/components/empty";
import { Button } from "@babylonslate/ui/components/button";
import { Alert, AlertDescription, AlertTitle } from "@babylonslate/ui/components/alert";
import { Checkbox } from "@babylonslate/ui/components/checkbox";
import { Input } from "@babylonslate/ui/components/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@babylonslate/ui/components/alert-dialog";
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
import { Slider } from "@babylonslate/ui/components/slider";
import {
  createAppSettingsStore,
  defaultEngineSettings,
  getHostPlatform,
  isTestModeEnabled,
  type EngineSettings,
} from "@babylonslate/vfs";
import { isSourceControlHost } from "@babylonslate/source-control";
import { LogOutIcon } from "lucide-react";
import { useDocuments } from "../context/document-context";
import { editorUtilityObjectClassEntries } from "../lib/editor-utility-classes";
import { gameInstanceClassEntries } from "../lib/component-property-rows";
import { projectArchiveDownloadName } from "../lib/display-project-name";
import { exportGameFailureMessage } from "../lib/export-game-failure";
import {
  EngineSettingsForm,
  type EngineSettingsCategoryId,
} from "./engine-settings-form";
import { PlayPreviewSettingsFields } from "./play-preview-settings-fields";
import { ProjectPluginsSettings } from "./project-plugins-settings";
import { ENGINE_SETTING_FIELDS, PROJECT_SETTING_FIELDS } from "../lib/settings-search";

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
    keywords:
      "project version build compile autosave editor utility objects infinite loop detection loop count",
  },
  {
    id: "twoD",
    label: "2D",
    keywords: "pixels per unit pixel perfect integer zoom sorting layers",
  },
  {
    id: "physics",
    label: "Physics",
    keywords: "collision layers collide mask havok",
  },
  {
    id: "fonts",
    label: "Fonts",
    keywords: "default font fallback family stack",
  },
  {
    id: "audio",
    label: "Audio",
    keywords: "mixer channel volume attenuation",
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
    id: "plugins",
    label: "Plugins",
    keywords: "plugins enable engine project starter content babplugin",
  },
  {
    id: "export",
    label: "Export",
    keywords:
      "export project zip download startup scene packaged player export game packed debugger file count",
  },
  {
    id: "sourceControl",
    label: "Source Control",
    keywords: "git lfs lock token repository branch poll auto lock",
  },
];

const PROJECT_GROUPS: CatalogCategoryGroup[] = [
  {
    label: "Project",
    ids: [
      "general",
      "twoD",
      "physics",
      "fonts",
      "audio",
      "rendering",
      "textures",
      "plugins",
      "export",
      "sourceControl",
    ],
  },
];

const ENGINE_CATEGORIES: Array<
  CatalogCategory & { keywords: string; id: EngineSettingsCategoryId }
> = [
  {
    id: "about",
    label: "About",
    keywords: "version channel build commit source release test",
  },
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
    keywords: "frame cap hardware scaling post processing camera speed fly",
  },
  {
    id: "assets",
    label: "Assets",
    keywords:
      "model import default scale glb gltf texture lod budget quality audio pcm voices",
  },
  {
    id: "graph",
    label: "Graph",
    keywords: "graph default zoom node canvas fit view assistant connection distance shake disconnect",
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
  {
    label: "Editor",
    ids: [
      "appearance",
      "undo",
      "viewport",
      "graph",
      "assets",
      "thumbnails",
      "focus",
      "about",
    ],
  },
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
    exportGameArtifact,
    zipExportedGame,
    retryFailedTextureEncoding,
    updateProjectSettings,
    updateProjectVersion,
    assetRegistry,
    sourceControl,
    prefillSourceControlFromGit,
  } = useDocuments();
  const [search, setSearch] = useState("");
  const settingsBodyRef = useRef<HTMLDivElement>(null);
  const [pendingFocus, setPendingFocus] = useState<{ targetId?: string } | null>(null);
  const [tokenDraft, setTokenDraft] = useState("");
  const [fontPickerOpen, setFontPickerOpen] = useState(false);
  const [mixerPickerOpen, setMixerPickerOpen] = useState(false);
  const [scenePickerOpen, setScenePickerOpen] = useState(false);
  const [gameInstancePickerOpen, setGameInstancePickerOpen] = useState(false);
  const [exportGameError, setExportGameError] = useState<string | null>(null);
  const [exportGameBusy, setExportGameBusy] = useState(false);
  const [exportProjectBusy, setExportProjectBusy] = useState(false);
  const [exportProjectError, setExportProjectError] = useState<string | null>(null);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [disableSourceControlOpen, setDisableSourceControlOpen] =
    useState(false);
  const [utilityPick, setUtilityPick] = useState<"new" | number | null>(null);
  const [activeCategoryId, setActiveCategoryId] = useState(
    scope === "engine" ? "appearance" : "general",
  );
  const store = useMemo(() => createAppSettingsStore(), []);
  const [engineSettings, setEngineSettings] = useState<EngineSettings>(
    defaultEngineSettings(),
  );

  useEffect(() => {
    setPendingFocus(null);
    if (!open) return;
    setSearch("");
    setActiveCategoryId(scope === "engine" ? "appearance" : "general");
    if (scope === "engine") {
      void store.load().then(setEngineSettings);
    }
  }, [open, scope, store]);

  const saveEngine = useCallback(
    async (patch: Partial<EngineSettings>) => {
      const next = await store.update((settings) => {
        Object.assign(settings, patch);
      });
      setEngineSettings(next);
      await onEngineSaved?.();
    },
    [onEngineSaved, store],
  );

  const source = scope === "engine" ? ENGINE_CATEGORIES : PROJECT_CATEGORIES;
  const showSourceControl = isSourceControlHost(
    getHostPlatform(),
    isTestModeEnabled(),
  );
  const groups = useMemo(() => {
    if (scope === "engine") return ENGINE_GROUPS;
    if (showSourceControl) return PROJECT_GROUPS;
    return PROJECT_GROUPS.map((group) => ({
      ...group,
      ids: group.ids.filter((id) => id !== "sourceControl"),
    }));
  }, [scope, showSourceControl]);

  const searching = search.trim().length > 0;
  const searchResults = useMemo(() => {
    const words = search.trim().toLowerCase().split(/\s+/);
    const available = source.filter((category) => category.id !== "sourceControl" || showSourceControl);
    const settingFields = scope === "engine" ? ENGINE_SETTING_FIELDS : PROJECT_SETTING_FIELDS;
    return available.flatMap((category) => {
      const matches = settingFields.filter((field) =>
        field.categoryId === category.id &&
        words.every((word) => `${category.label} ${field.label}`.toLowerCase().includes(word)),
      );
      if (matches.length) return matches;
      return words.every((word) => matchesSearch(category.label, category.keywords, word))
        ? [{ categoryId: category.id, label: category.label, targetId: undefined }]
        : [];
    });
  }, [scope, search, source, showSourceControl]);
  const categories = useMemo(() => source.filter((category) =>
    (category.id !== "sourceControl" || showSourceControl) &&
    (!searching || searchResults.some((result) => result.categoryId === category.id)),
  ), [source, showSourceControl, searching, searchResults]);

  useEffect(() => {
    if (!open || !pendingFocus || searching) return;
    const frame = requestAnimationFrame(() => {
      const target = pendingFocus.targetId ? document.getElementById(pendingFocus.targetId) : null;
      const control = target?.matches("input, button, select, textarea, [tabindex]")
        ? target
        : target?.querySelector<HTMLElement>("input, button, select, textarea, [tabindex]");
      const element = control && !control.matches(":disabled") ? control : settingsBodyRef.current;
      (target ?? element)?.scrollIntoView?.({ block: "nearest" });
      element?.focus({ preventScroll: true });
      setPendingFocus(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [open, pendingFocus, searching, activeCategoryId]);

  useEffect(() => {
    if (!categories.some((category) => category.id === activeCategoryId)) {
      setActiveCategoryId(categories[0]?.id ?? source[0]?.id ?? "general");
    }
  }, [activeCategoryId, categories, source]);

  const handleExport = async () => {
    if (!projectDocument || exportProjectBusy) return;
    setExportProjectBusy(true);
    setExportProjectError(null);
    setExportNotice(null);
    try {
      const bytes = await exportProject();
      const blob = new Blob([bytes.buffer as ArrayBuffer], { type: "application/zip" });
      const url = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = projectArchiveDownloadName(projectDocument.metadata.name);
        anchor.click();
        setExportNotice("Project backup prepared. Check your downloads.");
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch (error) {
      setExportProjectError(error instanceof Error ? error.message : String(error));
    } finally {
      setExportProjectBusy(false);
    }
  };

  const handleExportGame = async () => {
    if (!projectDocument) return;
    setExportGameBusy(true);
    setExportGameError(null);
    setExportNotice(null);
    try {
      const result = await exportGameArtifact();
      if (isErr(result)) {
        setExportGameError(exportGameFailureMessage(result.error));
        return;
      }
      const bytes = zipExportedGame(result.value);
      const blob = new Blob([bytes.buffer as ArrayBuffer], {
        type: "application/zip",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${projectDocument.metadata.name.replace(/\s+/g, "_")}.zip`;
      anchor.click();
      URL.revokeObjectURL(url);
      setExportNotice("Game export prepared. Check your downloads.");
    } catch (error) {
      console.error("[editor] Export Game failed", error);
      setExportGameError(exportGameFailureMessage(error));
    } finally {
      setExportGameBusy(false);
    }
  };

  const exportPreset =
    projectDocument?.settings.exportPresets[0] ?? defaultExportPreset();

  const twoD = projectDocument?.settings.twoD;
  const showProjectBody =
    scope === "project" && Boolean(projectDocument) && categories.length > 0;

  return (
    <>
    <CatalogDialog
      open={open}
      onOpenChange={onOpenChange}
      title={scope === "engine" ? "Engine Settings" : "Project Settings"}
      description={
          scope === "project" && !projectDocument
            ? "Open a project to edit settings."
            : undefined
      }
        className="settings-dialog"
      categories={categories}
      groups={groups}
      activeCategoryId={activeCategoryId}
      onCategoryChange={(id) => {
        setActiveCategoryId(id);
        setSearch("");
      }}
      search={search}
      onSearchChange={setSearch}
      searchPlaceholder="Search settings"
      data-testid={resolvedTestId}
      footer={
        <div className="flex items-center justify-end gap-2">
          {scope === "project" && projectDocument && onCloseProject ? (
            <Button
              variant="outline"
              data-testid="close-project"
              id="close-project"
              className="mr-auto min-h-[var(--chrome-row,28px)] w-fit"
              onClick={() => {
                onOpenChange(false);
                onCloseProject();
              }}
            >
              <LogOutIcon data-icon="inline-start" />
              Close Project
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Done
          </Button>
        </div>
      }
    >
      {searching ? (
        searchResults.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No Matching Settings</EmptyTitle>
              <EmptyDescription>Try another name or clear the search to browse categories.</EmptyDescription>
            </EmptyHeader>
            <Button variant="outline" size="sm" onClick={() => setSearch("")}>Clear Search</Button>
          </Empty>
        ) : (
          <div className="flex flex-col gap-1" aria-label="Matching Settings">
            {searchResults.map((result) => (
              <Button
                key={`${result.categoryId}:${result.label}`}
                variant="ghost"
                size="sm"
                className="h-auto min-h-[var(--chrome-row,28px)] justify-between gap-3 py-1 text-left"
                onClick={() => {
                  setActiveCategoryId(result.categoryId);
                  setSearch("");
                  setPendingFocus({ targetId: result.targetId });
                }}
              >
                <span className="min-w-0 truncate" title={result.label}>{result.label}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{source.find((category) => category.id === result.categoryId)?.label}</span>
              </Button>
            ))}
          </div>
        )
      ) : <div ref={settingsBodyRef} tabIndex={-1} className="outline-none">
      {scope === "engine" ? (
        <EngineSettingsForm
          settings={engineSettings}
          onChange={saveEngine}
          categoryId={activeCategoryId as EngineSettingsCategoryId}
        />
      ) : null}

        {showProjectBody &&
        projectDocument &&
        twoD &&
        activeCategoryId === "general" ? (
        <FieldGroup>
          <FieldSet>
            <FieldLegend>General</FieldLegend>
            <Field className="settings-field">
              <FieldLabel htmlFor="settings-project-version">Project Version</FieldLabel>
              <Input id="settings-project-version" data-testid="settings-project-version"
                value={projectDocument.metadata.version}
                onChange={event => updateProjectVersion(event.target.value)} />
              <FieldDescription>Included in packaged builds.</FieldDescription>
            </Field>
              <Field orientation="horizontal" className="settings-field">
              <FieldLabel htmlFor="settings-compile-on-save">
                  Compile On Save
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
              <Field orientation="horizontal" className="settings-field">
              <FieldLabel htmlFor="settings-infinite-loop-detection">
                Infinite Loop Detection
              </FieldLabel>
              <Switch
                id="settings-infinite-loop-detection"
                checked={projectDocument.settings.infiniteLoopDetection}
                onCheckedChange={(checked) =>
                  updateProjectSettings({
                    infiniteLoopDetection: checked === true,
                  })
                }
                data-testid="settings-infinite-loop-detection"
              />
            </Field>
            <FieldDescription>
                Stops runaway scripts during Play and Preview. Excluded from
                release exports.
            </FieldDescription>
              <Field className="settings-field">
                <FieldLabel htmlFor="settings-loop-count">
                  Loop Count
                </FieldLabel>
              <NumberField
                id="settings-loop-count"
                min={1}
                step={1}
                disabled={!projectDocument.settings.infiniteLoopDetection}
                  className="min-h-[var(--chrome-row,28px)]"
                value={projectDocument.settings.loopCount}
                onChange={(loopCount) => updateProjectSettings({ loopCount })}
                data-testid="settings-loop-count"
              />
            </Field>
              <Field className="settings-field">
              <FieldLabel htmlFor="settings-autosave-interval">
                  Auto-Save Interval (Seconds)
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
                      className="min-h-[var(--chrome-row,28px)] h-auto w-full justify-start"
                    data-testid={`settings-editor-utility-objects-${index}`}
                    onClick={() => setUtilityPick(index)}
                  >
                      {selectedPickerIdentity(
                        classRowIdentity({ id: value, name: value }),
                      )}
                  </Button>
                )}
              />
              <FieldDescription>
                  Classes that run only in the editor.
              </FieldDescription>
            </Field>
          </FieldSet>
        </FieldGroup>
      ) : null}

        {showProjectBody &&
        projectDocument &&
        twoD &&
        activeCategoryId === "twoD" ? (
        <FieldGroup className="gap-4">
          <FieldSet>
            <FieldLegend>2D</FieldLegend>
              <Field className="settings-field">
                <FieldLabel htmlFor="pixels-per-unit">
                  Pixels Per Unit
                </FieldLabel>
              <NumberField
                id="pixels-per-unit"
                min={1}
                step={1}
                  className="min-h-[var(--chrome-row,28px)]"
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
            </Field>
              <Field orientation="horizontal" className="settings-field">
              <FieldLabel htmlFor="settings-pixel-perfect">
                  Pixel-Perfect Mode
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
                Keeps pixels sharp and snaps the camera to the pixel grid.
            </FieldDescription>
              <Field orientation="horizontal" className="settings-field">
              <FieldLabel htmlFor="settings-integer-zoom">
                  Integer Zoom Steps
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
                Applies to game cameras; editor zoom stays continuous.
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
                <FieldDescription>Ordered back to front.</FieldDescription>
            </Field>
          </FieldSet>
        </FieldGroup>
      ) : null}

        {showProjectBody &&
        projectDocument &&
        activeCategoryId === "physics" ? (
        <FieldGroup>
          <FieldSet>
            <FieldLegend>Physics</FieldLegend>
            <Field>
              <FieldLabel>Collision Layers</FieldLabel>
              <NamedListEditor
                values={projectDocument.settings.physics.collisionLayers}
                onChange={(collisionLayers) =>
                  updateProjectSettings({
                    physics: {
                      collisionLayers: collisionLayers.slice(
                        0,
                        MAX_COLLISION_LAYERS,
                      ),
                    },
                  })
                }
                addPlaceholder="Layer"
                addLabel="Add Layer"
                data-testid="settings-collision-layers"
              />
              <FieldDescription>
                  Names used by Layer and Collides With. Up to{" "}
                  {MAX_COLLISION_LAYERS} layers.
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
              <AssetPickerControl
                value={projectDocument.settings.fonts.defaultFontGuid}
              >
                <Button
                  type="button"
                  variant="outline"
                    className="min-h-[var(--chrome-row,28px)] h-auto w-full justify-start"
                  onClick={() => setFontPickerOpen(true)}
                  data-testid="settings-default-font"
                  id="settings-default-font"
                >
                  {selectedPickerIdentity(
                    assetRowIdentity(
                      (() => {
                        const asset = assetRegistry
                          ?.list()
                          .find(
                            (entry) =>
                              entry.header.guid ===
                              projectDocument.settings.fonts.defaultFontGuid,
                          );
                        return asset
                          ? {
                              name: asset.header.name,
                              type: asset.header.type,
                            }
                          : undefined;
                      })(),
                    ),
                  )}
                </Button>
              </AssetPickerControl>
              <FieldDescription>
                  Fallback when the requested font is unavailable.
              </FieldDescription>
            </Field>
              <Field className="settings-field">
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
                    className="min-h-[var(--chrome-row,28px)] w-full"
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
                  Used when no matching font is available.
              </FieldDescription>
            </Field>
          </FieldSet>
        </FieldGroup>
      ) : null}

      {showProjectBody && projectDocument && activeCategoryId === "audio" ? (
        <FieldGroup>
          <FieldSet>
            <FieldLegend>Audio</FieldLegend>
            <Field>
              <FieldLabel>Audio Mixer</FieldLabel>
              <AssetPickerControl
                value={projectDocument.settings.audio.audioMixerGuid}
              >
                <Button
                  type="button"
                  variant="outline"
                    className="min-h-[var(--chrome-row,28px)] h-auto w-full justify-start"
                  onClick={() => setMixerPickerOpen(true)}
                  data-testid="settings-audio-mixer"
                  id="settings-audio-mixer"
                >
                  {selectedPickerIdentity(
                    assetRowIdentity(
                      (() => {
                        const asset = assetRegistry
                          ?.list()
                          .find(
                            (entry) =>
                              entry.header.guid ===
                              projectDocument.settings.audio.audioMixerGuid,
                          );
                        return asset
                          ? {
                              name: asset.header.name,
                              type: asset.header.type,
                            }
                          : undefined;
                      })(),
                    ),
                  )}
                </Button>
              </AssetPickerControl>
              <FieldDescription>
                  None bypasses channel and master volume controls.
              </FieldDescription>
            </Field>
              <Field orientation="horizontal" className="settings-field">
              <FieldLabel htmlFor="settings-audio-occlusion">
                Occlusion
              </FieldLabel>
              <Switch
                id="settings-audio-occlusion"
                checked={projectDocument.settings.audio.occlusionEnabled}
                onCheckedChange={(checked) =>
                  updateProjectSettings({
                    audio: {
                      ...projectDocument.settings.audio,
                      occlusionEnabled: checked === true,
                    },
                  })
                }
                data-testid="settings-audio-occlusion"
              />
            </Field>
            <FieldDescription>
                Wall muffling for channels with Muffle Through Walls enabled.
            </FieldDescription>
            {(
              [
                  [
                    "settings-audio-reverb-wet-scale",
                    "Reverb Wet Scale",
                    "reverbWetScale",
                  ],
                  [
                    "settings-audio-reverb-decay-scale",
                    "Reverb Decay Scale",
                    "reverbDecayScale",
                  ],
                [
                  "settings-audio-reverb-damping-scale",
                  "Reverb Damping Scale",
                  "reverbDampingScale",
                ],
              ] as const
            ).map(([id, label, key]) => (
              <Field key={id}>
                <FieldLabel id={`${id}-label`} htmlFor={id}>{label}</FieldLabel>
                <div className="flex min-w-0 items-center gap-2">
                  <Slider
                    aria-labelledby={`${id}-label`}
                    className="min-w-0 flex-1"
                    min={0}
                    max={2}
                    step={0.05}
                    value={projectDocument.settings.audio[key]}
                    onValueChange={(next) => {
                      const scale = Array.isArray(next) ? next[0] : next;
                      if (typeof scale !== "number") return;
                      updateProjectSettings({
                        audio: {
                          ...projectDocument.settings.audio,
                          [key]: scale,
                        },
                      });
                    }}
                    data-testid={`${id}-slider`}
                  />
                  <div className="w-20 shrink-0">
                    <NumberField
                      id={id}
                      min={0}
                      max={2}
                      step={0.05}
                        className="min-h-[var(--chrome-row,28px)]"
                      value={projectDocument.settings.audio[key]}
                      onChange={(scale) =>
                        updateProjectSettings({
                          audio: {
                            ...projectDocument.settings.audio,
                            [key]: scale,
                          },
                        })
                      }
                      data-testid={id}
                    />
                  </div>
                </div>
              </Field>
            ))}
            <FieldDescription>
              Multiplies baked environment-reverb wet, decay, and damping
              (0–2). Channel-less stays dry.
            </FieldDescription>
          </FieldSet>
        </FieldGroup>
      ) : null}

        {showProjectBody &&
        projectDocument &&
        activeCategoryId === "rendering" ? (
        <FieldGroup className="gap-4">
          <FieldSet>
            <FieldLegend>Rendering</FieldLegend>
              <Field className="settings-field">
              <FieldLabel htmlFor="setting-play-frame-cap">
                  Play Frame Cap
              </FieldLabel>
              <NumberField
                id="setting-play-frame-cap"
                min={1}
                  className="min-h-[var(--chrome-row,28px)]"
                data-testid="setting-play-frame-cap"
                value={projectDocument.settings.playFrameCap}
                onChange={(playFrameCap) =>
                  updateProjectSettings({ playFrameCap })
                }
              />
              <FieldDescription>
                  Applies to Play and Preview.
              </FieldDescription>
            </Field>
              <Field orientation="horizontal" className="settings-field">
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
                Sets the design size for Play and exported games. Overrides
                Follow System.
            </FieldDescription>
              <Field className="settings-field">
              <FieldLabel htmlFor="setting-render-width">
                Render Size
              </FieldLabel>
              <div className="flex items-center gap-2">
                <NumberField
                  id="setting-render-width"
                  min={1}
                  step={1}
                  disabled={!projectDocument.settings.render.customResolution}
                    className="min-h-[var(--chrome-row,28px)]"
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
                    className="min-h-[var(--chrome-row,28px)]"
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
                Adds bars to preserve the design size. Off fills the window
                without stretching.
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

        {showProjectBody &&
        projectDocument &&
        activeCategoryId === "textures" ? (
        <FieldGroup className="gap-4">
          <FieldSet>
            <FieldLegend>Textures</FieldLegend>
            <Button
              variant="outline"
                className="min-h-[var(--chrome-row,28px)] w-fit"
              data-testid="retry-texture-encoding"
              id="retry-texture-encoding"
              onClick={() => void retryFailedTextureEncoding()}
            >
              Retry Encoding
            </Button>
          </FieldSet>
        </FieldGroup>
      ) : null}

        {showProjectBody &&
        projectDocument &&
        activeCategoryId === "plugins" ? (
        <ProjectPluginsSettings />
      ) : null}

      {showProjectBody && projectDocument && activeCategoryId === "export" ? (
        <FieldGroup className="gap-4">
          <FieldSet>
            <FieldLegend>Export</FieldLegend>
            <Field>
              <FieldLabel>Startup Scene</FieldLabel>
              <AssetPickerControl
                value={projectDocument.settings.startupSceneGuid}
              >
                <Button
                  type="button"
                  variant="outline"
                    className="min-h-[var(--chrome-row,28px)] h-auto w-full justify-start"
                  onClick={() => setScenePickerOpen(true)}
                  data-testid="settings-startup-scene"
                  id="settings-startup-scene"
                >
                  {selectedPickerIdentity(
                    assetRowIdentity(
                      (() => {
                        const asset = assetRegistry
                          ?.list()
                          .find(
                            (entry) =>
                              entry.header.guid ===
                              projectDocument.settings.startupSceneGuid,
                          );
                        return asset
                          ? {
                              name: asset.header.name,
                              type: asset.header.type,
                            }
                          : undefined;
                      })(),
                    ),
                  )}
                </Button>
              </AssetPickerControl>
              <FieldDescription>
                  Startup scene for exported games. Editor Play uses the open
                  scene.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel>Game Instance</FieldLabel>
              <Button
                type="button"
                variant="outline"
                  className="min-h-[var(--chrome-row,28px)] h-auto w-full justify-start"
                onClick={() => setGameInstancePickerOpen(true)}
                data-testid="settings-game-instance"
                id="settings-game-instance"
              >
                {selectedPickerIdentity(
                  classRowIdentity(
                      gameInstanceClassEntries(
                        assetRegistry?.list() ?? [],
                      ).find(
                      (entry) =>
                        entry.id ===
                        projectDocument.settings.gameInstanceClass,
                    ),
                    projectDocument.settings.gameInstanceClass,
                  ),
                )}
              </Button>
            </Field>
              <Field className="settings-field">
              <FieldLabel htmlFor="setting-export-packed">Packed</FieldLabel>
              <Switch
                id="setting-export-packed"
                checked={exportPreset.packed}
                onCheckedChange={(checked) => {
                  if (!projectDocument) return;
                  const current =
                    projectDocument.settings.exportPresets[0] ??
                    defaultExportPreset();
                  updateProjectSettings({
                    exportPresets: [{ ...current, packed: checked === true }],
                  });
                }}
                data-testid="setting-export-packed"
              />
              <FieldDescription>
                  Stores assets in a .babpack file. Off exports separate files.
              </FieldDescription>
            </Field>
              <Field className="settings-field">
              <FieldLabel htmlFor="setting-export-debugger">
                Bundle Debugger
              </FieldLabel>
              <Switch
                id="setting-export-debugger"
                checked={exportPreset.bundleDebugger}
                onCheckedChange={(checked) => {
                  if (!projectDocument) return;
                  const current =
                    projectDocument.settings.exportPresets[0] ??
                    defaultExportPreset();
                  updateProjectSettings({
                    exportPresets: [
                      { ...current, bundleDebugger: checked === true },
                    ],
                  });
                }}
                data-testid="setting-export-debugger"
              />
              <FieldDescription>
                  Includes debugging tools and Development Only nodes in the
                  export.
              </FieldDescription>
            </Field>
              <Field className="settings-field">
              <FieldLabel htmlFor="setting-export-file-warn">
                File Count Warn
              </FieldLabel>
              <NumberField
                id="setting-export-file-warn"
                min={1}
                value={exportPreset.fileCountWarn}
                onChange={(value) => {
                  if (!projectDocument) return;
                  const current =
                    projectDocument.settings.exportPresets[0] ??
                    defaultExportPreset();
                  updateProjectSettings({
                    exportPresets: [{ ...current, fileCountWarn: value }],
                  });
                }}
                data-testid="setting-export-file-warn"
              />
            </Field>
              <Field className="settings-field">
              <FieldLabel htmlFor="setting-export-file-fail">
                File Count Fail
              </FieldLabel>
              <NumberField
                id="setting-export-file-fail"
                min={1}
                value={exportPreset.fileCountFail}
                onChange={(value) => {
                  if (!projectDocument) return;
                  const current =
                    projectDocument.settings.exportPresets[0] ??
                    defaultExportPreset();
                  updateProjectSettings({
                    exportPresets: [{ ...current, fileCountFail: value }],
                  });
                }}
                data-testid="setting-export-file-fail"
              />
            </Field>
            <Field>
              <FieldDescription>
                  Playable ZIP for web hosting.
              </FieldDescription>
            </Field>
            {exportGameError ? (
                <p
                  className="text-sm text-destructive"
                  data-testid="export-game-error"
                >
                {exportGameError}
              </p>
            ) : null}
            <Button
                className="min-h-[var(--chrome-row,28px)] w-fit"
              data-testid="export-game"
              id="export-game"
              disabled={exportGameBusy}
              onClick={() => void handleExportGame()}
            >
              {exportGameBusy ? "Exporting Game…" : "Export Game"}
            </Button>
            <Field>
                <FieldDescription>Editable project backup.</FieldDescription>
            </Field>
            <Button
                className="min-h-[var(--chrome-row,28px)] w-fit"
              data-testid="export-project"
              id="export-project"
              disabled={exportProjectBusy}
              onClick={() => void handleExport()}
            >
              {exportProjectBusy ? "Exporting Project…" : "Export Project"}
            </Button>
            {exportProjectError ? (
              <Alert variant="destructive">
                <AlertTitle>Project Export Failed</AlertTitle>
                <AlertDescription>{exportProjectError}</AlertDescription>
              </Alert>
            ) : null}
            {exportNotice ? <p role="status" className="text-sm text-muted-foreground">{exportNotice}</p> : null}
          </FieldSet>
        </FieldGroup>
      ) : null}

      {showProjectBody &&
      projectDocument &&
      activeCategoryId === "sourceControl" ? (
        <FieldGroup>
          <FieldSet>
            <FieldLegend>Source Control</FieldLegend>
              <Field orientation="horizontal" className="settings-field">
              <FieldLabel htmlFor="settings-source-control-enabled">
                Enable
              </FieldLabel>
              <Switch
                id="settings-source-control-enabled"
                checked={projectDocument.settings.sourceControl.enabled}
                onCheckedChange={(checked) => {
                  const enabled = checked === true;
                  const current = projectDocument.settings.sourceControl;
                  if (!enabled) {
                    setDisableSourceControlOpen(true);
                    return;
                  }
                  updateProjectSettings({
                    sourceControl: { ...current, enabled },
                  });
                  if (!current.repositoryUrl) {
                    void prefillSourceControlFromGit().then((prefill) => {
                      if (!prefill.repositoryUrl && !prefill.branch) return;
                      updateProjectSettings({
                        sourceControl: {
                          ...current,
                          enabled: true,
                          repositoryUrl:
                            prefill.repositoryUrl || current.repositoryUrl,
                          branch: prefill.branch || current.branch,
                        },
                      });
                    });
                  }
                }}
                data-testid="settings-source-control-enabled"
              />
            </Field>
              <Field className="settings-field">
              <FieldLabel htmlFor="settings-source-control-url">
                Repository URL
              </FieldLabel>
              <Input
                id="settings-source-control-url"
                value={projectDocument.settings.sourceControl.repositoryUrl}
                onChange={(event) =>
                  updateProjectSettings({
                    sourceControl: {
                      ...projectDocument.settings.sourceControl,
                      repositoryUrl: event.target.value,
                    },
                  })
                }
                data-testid="settings-source-control-url"
              />
            </Field>
              <Field className="settings-field">
              <FieldLabel htmlFor="settings-source-control-branch">
                Branch
              </FieldLabel>
              <Input
                id="settings-source-control-branch"
                value={projectDocument.settings.sourceControl.branch}
                onChange={(event) =>
                  updateProjectSettings({
                    sourceControl: {
                      ...projectDocument.settings.sourceControl,
                      branch: event.target.value,
                    },
                  })
                }
                data-testid="settings-source-control-branch"
              />
            </Field>
              <Field orientation="horizontal" className="settings-field">
              <FieldLabel htmlFor="settings-source-control-auto-lock">
                Auto-Lock On First Edit
              </FieldLabel>
              <Switch
                id="settings-source-control-auto-lock"
                  checked={
                    projectDocument.settings.sourceControl.autoLockOnEdit
                  }
                onCheckedChange={(checked) =>
                  updateProjectSettings({
                    sourceControl: {
                      ...projectDocument.settings.sourceControl,
                      autoLockOnEdit: checked === true,
                    },
                  })
                }
                data-testid="settings-source-control-auto-lock"
              />
            </Field>
              <Field className="settings-field">
              <FieldLabel htmlFor="settings-source-control-poll">
                  Poll Interval (Seconds)
              </FieldLabel>
              <NumberField
                id="settings-source-control-poll"
                min={1}
                className="min-h-[var(--chrome-row,28px)]"
                value={Math.round(
                    projectDocument.settings.sourceControl.pollIntervalMs /
                      1000,
                )}
                onChange={(seconds) =>
                  updateProjectSettings({
                    sourceControl: {
                      ...projectDocument.settings.sourceControl,
                      pollIntervalMs: Math.round(seconds * 1000),
                    },
                  })
                }
                data-testid="settings-source-control-poll"
              />
            </Field>
              <Field className="settings-field">
              <FieldLabel htmlFor="settings-source-control-token">
                Token
              </FieldLabel>
              <Input
                id="settings-source-control-token"
                type="password"
                autoComplete="off"
                value={tokenDraft}
                onChange={(event) => setTokenDraft(event.target.value)}
                data-testid="settings-source-control-token"
              />
              <FieldDescription data-testid="settings-source-control-token-help">
                On GitHub, create a personal access token from{" "}
                <a
                  href="https://github.com/settings/tokens"
                  target="_blank"
                  rel="noreferrer"
                >
                  GitHub Token Settings
                </a>
                . Use a classic token with the repo scope, or a fine-grained
                token with Contents: Read and Write on this repository. GitLab
                and Gitea tokens with push access also work.
              </FieldDescription>
              <FieldDescription data-testid="settings-source-control-token-copy">
                {sourceControl.hasToken ? "Token Saved. " : ""}
                  Stored on this device for this project. Never included in
                  project files or Git.
              </FieldDescription>
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                  className="min-h-[var(--chrome-row,28px)]"
                data-testid="settings-source-control-save-token"
                disabled={!tokenDraft}
                onClick={() => {
                  void sourceControl.saveToken(tokenDraft).then(() => {
                    setTokenDraft("");
                  });
                }}
              >
                Save Token
              </Button>
              <Button
                type="button"
                variant="outline"
                  className="min-h-[var(--chrome-row,28px)]"
                data-testid="settings-source-control-clear-token"
                onClick={() => {
                  void sourceControl.clearToken().then(() => {
                    setTokenDraft("");
                  });
                }}
              >
                Clear Token
              </Button>
            </div>
          </FieldSet>
        </FieldGroup>
      ) : null}

      </div>}
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
          open={mixerPickerOpen}
          onOpenChange={setMixerPickerOpen}
          assets={(assetRegistry?.list() ?? [])
            .filter((asset) => asset.header.type === "AudioMixer")
            .map((asset) => ({
              guid: asset.header.guid,
              name: asset.header.name,
              type: asset.header.type,
              path: asset.path,
            }))}
          allowedTypes={["AudioMixer"]}
          title="Pick Audio Mixer"
          allowNone
          onPick={(guid) => {
            if (!projectDocument) return;
            updateProjectSettings({
              audio: {
                ...projectDocument.settings.audio,
                audioMixerGuid: guid,
              },
            });
            setMixerPickerOpen(false);
          }}
          data-testid="settings-audio-mixer-picker"
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
          allowNone
          onPick={(guid) => {
            if (!projectDocument) return;
            updateProjectSettings({ startupSceneGuid: guid });
            setScenePickerOpen(false);
          }}
          data-testid="settings-startup-scene-picker"
        />
      ) : null}
      {scope === "project" ? (
        <ClassPicker
          open={gameInstancePickerOpen}
          onOpenChange={setGameInstancePickerOpen}
          classes={gameInstanceClassEntries(assetRegistry?.list() ?? [])}
          title="Pick Game Instance"
          allowNone
          onPick={(classId) => {
            if (!projectDocument) return;
            updateProjectSettings({ gameInstanceClass: classId });
            setGameInstancePickerOpen(false);
          }}
          data-testid="settings-game-instance-picker"
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
      <AlertDialog
        open={disableSourceControlOpen}
        onOpenChange={setDisableSourceControlOpen}
      >
        <AlertDialogContent data-testid="settings-source-control-disable-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Turn Off Source Control?</AlertDialogTitle>
            <AlertDialogDescription>
              Locks stay until you release them. Turning Enable back on keeps
              the lock list.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="settings-source-control-disable-confirm-action"
              onClick={() => {
                if (!projectDocument) return;
                const current = projectDocument.settings.sourceControl;
                updateProjectSettings({
                  sourceControl: { ...current, enabled: false },
                });
                setDisableSourceControlOpen(false);
              }}
            >
              Turn Off
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

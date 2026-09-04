import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AssetPicker,
  AssetPickerControl,
  CatalogDialog,
  ClassPicker,
  InputMappingEditor,
  NamedListEditor,
  NumberField,
  assetRowIdentity,
  classRowIdentity,
  selectedPickerIdentity,
  type CatalogCategory,
  type CatalogCategoryGroup,
} from "@babylonslate/editor-kit";
import type { ProjectInputSettings } from "@babylonslate/core";
import { defaultExportPreset, isErr, MAX_COLLISION_LAYERS } from "@babylonslate/core";
import { normalizeInputMappings } from "@babylonslate/input";
import { Button } from "@babylonslate/ui/components/button";
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
    keywords: "project name version touch target editor utility objects infinite loop detection loop count",
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
    keywords: "export project zip download startup scene packaged player export game packed debugger file count",
  },
  {
    id: "sourceControl",
    label: "Source Control",
    keywords: "git lfs lock token repository branch poll auto lock",
  },
  {
    id: "project",
    label: "Done",
    keywords: "close project homepage dirty save done",
  },
];

const PROJECT_GROUPS: CatalogCategoryGroup[] = [
  { label: "Project", ids: ["general", "input", "twoD", "physics", "fonts", "audio", "rendering", "textures", "plugins", "export", "sourceControl"] },
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
    keywords: "frame cap hardware scaling post processing camera speed fly",
  },
  {
    id: "assets",
    label: "Assets",
    keywords: "model import default scale glb gltf texture lod budget quality audio pcm voices",
  },
  {
    id: "graph",
    label: "Graph",
    keywords: "graph default zoom node canvas fit view",
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
  { label: "Editor", ids: ["appearance", "undo", "viewport", "graph", "assets", "thumbnails", "focus"] },
  { label: "Projects", ids: ["templates"] },
];

function matchesSearch(
  label: string,
  keywords: string,
  needle: string,
): boolean {
  return !needle || `${label} ${keywords}`.toLowerCase().includes(needle);
}

function collectTouchControlIds(): string[] {
  return ["joystick-x", "joystick-y", "dpad-x", "dpad-y", "Jump"];
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
    assetRegistry,
    sourceControl,
    prefillSourceControlFromGit,
  } = useDocuments();
  const [search, setSearch] = useState("");
  const [tokenDraft, setTokenDraft] = useState("");
  const [fontPickerOpen, setFontPickerOpen] = useState(false);
  const [mixerPickerOpen, setMixerPickerOpen] = useState(false);
  const [scenePickerOpen, setScenePickerOpen] = useState(false);
  const [gameInstancePickerOpen, setGameInstancePickerOpen] = useState(false);
  const [exportGameError, setExportGameError] = useState<string | null>(null);
  const [exportGameBusy, setExportGameBusy] = useState(false);
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

  const categories = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return source.filter((category) => {
      if (category.id === "sourceControl" && !showSourceControl) return false;
      return matchesSearch(category.label, category.keywords, needle);
    });
  }, [search, source, showSourceControl]);

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
    anchor.download = projectArchiveDownloadName(projectDocument.metadata.name);
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const handleExportGame = async () => {
    if (!projectDocument) return;
    setExportGameBusy(true);
    setExportGameError(null);
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
            <Field orientation="horizontal">
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
              Editor Play and Preview Build abort compiled scripts that exceed
              Loop Count in one tick. Release exports never include this guard.
            </FieldDescription>
            <Field>
              <FieldLabel htmlFor="settings-loop-count">Loop Count</FieldLabel>
              <NumberField
                id="settings-loop-count"
                min={1}
                step={1}
                disabled={!projectDocument.settings.infiniteLoopDetection}
                className="min-h-[var(--touch-target,44px)]"
                value={projectDocument.settings.loopCount}
                onChange={(loopCount) => updateProjectSettings({ loopCount })}
                data-testid="settings-loop-count"
              />
              <FieldDescription>
                Iterations in one tick that count as an infinite loop.
              </FieldDescription>
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
                    className="min-h-[var(--touch-target,44px)] h-auto w-full justify-start"
                    data-testid={`settings-editor-utility-objects-${index}`}
                    onClick={() => setUtilityPick(index)}
                  >
                    {selectedPickerIdentity(classRowIdentity({ id: value, name: value }))}
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
              Pick a device, then choose a key or button from the list.
            </FieldDescription>
            <InputMappingEditor
              value={normalizeInputMappings(projectDocument.settings.input, {
                allowIncomplete: true,
              })}
              onChange={(input) =>
                updateProjectSettings({
                  input: input as unknown as ProjectInputSettings,
                })
              }
              touchControlIds={collectTouchControlIds()}
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

      {showProjectBody && projectDocument && activeCategoryId === "physics" ? (
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
                Named bits for collider Layer and Collides With. Storage stays
                32-bit. Maximum {MAX_COLLISION_LAYERS} layers.
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
                  className="min-h-[var(--touch-target,44px)] h-auto w-full justify-start"
                  onClick={() => setFontPickerOpen(true)}
                  data-testid="settings-default-font"
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
                Font asset inserted after authored families. Empty means the
                compiled stack is the source family plus the global fallback.
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
                  className="min-h-[var(--touch-target,44px)] h-auto w-full justify-start"
                  onClick={() => setMixerPickerOpen(true)}
                  data-testid="settings-audio-mixer"
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
                Optional mixer for Play and export. None plays Audio without
                channel or global gain.
              </FieldDescription>
            </Field>
            <Field orientation="horizontal">
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
              Muffles spatial sounds through baked occupancy walls when a
              channel enables Muffle Through Walls. Channel-less stays clear.
            </FieldDescription>
            {(
              [
                ["settings-audio-reverb-wet-scale", "Reverb Wet Scale", "reverbWetScale"],
                ["settings-audio-reverb-decay-scale", "Reverb Decay Scale", "reverbDecayScale"],
                [
                  "settings-audio-reverb-damping-scale",
                  "Reverb Damping Scale",
                  "reverbDampingScale",
                ],
              ] as const
            ).map(([id, label, key]) => (
              <Field key={id}>
                <FieldLabel htmlFor={id}>{label}</FieldLabel>
                <div className="flex min-w-0 items-center gap-2">
                  <Slider
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
                      className="min-h-[var(--touch-target,44px)]"
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
              Lock Play and packaged builds to a design size. Black Bars on
              letterboxes that WxH framebuffer. Off fills the host at the
              window size without stretching; the camera stays centered.
              Follow System applies only when this is off. Editor viewports
              still fill the panel.
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
              On letterboxes the locked WxH framebuffer; unused overlay space
              is black. Off fills the host at the window size without
              stretching. The camera stays centered.
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

      {showProjectBody && projectDocument && activeCategoryId === "plugins" ? (
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
                  className="min-h-[var(--touch-target,44px)] h-auto w-full justify-start"
                  onClick={() => setScenePickerOpen(true)}
                  data-testid="settings-startup-scene"
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
                Packaged builds boot this scene. Editor Play uses the open scene
                tab.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel>Game Instance</FieldLabel>
              <Button
                type="button"
                variant="outline"
                className="min-h-[var(--touch-target,44px)] h-auto w-full justify-start"
                onClick={() => setGameInstancePickerOpen(true)}
                data-testid="settings-game-instance"
              >
                {selectedPickerIdentity(
                  classRowIdentity(
                    gameInstanceClassEntries(assetRegistry?.list() ?? []).find(
                      (entry) =>
                        entry.id ===
                        projectDocument.settings.gameInstanceClass,
                    ),
                    projectDocument.settings.gameInstanceClass,
                  ),
                )}
              </Button>
              <FieldDescription>
                Play, Preview, and export construct this GameInstance subclass.
              </FieldDescription>
            </Field>
            <Field>
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
                Default packed `.babpack`. Off writes loose tree-shaken files.
              </FieldDescription>
            </Field>
            <Field>
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
                Off for release zips (strips Development Only). Preview Build
                always bundles the debugger.
              </FieldDescription>
            </Field>
            <Field>
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
            <Field>
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
              <FieldLabel>Export Game</FieldLabel>
              <FieldDescription>
                Download an itch.io zip that boots the startup scene. Distinct
                from Export Project backup.
              </FieldDescription>
            </Field>
            {exportGameError ? (
              <p className="text-sm text-destructive" data-testid="export-game-error">
                {exportGameError}
              </p>
            ) : null}
            <Button
              className="min-h-[var(--touch-target,44px)] w-fit"
              data-testid="export-game"
              disabled={exportGameBusy}
              onClick={() => void handleExportGame()}
            >
              Export Game
            </Button>
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
      activeCategoryId === "sourceControl" ? (
        <FieldGroup>
          <FieldSet>
            <FieldLegend>Source Control</FieldLegend>
            <Field orientation="horizontal">
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
            <Field>
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
            <Field>
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
            <Field orientation="horizontal">
              <FieldLabel htmlFor="settings-source-control-auto-lock">
                Auto-Lock On First Edit
              </FieldLabel>
              <Switch
                id="settings-source-control-auto-lock"
                checked={projectDocument.settings.sourceControl.autoLockOnEdit}
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
            <Field>
              <FieldLabel htmlFor="settings-source-control-poll">
                Poll Interval (seconds)
              </FieldLabel>
              <NumberField
                id="settings-source-control-poll"
                min={1}
                className="min-h-[var(--chrome-row,28px)]"
                value={Math.round(
                  projectDocument.settings.sourceControl.pollIntervalMs / 1000,
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
            <Field>
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
                Save Token stores it for this project on this device. It is not
                written into project files or git. Clear Token removes it from
                that store.
              </FieldDescription>
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                className="min-h-[var(--touch-target,44px)]"
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
                className="min-h-[var(--touch-target,44px)]"
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
              variant="outline"
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

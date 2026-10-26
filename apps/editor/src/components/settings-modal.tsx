import { ProjectSaveGamesSettings } from "./project-save-games-settings";
import { FocusNavigationFields } from "./focus-navigation-fields";
import { renderingDraft, mergeRenderingDraft, type RenderingDraft } from "../lib/render-settings-draft";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AssetPicker,
  AssetPickerControl,
  CatalogDialog,
  ClassPicker,
  CollisionPresetsField,
  NamedListEditor,
  NumberField,
  assetRowIdentity,
  classRowIdentity,
  selectedPickerIdentity,
  type AssetCreateOptions,
} from "@haptic/editor-kit";
import {
  MAX_COLLISION_LAYERS,
  normalizeRenderEffectsSettings,
} from "@haptic/core";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@haptic/ui/components/empty";
import { Button } from "@haptic/ui/components/button";
import { Input } from "@haptic/ui/components/input";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@haptic/ui/components/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@haptic/ui/components/select";
import { Switch } from "@haptic/ui/components/switch";
import {
  createAppSettingsStore,
  defaultEngineSettings,
  getHostPlatform,
  isTestModeEnabled,
  type EngineSettings,
} from "@haptic/vfs";
import { isSourceControlHost } from "@haptic/source-control";
import {
  useDocumentActions,
  useProjectState,
  useRegistryState,
  useSourceControl,
} from "../context/document-context";
import { editorUtilityObjectClassEntries } from "../lib/editor-utility-classes";
import { gameInstanceClassEntries } from "../lib/component-property-rows";
import {
  EngineSettingsForm,
  type EngineSettingsCategoryId,
} from "./engine-settings-form";
import { ProjectPluginsSettings } from "./project-plugins-settings";
import { ProjectExtensionsSettings } from "./project-extensions-settings";
import { ProjectGameSettings } from "./project-game-settings";
import { ProjectAudioSettings } from "./project-audio-settings";
import { ProjectRenderingSettings } from "./project-rendering-settings";
import { ProjectExportSettings } from "./project-export-settings";
import {
  DisableSourceControlDialog,
  ProjectSourceControlSettings,
} from "./project-source-control-settings";
import { useProjectExport } from "./use-project-export";
import {
  ENGINE_CATEGORIES,
  ENGINE_GROUPS,
  PROJECT_CATEGORIES,
  PROJECT_GROUPS,
  matchesSearch,
} from "../lib/settings-catalog";
import {
  ENGINE_SETTING_FIELDS,
  PROJECT_SETTING_FIELDS,
  renderingSectionForTarget,
  type RenderingSectionId,
} from "../lib/settings-search";

export type SettingsScope = "project" | "engine";

interface SettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: SettingsScope;
  onEngineSaved?: () => void | Promise<void>;
  "data-testid"?: string;
}

/**
 * Project Settings pickers create in the project content root, never beside
 * the active tab (which may sit in a plugin that can be disabled).
 */
const PROJECT_ASSET_CREATE_OPTIONS: AssetCreateOptions = { ownerPath: null };

const GENERIC_FONT_FALLBACKS = [
  "sans-serif",
  "serif",
  "monospace",
  "system-ui",
] as const;

export function SettingsModal({
  open,
  onOpenChange,
  scope,
  onEngineSaved,
  "data-testid": testId,
}: SettingsModalProps) {
  const resolvedTestId =
    testId ?? (scope === "engine" ? "engine-settings-modal" : "settings-modal");
  const {
    retryFailedTextureEncoding,
    updateProjectSettings: applyProjectSettings,
    updateProjectVersion,
    prefillSourceControlFromGit,
  } = useDocumentActions();
  const { projectDocument: liveProjectDocument } = useProjectState();
  const { projectGuid, assetRegistry, registryEpoch } = useRegistryState();
  const { sourceControl } = useSourceControl();
  const [draft, setDraft] = useState<RenderingDraft | null>(null);
  const draftOwner = useRef<{ guid: string | null; base: RenderingDraft } | null>(null);
  const latest = useRef({ project: liveProjectDocument, projectGuid, draft, applyProjectSettings });
  latest.current = { project: liveProjectDocument, projectGuid, draft, applyProjectSettings };
  const projectDocument = liveProjectDocument && draft
    ? { ...liveProjectDocument, settings: { ...liveProjectDocument.settings, ...draft } }
    : liveProjectDocument;
  const updateProjectSettings: typeof applyProjectSettings = (patch) => {
    const { render, playFrameCap, playPreview, ...immediate } = patch;
    if (Object.keys(immediate).length) applyProjectSettings(immediate);
    if (render !== undefined || playFrameCap !== undefined || playPreview !== undefined)
      setDraft((current) => ({ ...(current ?? renderingDraft(liveProjectDocument!.settings)),
        ...(render !== undefined ? { render } : {}),
        ...(playFrameCap !== undefined ? { playFrameCap } : {}),
        ...(playPreview !== undefined ? { playPreview } : {}),
      }));
  };
  const commitRendering = useCallback(() => {
    const owner = draftOwner.current;
    const current = latest.current;
    draftOwner.current = null;
    if (!owner || !current.project || !current.draft || owner.guid !== current.projectGuid) return;
    const merged = mergeRenderingDraft(owner.base, current.draft, current.project.settings);
    if (JSON.stringify(merged) !== JSON.stringify(renderingDraft(current.project.settings)))
      current.applyProjectSettings(merged);
  }, []);
  const changeOpen = (next: boolean) => {
    if (!next) commitRendering();
    onOpenChange(next);
  };
  useEffect(() => {
    if (open && scope === "project" && latest.current.project) {
      if (draftOwner.current?.guid === projectGuid) return;
      const base = renderingDraft(latest.current.project.settings);
      draftOwner.current = { guid: projectGuid, base };
      setDraft(base);
    } else {
      commitRendering();
      setDraft(null);
    }
  }, [open, scope, projectGuid, commitRendering]);
  const [search, setSearch] = useState("");
  const [openRenderingSections, setOpenRenderingSections] = useState<
    ReadonlySet<RenderingSectionId>
  >(() => new Set());
  const renderingSection = (id: RenderingSectionId) => ({
    open: openRenderingSections.has(id),
    onOpenChange: (open: boolean) =>
      setOpenRenderingSections((current) => {
        const next = new Set(current);
        if (open) next.add(id);
        else next.delete(id);
        return next;
      }),
  });
  const settingsBodyRef = useRef<HTMLDivElement>(null);
  const [pendingFocus, setPendingFocus] = useState<{ targetId?: string } | null>(null);
  const [tokenDraft, setTokenDraft] = useState("");
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [fontPickerOpen, setFontPickerOpen] = useState(false);
  const [mixerPickerOpen, setMixerPickerOpen] = useState(false);
  const [lutPickerOpen, setLutPickerOpen] = useState(false);
  const [scenePickerOpen, setScenePickerOpen] = useState(false);
  const [gameInstancePickerOpen, setGameInstancePickerOpen] = useState(false);
  const projectExport = useProjectExport(projectDocument);
  const [sourceControlUrlMissing, setSourceControlUrlMissing] = useState(false);
  const [disableSourceControlOpen, setDisableSourceControlOpen] =
    useState(false);
  const [utilityPick, setUtilityPick] = useState<"new" | number | null>(null);
  const [activeCategoryId, setActiveCategoryId] = useState(
    scope === "engine" ? "undo" : "general",
  );
  const store = useMemo(() => createAppSettingsStore(), []);
  const [engineSettings, setEngineSettings] = useState<EngineSettings>(
    defaultEngineSettings(),
  );

  useEffect(() => {
    setPendingFocus(null);
    if (!open) return;
    setSearch("");
    setActiveCategoryId(scope === "engine" ? "undo" : "general");
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

  const twoD = projectDocument?.settings.twoD;
  const showProjectBody =
    scope === "project" && Boolean(projectDocument) && categories.length > 0;
  // Registry headers mutate without replacing the registry, so key on the epoch.
  const pickerLists = useMemo(() => {
    void registryEpoch;
    const listed = scope === "project" ? assetRegistry?.list() ?? [] : [];
    const entriesOfType = (type: string) => listed
      .filter((asset) => asset.header.type === type)
      .map((asset) => ({
        guid: asset.header.guid,
        name: asset.header.name,
        type: asset.header.type,
        path: asset.path,
      }));
    return {
      fonts: entriesOfType("Font"),
      textures: entriesOfType("Texture"),
      audioMixers: entriesOfType("AudioMixer"),
      scenes: entriesOfType("Scene"),
      gameInstanceClasses: gameInstanceClassEntries(listed),
      editorUtilityClasses: editorUtilityObjectClassEntries(listed),
    };
  }, [scope, assetRegistry, registryEpoch]);
  const focusNavigationAssets = useMemo(() => {
    void registryEpoch;
    if (scope !== "project" || activeCategoryId !== "focusNavigation") return [];
    return (assetRegistry?.list() ?? []).map((asset) => ({ guid: asset.header.guid, name: asset.header.name, type: asset.header.type, path: asset.path, valueType: asset.header.payload?.valueType }));
  }, [scope, activeCategoryId, assetRegistry, registryEpoch]);

  return (
    <>
    <CatalogDialog
      open={open}
      onOpenChange={changeOpen}
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
          <Button
            variant="outline"
            onClick={() => changeOpen(false)}
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
                  const section = renderingSectionForTarget(result.targetId);
                  if (section) renderingSection(section).onOpenChange(true);
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
          focusTargetId={pendingFocus?.targetId}
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
                aria-describedby="settings-infinite-loop-description"
                checked={projectDocument.settings.infiniteLoopDetection}
                onCheckedChange={(checked) =>
                  updateProjectSettings({
                    infiniteLoopDetection: checked === true,
                  })
                }
                data-testid="settings-infinite-loop-detection"
              />
              <FieldDescription id="settings-infinite-loop-description">
                Stops runaway scripts in Play and Preview. Off in release exports.
              </FieldDescription>
            </Field>
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
                rejectOutOfRange
                aria-describedby="settings-autosave-description"
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
              <FieldDescription id="settings-autosave-description">
                Enter at least 1 second. Auto-save writes pending project changes at this interval.
              </FieldDescription>
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
        activeCategoryId === "game" ? (
        <ProjectGameSettings
          projectDocument={projectDocument}
          updateProjectSettings={updateProjectSettings}
          assetRegistry={assetRegistry}
          setScenePickerOpen={setScenePickerOpen}
          setGameInstancePickerOpen={setGameInstancePickerOpen}
        />
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
                      ...projectDocument.settings.physics,
                      collisionLayers: collisionLayers.slice(
                        0,
                        MAX_COLLISION_LAYERS,
                      ),
                    },
                  })
                }
                itemLabel="Collision Layer"
                addPlaceholder="New Layer"
                addLabel="Add Layer"
                data-testid="settings-collision-layers"
              />
              <FieldDescription>
                  Up to {MAX_COLLISION_LAYERS} layers.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel>Collision Presets</FieldLabel>
              <CollisionPresetsField
                layers={projectDocument.settings.physics.collisionLayers}
                value={projectDocument.settings.physics.collisionPresets}
                onChange={(collisionPresets) =>
                  updateProjectSettings({
                    physics: { ...projectDocument.settings.physics, collisionPresets },
                  })
                }
                data-testid="settings-collision-presets"
              />
              <FieldDescription>
                Each preset sets a Layer and an Ignore, Overlap or Block response to every layer. Colliders pick a preset or Custom.
              </FieldDescription>
            </Field>
          </FieldSet>
        </FieldGroup>
      ) : null}

      {showProjectBody && projectDocument && activeCategoryId === "saveGames" ? <ProjectSaveGamesSettings /> : null}
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
                  Used when a requested font is unavailable.
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
            </Field>
          </FieldSet>
        </FieldGroup>
      ) : null}

      {showProjectBody && projectDocument && activeCategoryId === "focusNavigation" ? <FocusNavigationFields
        value={projectDocument.settings.focusNavigation}
        onChange={(focusNavigation) => updateProjectSettings({ focusNavigation })}
        assets={focusNavigationAssets}
      /> : null}

      {showProjectBody && projectDocument && activeCategoryId === "audio" ? (
        <ProjectAudioSettings
          projectDocument={projectDocument}
          updateProjectSettings={updateProjectSettings}
          assetRegistry={assetRegistry}
          setMixerPickerOpen={setMixerPickerOpen}
        />
      ) : null}

        {showProjectBody &&
        projectDocument &&
        activeCategoryId === "rendering" ? (
        <ProjectRenderingSettings
          projectDocument={projectDocument}
          updateProjectSettings={updateProjectSettings}
          assetRegistry={assetRegistry}
          renderingSection={renderingSection}
          setLutPickerOpen={setLutPickerOpen}
        />
      ) : null}

        {showProjectBody &&
        projectDocument &&
        activeCategoryId === "textures" ? (
        <FieldGroup className="gap-4">
          <FieldSet>
            <FieldLegend>Textures</FieldLegend>
            <Field orientation="horizontal" className="settings-field">
              <FieldLabel htmlFor="retry-texture-encoding">Failed Encodes</FieldLabel>
              <Button
                variant="outline"
                size="sm"
                className="min-h-[var(--chrome-row,28px)] w-fit justify-self-end"
                data-testid="retry-texture-encoding"
                id="retry-texture-encoding"
                onClick={() => void retryFailedTextureEncoding()}
              >
                Retry Encoding
              </Button>
              <FieldDescription>Queues textures whose compression failed.</FieldDescription>
            </Field>
          </FieldSet>
        </FieldGroup>
      ) : null}

        {showProjectBody &&
        projectDocument &&
        activeCategoryId === "plugins" ? (
        <ProjectPluginsSettings />
      ) : null}
      {showProjectBody && projectDocument && activeCategoryId === "extensions" ? (
        <ProjectExtensionsSettings />
      ) : null}

      {showProjectBody && projectDocument && activeCategoryId === "export" ? (
        <ProjectExportSettings
          projectDocument={projectDocument}
          updateProjectSettings={updateProjectSettings}
          {...projectExport}
        />
      ) : null}

      {showProjectBody &&
      projectDocument &&
      activeCategoryId === "sourceControl" ? (
        <ProjectSourceControlSettings
          projectDocument={projectDocument}
          updateProjectSettings={updateProjectSettings}
          projectGuid={projectGuid}
          latest={latest}
          prefillSourceControlFromGit={prefillSourceControlFromGit}
          sourceControl={sourceControl}
          tokenDraft={tokenDraft}
          setTokenDraft={setTokenDraft}
          tokenError={tokenError}
          setTokenError={setTokenError}
          sourceControlUrlMissing={sourceControlUrlMissing}
          setSourceControlUrlMissing={setSourceControlUrlMissing}
          setDisableSourceControlOpen={setDisableSourceControlOpen}
        />
      ) : null}

      </div>}
    </CatalogDialog>
      {scope === "project" ? (
        <AssetPicker
          open={fontPickerOpen}
          onOpenChange={setFontPickerOpen}
          assets={pickerLists.fonts}
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
          open={lutPickerOpen}
          onOpenChange={setLutPickerOpen}
          assets={pickerLists.textures}
          allowedTypes={["Texture"]}
          title="Pick LUT Texture"
          allowNone
          onPick={(lutTextureGuid) => {
            if (!projectDocument) return;
            const effects = normalizeRenderEffectsSettings(projectDocument.settings.render.effects);
            updateProjectSettings({
              render: {
                ...projectDocument.settings.render,
                effects: { ...effects, colorGrading: { ...effects.colorGrading, lutTextureGuid } },
              },
            });
            setLutPickerOpen(false);
          }}
          data-testid="project-effects-lut-picker"
        />
      ) : null}
      {scope === "project" ? (
        <AssetPicker
          open={mixerPickerOpen}
          onOpenChange={setMixerPickerOpen}
          assets={pickerLists.audioMixers}
          allowedTypes={["AudioMixer"]}
          createOptions={PROJECT_ASSET_CREATE_OPTIONS}
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
          assets={pickerLists.scenes}
          allowedTypes={["Scene"]}
          createOptions={PROJECT_ASSET_CREATE_OPTIONS}
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
          classes={pickerLists.gameInstanceClasses}
          title="Pick Game Instance"
          allowNone
          createBaseClass="GameInstance"
          createOptions={PROJECT_ASSET_CREATE_OPTIONS}
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
          classes={pickerLists.editorUtilityClasses}
          title="Pick Editor Utility Object"
          allowNone={false}
          createBaseClass="EditorUtilityObject"
          createOptions={PROJECT_ASSET_CREATE_OPTIONS}
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
      <DisableSourceControlDialog
        disableSourceControlOpen={disableSourceControlOpen}
        setDisableSourceControlOpen={setDisableSourceControlOpen}
        projectDocument={projectDocument}
        updateProjectSettings={updateProjectSettings}
      />
    </>
  );
}

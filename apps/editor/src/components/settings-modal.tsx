import { ProjectSaveGamesSettings } from "./project-save-games-settings";
import { FocusNavigationFields } from "./focus-navigation-fields";
import { renderingDraft, mergeRenderingDraft, type RenderingDraft } from "../lib/render-settings-draft";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ExtensionSettingsPage } from "./extension-settings-page";
import { extensionSettingsCategories, extensionSettingsSearchFields, isExtensionSettingsCategoryId } from "../lib/extension-settings-ui";
import {
  AssetPicker,
  AssetPickerControl,
  CatalogDialog,
  ClassPicker,
  CollisionPresetsField,
  LabelHint,
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
  SettingsCategoryHeader,
  SettingsSection,
  SettingsSectionsProvider,
} from "./settings-section";
import { useSettingsSectionsHost } from "./use-settings-sections";
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
  type SettingSearchField,
} from "../lib/settings-search";

export type SettingsScope = "project" | "engine";

interface SettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: SettingsScope;
  /** Category shown when the dialog opens; defaults to the scope's first. */
  initialCategoryId?: string;
  onEngineSaved?: () => void | Promise<void>;
  "data-testid"?: string;
}

/**
 * Project Settings pickers create in the project content root, never beside
 * the active tab (which may sit in a plugin that can be disabled).
 */
const PROJECT_ASSET_CREATE_OPTIONS: AssetCreateOptions = { ownerPath: null };

// Label tooltips that also stay their control's screen-reader description.
const INFINITE_LOOP_HINT = "Stops runaway scripts in Play and Preview. Off in release exports.";
const GARBAGE_COLLECTION_HINT = "How often unreferenced Create Object objects are collected. 60 ticks is about one second.";

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
  initialCategoryId,
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
  const { projectGuid, assetRegistry, registryEpoch, extensionService } = useRegistryState();
  const extensionSnapshot = useSyncExternalStore(extensionService.subscribe, extensionService.getSnapshot);
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
  const settingsBodyRef = useRef<HTMLDivElement>(null);
  const [pendingFocus, setPendingFocus] = useState<{ targetId?: string } | null>(null);
  const [tokenDraft, setTokenDraft] = useState("");
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [fontPickerOpen, setFontPickerOpen] = useState(false);
  const [mixerPickerOpen, setMixerPickerOpen] = useState(false);
  const [appIconPickerOpen, setAppIconPickerOpen] = useState(false);
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
  const sections = useSettingsSectionsHost(scope, activeCategoryId);
  const store = useMemo(() => createAppSettingsStore(), []);
  const [engineSettings, setEngineSettings] = useState<EngineSettings>(
    defaultEngineSettings(),
  );

  useEffect(() => {
    setPendingFocus(null);
    if (!open) return;
    setSearch("");
    setActiveCategoryId(initialCategoryId ?? (scope === "engine" ? "undo" : "general"));
    if (scope === "engine") {
      void store.load().then(setEngineSettings);
    }
  }, [open, scope, store, initialCategoryId]);

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

  // Enabled extensions may add Project Settings categories under titles they choose; never Engine Settings.
  const extensionCategories = useMemo(() => scope === "project"
    ? extensionSettingsCategories(extensionSnapshot.entries, liveProjectDocument?.settings.extensionOverrides ?? {})
    : [], [extensionSnapshot.entries, liveProjectDocument?.settings.extensionOverrides, scope]);
  const source = useMemo(() => scope === "engine" ? ENGINE_CATEGORIES : [...PROJECT_CATEGORIES, ...extensionCategories],
    [extensionCategories, scope]);
  const showSourceControl = isSourceControlHost(
    getHostPlatform(),
    isTestModeEnabled(),
  );
  const groups = useMemo(() => {
    if (scope === "engine") return ENGINE_GROUPS;
    return PROJECT_GROUPS.map((group) => ({
      ...group,
      ids: [
        ...group.ids.filter((id) => showSourceControl || id !== "sourceControl"),
        ...(group.ids.includes("extensions") ? extensionCategories.map((category) => category.id) : []),
      ],
    }));
  }, [extensionCategories, scope, showSourceControl]);

  const searching = search.trim().length > 0;
  const searchResults = useMemo((): SettingSearchField[] => {
    const words = search.trim().toLowerCase().split(/\s+/);
    const available = source.filter((category) => category.id !== "sourceControl" || showSourceControl);
    const settingFields = scope === "engine" ? ENGINE_SETTING_FIELDS : [...PROJECT_SETTING_FIELDS, ...extensionSettingsSearchFields(extensionCategories)];
    return available.flatMap((category) => {
      const matches = settingFields.filter((field) =>
        field.categoryId === category.id &&
        words.every((word) => `${category.label} ${field.sectionTitle ?? ""} ${field.label}`.toLowerCase().includes(word)),
      );
      if (matches.length) return matches;
      return words.every((word) => matchesSearch(category.label, category.keywords, word))
        ? [{ categoryId: category.id, label: category.label }]
        : [];
    });
  }, [extensionCategories, scope, search, source, showSourceControl]);
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
            {searchResults.map((result) => {
              const categoryLabel = source.find((category) => category.id === result.categoryId)?.label;
              return (
                <Button
                  key={`${result.categoryId}:${result.sectionId ?? ""}:${result.label}`}
                  variant="ghost"
                  size="sm"
                  className="h-auto min-h-[var(--chrome-row,28px)] justify-between gap-3 py-1 text-left"
                  onClick={() => {
                    setActiveCategoryId(result.categoryId);
                    setSearch("");
                    if (result.sectionId) sections.openSection(result.categoryId, result.sectionId);
                    setPendingFocus({ targetId: result.targetId });
                  }}
                >
                  <span className="min-w-0 truncate" title={result.label}>{result.label}</span>
                  <span className="min-w-0 shrink truncate text-xs text-muted-foreground">
                    {result.sectionTitle ? `${categoryLabel} › ${result.sectionTitle}` : categoryLabel}
                  </span>
                </Button>
              );
            })}
          </div>
        )
      ) : <div ref={settingsBodyRef} tabIndex={-1} className="flex flex-col gap-2 outline-none">
      {scope === "engine" || showProjectBody ? (
        <SettingsCategoryHeader
          title={source.find((category) => category.id === activeCategoryId)?.label ?? ""}
          host={sections}
        />
      ) : null}
      <SettingsSectionsProvider value={sections.value}>
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
          <SettingsSection id="project" title="Project">
            <Field className="settings-field">
              <FieldLabel htmlFor="settings-project-version">Project Version</FieldLabel>
              <Input id="settings-project-version" data-testid="settings-project-version"
                value={projectDocument.metadata.version}
                onChange={event => updateProjectVersion(event.target.value)} />
            </Field>
              <Field className="settings-field">
              <FieldLabel htmlFor="settings-autosave-interval">
                  Auto-Save Interval (Seconds)
              </FieldLabel>
              <NumberField
                id="settings-autosave-interval"
                min={1}
                rejectOutOfRange
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
          </SettingsSection>
          <SettingsSection id="scripting" title="Scripting">
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
              <LabelHint hint={INFINITE_LOOP_HINT}>
                <FieldLabel htmlFor="settings-infinite-loop-detection">
                  Infinite Loop Detection
                </FieldLabel>
              </LabelHint>
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
              <FieldDescription id="settings-infinite-loop-description" className="sr-only">
                {INFINITE_LOOP_HINT}
              </FieldDescription>
            </Field>
              <Field className="settings-field settings-field-dependent" data-disabled={!projectDocument.settings.infiniteLoopDetection}>
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
                <LabelHint hint={GARBAGE_COLLECTION_HINT}>
                  <FieldLabel htmlFor="settings-garbage-collection-interval">
                    Garbage Collection Interval (Ticks)
                  </FieldLabel>
                </LabelHint>
              <NumberField
                id="settings-garbage-collection-interval"
                min={1}
                step={1}
                rejectOutOfRange
                aria-describedby="settings-garbage-collection-description"
                className="min-h-[var(--chrome-row,28px)]"
                value={projectDocument.settings.garbageCollectionIntervalTicks}
                onChange={(ticks) => updateProjectSettings({ garbageCollectionIntervalTicks: Math.max(1, Math.round(ticks)) })}
                data-testid="settings-garbage-collection-interval"
              />
              <FieldDescription id="settings-garbage-collection-description" className="sr-only">
                {GARBAGE_COLLECTION_HINT}
              </FieldDescription>
            </Field>
          </SettingsSection>
          <SettingsSection id="editorUtilityObjects" title="Editor Utility Objects">
            <Field className="settings-row">
              <FieldLabel className="sr-only">Editor Utility Objects</FieldLabel>
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
            </Field>
          </SettingsSection>
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
          <SettingsSection id="collisionLayers" title="Collision Layers">
            <Field className="settings-row">
              <FieldLabel className="sr-only">Collision Layers</FieldLabel>
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
              {projectDocument.settings.physics.collisionLayers.length >= MAX_COLLISION_LAYERS ? (
                <FieldDescription>
                  Up to {MAX_COLLISION_LAYERS} layers.
                </FieldDescription>
              ) : null}
            </Field>
          </SettingsSection>
          <SettingsSection id="collisionPresets" title="Collision Presets">
            <Field className="settings-row">
              <FieldLabel className="sr-only">Collision Presets</FieldLabel>
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
            </Field>
          </SettingsSection>
        </FieldGroup>
      ) : null}

      {showProjectBody && projectDocument && activeCategoryId === "saveGames" ? <ProjectSaveGamesSettings /> : null}
      {showProjectBody && projectDocument && activeCategoryId === "fonts" ? (
        <FieldGroup>
          <SettingsSection id="defaults" title="Defaults">
            <Field className="settings-field">
              <LabelHint hint="Used when a requested font is unavailable.">
                <FieldLabel>Default Font</FieldLabel>
              </LabelHint>
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
                        const guid = projectDocument.settings.fonts.defaultFontGuid;
                        const asset = guid ? assetRegistry?.getByGuid(guid) : undefined;
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
          </SettingsSection>
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
          setLutPickerOpen={setLutPickerOpen}
        />
      ) : null}

        {showProjectBody &&
        projectDocument &&
        activeCategoryId === "textures" ? (
        <FieldGroup>
          <SettingsSection id="encoding" title="Encoding">
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
            </Field>
          </SettingsSection>
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
      {showProjectBody && projectDocument && isExtensionSettingsCategoryId(activeCategoryId) ? (() => {
        const category = extensionCategories.find((value) => value.id === activeCategoryId);
        return category ? <ExtensionSettingsPage
          entry={category.entry}
          stored={projectDocument.settings.extensionSettings}
          onChange={(extensionSettings) => updateProjectSettings({ extensionSettings })}
        /> : null;
      })() : null}

      {showProjectBody && projectDocument && activeCategoryId === "export" ? (
        <ProjectExportSettings
          projectDocument={projectDocument}
          updateProjectSettings={updateProjectSettings}
          assetRegistry={assetRegistry}
          setAppIconPickerOpen={setAppIconPickerOpen}
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
      </SettingsSectionsProvider>
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
          open={appIconPickerOpen}
          onOpenChange={setAppIconPickerOpen}
          assets={pickerLists.textures}
          allowedTypes={["Texture"]}
          title="Pick App Icon"
          allowNone
          onPick={(iconTextureGuid) => {
            if (!projectDocument) return;
            updateProjectSettings({ appIdentity: { ...projectDocument.settings.appIdentity, iconTextureGuid } });
            setAppIconPickerOpen(false);
          }}
          data-testid="setting-app-icon-picker"
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

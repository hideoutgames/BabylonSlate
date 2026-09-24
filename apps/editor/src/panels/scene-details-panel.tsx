
import { ShadowSettingsFields, SHADOW_SETTINGS_SEARCH_TEXT } from "../components/shadow-settings-fields";
import { EnvironmentLightingFields, ENVIRONMENT_LIGHTING_SEARCH_TEXT } from "../components/environment-lighting-fields";
import { isEnvironmentTexturePayload, normalizeModelPayload } from "@babylonslate/assets";
import { MODEL_MATERIALS_PICKER_ENTRY, patchInspectorComponentProperty } from "../lib/mesh-material-properties";
import type { IDockviewPanelProps } from "dockview-react";
import { useCallback, useMemo, useState } from "react";
import { CelShadingFields } from "../components/cel-shading-fields";

import {
  AssetPicker,
  AssetPickerControl,
  MultilineTextField,
  EntryListEditor,
  DisclosureSection,
  NumberField,
  PanelFrame,
  PropertyGrid,
  SearchInput,
  SceneComponentPicker,
  TypeVisualIcon,
  assetRowIdentity,
  classRowIdentity,
  humanizePropertyLabel,
  resolveTypeVisual,
  selectedPickerIdentity,
  walkAncestry,
  type PropertyRow,
} from "@babylonslate/editor-kit";
import {
  DEFAULT_COLLISION_LAYERS,
  DEFAULT_SORTING_LAYERS,
  createDefaultSceneSettings,
  findActor,
  identitySerializedTransform,
  parseOverlayPanelProperties,
  parseText2DProperties,
  parseText3DProperties,
  patchComponentProperties,
  type SerializedActor,
  type SerializedScene,
  isSceneWorkspaceKind,
  normalizeCelShadingSettings,
  normalizeScenePostProcessStack,
  newGuid,
} from "@babylonslate/core";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  HashIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { Button } from "@babylonslate/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@babylonslate/ui/components/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@babylonslate/ui/components/empty";
import { Switch } from "@babylonslate/ui/components/switch";
import {
  Field,
  FieldGroup,
  FieldLabel,
} from "@babylonslate/ui/components/field";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import {
  useSceneEditing,
  selectionAfterLockChange,
} from "../context/scene-editing-context";
import { useOptionalNavBake } from "../context/nav-bake-context";
import { useOptionalSceneBake } from "../context/scene-bake-context";
import { IconActionButton } from "../components/icon-action-button";
import { NineSlicePreview } from "../components/nine-slice-preview";
import { AddComponentDialog } from "../components/add-component-dialog";
import {
  defaultPropertiesFor,
  prefabComponentLabel,
  projectAddComponentItems,
} from "./add-component-catalog";
import {
  applyPrefabPropertyDefaults,
  componentPropertyRows,
  gameInstanceClassEntries,
  type AssetPickRequest,
} from "../lib/component-property-rows";
import {
  sceneComponentDisplayLabel,
  sceneComponentEntries,
} from "../lib/scene-component-entries";
import {
  classParentLookup,
  isPostProcessMaterialForPicker,
} from "../lib/content-browser-helpers";
import { spatialTransformPropertyRows } from "../lib/transform-property-rows";
import { selectionTransformPropertyRows } from "../lib/selection-transform-property-rows";
import {
  fontAssetHasFacetype,
  fontAssetHasMsdfJson,
  fontAssetHasMsdfPng,
} from "../lib/play-fonts";
import { collectClassGraphsForPalette } from "../lib/logic-graph-document";
import { classIdForGraphPath } from "../services/script-compiler";
import { prefabTemplatesByClassId } from "../lib/prefab-instance-sync";

function PostProcessEntryId({ id, index }: { id: string; index: number }) {
  return (
    <Dialog>
      <DialogTrigger
        render={
          <IconActionButton
            label={`Pass ${index + 1} Entry ID`}
            className="shrink-0 pointer-coarse:size-11"
          />
        }
      >
        <HashIcon />
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pass {index + 1} Entry ID</DialogTitle>
          <DialogDescription>
            Copy this ID to target this pass with Get Post Process Entry.
          </DialogDescription>
        </DialogHeader>
        <PropertyGrid density="compact" rows={[{
          kind: "text",
          id: `scene-post-process-${id}-entry-id`,
          label: "Entry ID",
          value: id,
          readOnly: true,
          onChange: () => {},
        }]} />
      </DialogContent>
    </Dialog>
  );
}

export function SceneDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applySceneChange, projectDocument, assetRegistry } =
    useDocuments();
  const { selectedActorIds, setSelectedActorIds } = useSceneEditing();
  const navBake = useOptionalNavBake();
  const sceneBake = useOptionalSceneBake();
  const [propertyQuery, setPropertyQuery] = useState("");
  const [expandedOverrides, setExpandedOverrides] = useState<Set<string>>(() => new Set());
  const [filterCollapsedOverrides, setFilterCollapsedOverrides] = useState<Set<string>>(() => new Set());
  const [collapsedComponents, setCollapsedComponents] = useState<Set<string>>(
    () => new Set(),
  );
  const [filterCollapsedComponents, setFilterCollapsedComponents] = useState<
    Set<string>
  >(() => new Set());
  const needle = propertyQuery.trim().toLowerCase();
  const matches = (label: string) =>
    !needle || humanizePropertyLabel(label).toLowerCase().includes(needle);
  const overrideOpen = (id: string) => needle
    ? !filterCollapsedOverrides.has(id)
    : expandedOverrides.has(id);
  const setOverrideOpen = (id: string, open: boolean) => {
    const update = needle ? setFilterCollapsedOverrides : setExpandedOverrides;
    update((previous) => {
      const next = new Set(previous);
      if (needle ? !open : open) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const filterRows = (rows: PropertyRow[], section = "") =>
    matches(section)
      ? rows
      : rows.filter(
          (row) => matches(row.label) || matches(row.description ?? ""),
        );
  const propertySearch = (
    <div className="sticky top-0 z-10 bg-sidebar px-2 py-1">
      <SearchInput
        aria-label="Filter Properties"
        placeholder="Filter Properties"
        value={propertyQuery}
        onChange={(value) => {
          setPropertyQuery(value);
          setFilterCollapsedComponents(new Set());
          setFilterCollapsedOverrides(new Set());
        }}
      />
    </div>
  );
  const noMatchingProperties = (
    <Empty className="gap-2 p-4">
      <EmptyHeader>
        <EmptyTitle>No Matching Properties</EmptyTitle>
        <EmptyDescription>
          Try a property or component name, or clear the filter.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
  const [addComponentOpen, setAddComponentOpen] = useState(false);
  const [assetPick, setAssetPick] = useState<AssetPickRequest | null>(null);
  const [cameraPickerOpen, setCameraPickerOpen] = useState(false);
  const [envTexturePickOpen, setEnvTexturePickOpen] = useState(false);
  const [postProcessPick, setPostProcessPick] = useState<"add" | { id: string } | null>(
    null,
  );
  const [sceneLayerPick, setSceneLayerPick] = useState<"add" | number | null>(
    null,
  );
  const parentOf = classParentLookup(assetRegistry?.list() ?? []);
  const pickerAssets = (assetRegistry?.list() ?? []).map((asset) => ({
    guid: asset.header.guid,
    name: asset.header.name,
    type: asset.header.type,
    path: asset.path,
  }));
  const postProcessPickerAssets = (assetRegistry?.list() ?? [])
    .filter((asset) => isPostProcessMaterialForPicker(asset, openDocuments))
    .map((asset) => ({
      guid: asset.header.guid,
      name: asset.header.name,
      type: asset.header.type,
      path: asset.path,
    }));
  const environmentGuids = new Set((assetRegistry?.list() ?? [])
    .filter((asset) => isEnvironmentTexturePayload(asset.header.payload))
    .map((asset) => asset.header.guid));
  const environmentPickerAssets = pickerAssets.filter((entry) => environmentGuids.has(entry.guid));
  const classEntries = gameInstanceClassEntries(assetRegistry?.list() ?? []);
  const sortingLayers =
    projectDocument?.settings.twoD.sortingLayers ?? DEFAULT_SORTING_LAYERS;
  const collisionLayers =
    projectDocument?.settings.physics?.collisionLayers ??
    DEFAULT_COLLISION_LAYERS;
  const assetLabel = (guid: string | null | undefined) => {
    if (!guid) return undefined;
    return (
      assetRegistry?.getByGuid?.(guid)?.header.name ??
      pickerAssets.find((asset) => asset.guid === guid)?.name
    );
  };
  const assetType = (guid: string | null | undefined) => {
    if (!guid) return undefined;
    return (
      assetRegistry?.getByGuid?.(guid)?.header.type ??
      pickerAssets.find((asset) => asset.guid === guid)?.type
    );
  };
  const stackAssetPicker = (
    guid: string,
    id: string,
    label: string,
    onPick: () => void,
  ) => {
    const asset = pickerAssets.find((entry) => entry.guid === guid);
    return (
      <Field className="min-w-0 gap-0">
        <FieldLabel className="sr-only" htmlFor={id}>
          {label}
        </FieldLabel>
        <AssetPickerControl value={guid}>
          <Button
            type="button"
            id={id}
            variant="outline"
            size="sm"
            className="w-full min-w-0 justify-start pointer-coarse:min-h-11"
            title={
              asset ? `${asset.name} — ${asset.path}` : `Missing Asset: ${guid}`
            }
            data-testid={id}
            onClick={onPick}
          >
            {selectedPickerIdentity(
              { ...assetRowIdentity(asset), displayType: undefined },
              "Missing Asset",
            )}
          </Button>
        </AssetPickerControl>
      </Field>
    );
  };
  const fontHasFacetype = (guid: string | null | undefined) => {
    if (!guid) return false;
    return fontAssetHasFacetype(
      assetRegistry?.getByGuid?.(guid)?.header.payload,
    );
  };
  const fontHasMsdfJson = (guid: string | null | undefined) => {
    if (!guid) return false;
    return fontAssetHasMsdfJson(
      assetRegistry?.getByGuid?.(guid)?.header.payload,
    );
  };
  const fontHasMsdfPng = (guid: string | null | undefined) => {
    if (!guid) return false;
    return fontAssetHasMsdfPng(
      assetRegistry?.getByGuid?.(guid)?.header.payload,
    );
  };

  const doc = openDocuments.find((entry) => entry.id === documentId);
  const scene = isSceneWorkspaceKind(doc?.ref.kind)
    ? (doc.content as SerializedScene)
    : null;
  const overlay = doc?.ref.kind === "scene-layer";
  const postProcessEntries = normalizeScenePostProcessStack(scene?.settings.postProcessStack);
  const actorId = selectedActorIds[0] ?? null;
  const actor = scene && actorId ? (findActor(scene, actorId) ?? null) : null;
  const prefabTemplates = useMemo(() => {
    const assets = assetRegistry?.list() ?? [];
    const graphs = collectClassGraphsForPalette({
      assets,
      openDocuments,
      classIdForPath: classIdForGraphPath,
    });
    return prefabTemplatesByClassId({
      classIds: Object.keys(graphs),
      parentOf: classParentLookup(assets),
      graphs,
    });
  }, [assetRegistry, openDocuments]);

  const mutate = useCallback(
    (next: SerializedScene) => {
      void applySceneChange(documentId, next);
    },
    [applySceneChange, documentId],
  );

  const updateActor = useCallback(
    (update: (actor: SerializedActor) => SerializedActor) => {
      if (!scene || !actorId) return;
      mutate({
        ...scene,
        actors: scene.actors.map((entry) =>
          entry.id === actorId ? update(entry) : entry,
        ),
      });
    },
    [actorId, mutate, scene],
  );

  if (!scene) {
    return (
      <PanelFrame data-testid="scene-details-panel">
        <p className="p-4 text-sm text-muted-foreground">Open a scene.</p>
      </PanelFrame>
    );
  }

  if (!actor) {
    const defaults = createDefaultSceneSettings();
    const settingsRows: PropertyRow[] = [
      {
        kind: "text",
        id: "scene-name",
        label: "Name",
        value: scene.name,
        onChange: (name) => mutate({ ...scene, name }),
      },
      {
        kind: "asset",
        id: "scene-game-instance-class",
        label: "Game Instance",
        value: projectDocument?.settings.gameInstanceClass ?? null,
        placeholder: "None",
        disabled: true,
        onPick: () => {},
        onChange: () => {},
        ...classRowIdentity(
          classEntries.find(
            (entry) => entry.id === projectDocument?.settings.gameInstanceClass,
          ),
          projectDocument?.settings.gameInstanceClass,
        ),
      },
      {
        kind: "enum",
        id: "scene-viewport-mode",
        label: "Viewport",
        value: scene.viewportMode,
        options: [
          { value: "3d", label: "3D" },
          { value: "2d", label: "2D" },
        ],
        onChange: (mode) =>
          mutate({ ...scene, viewportMode: mode === "2d" ? "2d" : "3d" }),
      },
      {
        kind: "enum",
        id: "scene-physics-world",
        label: "Physics World",
        value: scene.settings.physicsWorld,
        options: [
          { value: "3d", label: "3D (Havok)" },
          { value: "2d", label: "2D (Rapier)" },
        ],
        onChange: (world) =>
          mutate({
            ...scene,
            settings: {
              ...scene.settings,
              physicsWorld: world === "2d" ? "2d" : "3d",
            },
          }),
      },
      {
        kind: "color",
        id: "scene-environment-color",
        label: "Environment",
        value: scene.settings.environmentColor,
        defaultValue: defaults.environmentColor,
        onChange: (environmentColor) =>
          mutate({
            ...scene,
            settings: { ...scene.settings, environmentColor },
          }),
      },
      {
        kind: "boolean",
        id: "scene-fog",
        label: "Fog",
        value: scene.settings.fogEnabled,
        defaultValue: defaults.fogEnabled,
        onChange: (fogEnabled) =>
          mutate({ ...scene, settings: { ...scene.settings, fogEnabled } }),
      },
      ...(scene.settings.fogEnabled
        ? [
            {
              kind: "color" as const,
              id: "scene-fog-color",
              label: "Fog Color",
              value: scene.settings.fogColor,
              defaultValue: defaults.fogColor,
              onChange: (fogColor: typeof scene.settings.fogColor) =>
                mutate({
                  ...scene,
                  settings: { ...scene.settings, fogColor },
                }),
            },
            {
              kind: "number" as const,
              id: "scene-fog-start",
              label: "Fog Start",
              value: scene.settings.fogStart,
              defaultValue: defaults.fogStart,
              onChange: (fogStart: number) =>
                mutate({
                  ...scene,
                  settings: { ...scene.settings, fogStart },
                }),
            },
            {
              kind: "number" as const,
              id: "scene-fog-end",
              label: "Fog End",
              value: scene.settings.fogEnd,
              defaultValue: defaults.fogEnd,
              onChange: (fogEnd: number) =>
                mutate({
                  ...scene,
                  settings: { ...scene.settings, fogEnd },
                }),
            },
          ]
        : []),
      {
        kind: "asset",
        id: "scene-environment-texture",
        label: "Environment Texture",
        value: scene.settings.environmentTextureGuid,
        placeholder: "None",
        onPick: () => setEnvTexturePickOpen(true),
        onChange: (environmentTextureGuid) =>
          mutate({
            ...scene,
            settings: { ...scene.settings, environmentTextureGuid },
          }),
        ...assetRowIdentity(
          pickerAssets.find(
            (asset) => asset.guid === scene.settings.environmentTextureGuid,
          ),
        ),
      },
      {
        kind: "asset",
        id: "scene-default-camera",
        label: "Default Camera",
        value: scene.settings.mainCameraComponentId,
        displayLabel: sceneComponentDisplayLabel(
          scene,
          scene.settings.mainCameraActorId,
          scene.settings.mainCameraComponentId,
        ),
        displayType: scene.settings.mainCameraComponentId
          ? "CameraComponent"
          : undefined,
        visual: scene.settings.mainCameraComponentId
          ? { classId: "CameraComponent", family: "class" }
          : undefined,
        placeholder: "None",
        onPick: () => setCameraPickerOpen(true),
        onChange: () =>
          mutate({
            ...scene,
            settings: {
              ...scene.settings,
              mainCameraActorId: null,
              mainCameraComponentId: null,
            },
          }),
      },
      {
        kind: "boolean",
        id: "scene-editor-joystick",
        label: "Joystick",
        value: scene.settings.editorJoystickEnabled,
        defaultValue: defaults.editorJoystickEnabled,
        onChange: (editorJoystickEnabled) =>
          mutate({
            ...scene,
            settings: { ...scene.settings, editorJoystickEnabled },
          }),
      },
      {
        kind: "vector3",
        id: "scene-gravity",
        label: "Gravity",
        value: scene.settings.gravity,
        defaultValue: defaults.gravity,
        onChange: (gravity) =>
          mutate({
            ...scene,
            settings: {
              ...scene.settings,
              gravity: [gravity[0], gravity[1], gravity[2]],
            },
          }),
      },
      {
        kind: "number",
        id: "scene-fixed-timestep",
        label: "Timestep",
        value: scene.settings.fixedTimestepMs,
        defaultValue: defaults.fixedTimestepMs,
        onChange: (fixedTimestepMs) =>
          mutate({
            ...scene,
            settings: { ...scene.settings, fixedTimestepMs },
          }),
      },
      {
        kind: "number",
        id: "scene-snap-translate",
        label: "Snap Step",
        value: scene.settings.grid.snapTranslate,
        defaultValue: defaults.grid.snapTranslate,
        onChange: (snapTranslate) =>
          mutate({
            ...scene,
            settings: {
              ...scene.settings,
              grid: { ...scene.settings.grid, snapTranslate },
            },
          }),
      },
      {
        kind: "number",
        id: "scene-tile-size",
        label: "Tile Size",
        value: scene.settings.grid.tileSize,
        defaultValue: defaults.grid.tileSize,
        onChange: (tileSize) =>
          mutate({
            ...scene,
            settings: {
              ...scene.settings,
              grid: { ...scene.settings.grid, tileSize },
            },
          }),
      },
      {
        kind: "number",
        id: "scene-tile-subdivisions",
        label: "Tile Subdivisions",
        value: scene.settings.grid.tileSubdivisions,
        defaultValue: defaults.grid.tileSubdivisions,
        onChange: (tileSubdivisions) =>
          mutate({
            ...scene,
            settings: {
              ...scene.settings,
              grid: {
                ...scene.settings.grid,
                tileSubdivisions: Math.max(1, Math.round(tileSubdivisions)),
              },
            },
          }),
      },
      {
        kind: "number",
        id: "scene-camera-bounds-width",
        label: "2D Camera Width",
        value: scene.settings.cameraBounds2D.width,
        defaultValue: defaults.cameraBounds2D.width,
        onChange: (width) =>
          mutate({
            ...scene,
            settings: {
              ...scene.settings,
              cameraBounds2D: { ...scene.settings.cameraBounds2D, width },
            },
          }),
      },
      {
        kind: "number",
        id: "scene-camera-bounds-height",
        label: "2D Camera Height",
        value: scene.settings.cameraBounds2D.height,
        defaultValue: defaults.cameraBounds2D.height,
        onChange: (height) =>
          mutate({
            ...scene,
            settings: {
              ...scene.settings,
              cameraBounds2D: { ...scene.settings.cameraBounds2D, height },
            },
          }),
      },
    ];

    const overlaySettingsRows = settingsRows
      .filter(
        (row) =>
          row.id === "scene-name" ||
          row.id === "scene-gravity" ||
          row.id === "scene-fixed-timestep" ||
          row.id === "scene-camera-bounds-width" ||
          row.id === "scene-camera-bounds-height",
      )
      .map((row) => {
        if (row.id === "scene-camera-bounds-width") {
          return { ...row, label: "Layer Width" };
        }
        if (row.id === "scene-camera-bounds-height") {
          return { ...row, label: "Layer Height" };
        }
        return row;
      });

    const visibleSettingsRows = filterRows(
      overlay ? overlaySettingsRows : settingsRows.filter((row) => row.id !== "scene-environment-texture"),
      "Scene Settings",
    );
    const celEnabled = !overlay && projectDocument?.settings.render.mode === "cel";
    const showPostProcess = matches("Post Processing Material Entry ID Enabled Scalable Resolution");
    const showShadows = !overlay && matches(SHADOW_SETTINGS_SEARCH_TEXT);
    const showEnvironment = !overlay && matches(ENVIRONMENT_LIGHTING_SEARCH_TEXT);
    const showCel = celEnabled && matches("Post Processing CEL Shading Shadow Bands Threshold Strength Specular Light Color Influence Mixing Strongest Additive Blend Outlines Outline Color Width Distance Fade Start End");
    const showSceneLayers = !overlay && matches("Scene Layers Z-Order Enabled");
    return (
      <PanelFrame data-testid="scene-details-panel">
        {propertySearch}
        {visibleSettingsRows.length > 0 ? (
          <PropertyGrid
            title="Scene Settings"
            rows={visibleSettingsRows}
            data-testid="scene-settings-grid"
          />
        ) : null}
        {showPostProcess ? (
          <div className="px-2 pb-3">
            <EntryListEditor
              title="Post Processing"
              data-testid="scene-post-process-stack"
              items={postProcessEntries}
              getItemKey={(item) => item.id}
              addLabel="Add Pass"
              countNoun={{ one: "pass", other: "passes" }}
              onAdd={() => setPostProcessPick("add")}
              onChange={(postProcessStack) =>
                mutate({
                  ...scene,
                  settings: {
                    ...scene.settings,
                    postProcessStack: normalizeScenePostProcessStack(postProcessStack),
                  },
                })
              }
              renderItemHeader={({ item, index }) => (
                <div className="flex items-center gap-1">
                  <div className="min-w-0 flex-1">
                    {stackAssetPicker(
                      item.materialGuid,
                      `scene-post-process-${index}-material`,
                      `Pass ${index + 1} Material`,
                      () => setPostProcessPick({ id: item.id }),
                    )}
                  </div>
                  <PostProcessEntryId id={item.id} index={index} />
                </div>
              )}
              renderItem={({ item, index, onChange }) => (
                <div className="flex items-center justify-between gap-2 px-2 pointer-coarse:flex-wrap">
                <Field
                  orientation="horizontal"
                  className="w-fit min-h-7 gap-1 pointer-coarse:min-h-11"
                >
                  <FieldLabel htmlFor={`scene-post-process-${index}-enabled`}>
                    Enabled
                  </FieldLabel>
                  <Switch
                    size="sm"
                    className="pointer-coarse:after:-inset-y-[15px]"
                    id={`scene-post-process-${index}-enabled`}
                    data-testid={`scene-post-process-${index}-enabled`}
                    aria-label={`Pass ${index + 1} Enabled`}
                    checked={item.enabled !== false}
                    onCheckedChange={(enabled) =>
                      onChange({ ...item, enabled })
                    }
                  />
                </Field>
                <Field orientation="horizontal" className="w-fit min-h-7 gap-1 pointer-coarse:min-h-11">
                  <FieldLabel htmlFor={`scene-post-process-${index}-scalable`} title="Allow quality settings to scale this pass resolution">Scalable</FieldLabel>
                  <Switch size="sm" className="pointer-coarse:after:-inset-y-[15px]" id={`scene-post-process-${index}-scalable`} aria-label={`Pass ${index + 1} Scalable Resolution`} checked={item.scalable === true} onCheckedChange={(scalable) => onChange({ ...item, scalable })} />
                </Field>
                </div>
              )}
            />
          </div>
        ) : null}
        {showEnvironment ? (
          <div className="px-2 pb-3">
            <DisclosureSection title="Environment Lighting" open={overrideOpen("environment")} onOpenChange={(open) => setOverrideOpen("environment", open)}>
              <EnvironmentLightingFields hideTitle cel={celEnabled} project={projectDocument?.settings.render.environmentLighting} overrides={scene.settings.environmentLighting ?? {}} onChange={(environmentLighting) => mutate({ ...scene, settings: { ...scene.settings, environmentLighting } })}>
                <PropertyGrid rows={settingsRows.filter((row) => row.id === "scene-environment-texture")} />
              </EnvironmentLightingFields>
            </DisclosureSection>
          </div>
        ) : null}
        {showShadows ? (
          <div className="px-2 pb-3">
            <DisclosureSection title="Shadows" open={overrideOpen("shadows")} onOpenChange={(open) => setOverrideOpen("shadows", open)}>
              <ShadowSettingsFields hideTitle project={projectDocument?.settings.render.shadows} overrides={scene.settings.shadowOverrides ?? {}} onChange={(shadowOverrides) => mutate({ ...scene, settings: { ...scene.settings, shadowOverrides } })} />
            </DisclosureSection>
          </div>
        ) : null}
        {doc?.ref.kind === "scene" && sceneBake && matches("Baked Lighting Bake Lighting Static Stationary Dynamic Receiver Occluder") ? (
          <div className="px-2 pb-3">
            <DisclosureSection title="Baked Lighting" open={overrideOpen("bakedLighting")} onOpenChange={(open) => setOverrideOpen("bakedLighting", open)}>
              <div className="flex flex-col gap-2">
                <p role="status" data-testid="scene-bake-validity" className="text-sm">{sceneBake.status}</p>
                {sceneBake.detail ? <p className="text-sm text-muted-foreground">{sceneBake.detail}</p> : null}
                <div className="flex"><Button size="sm" className="pointer-coarse:min-h-11" variant="outline" disabled={!sceneBake.ready || sceneBake.busy} onClick={sceneBake.open}>Bake Lighting</Button></div>
              </div>
            </DisclosureSection>
          </div>
        ) : null}
        {showCel ? (
          <div className="px-2 pb-3">
            <DisclosureSection title="CEL Shading" open={overrideOpen("cel")} onOpenChange={(open) => setOverrideOpen("cel", open)}>
            <CelShadingFields
              hideTitle
              project={normalizeCelShadingSettings(projectDocument?.settings.render.cel)}
              overrides={scene.settings.celShading ?? {}}
              onChange={(celShading) => mutate({ ...scene, settings: { ...scene.settings, celShading } })}
            />
            </DisclosureSection>
          </div>
        ) : null}
        {showSceneLayers ? (
          <div className="px-2 pb-3">
            <EntryListEditor
              title="Scene Layers"
              data-testid="scene-layers-stack"
              items={scene.settings.sceneLayers}
              addLabel="Add Layer"
              countNoun={{ one: "layer", other: "layers" }}
              onAdd={() => setSceneLayerPick("add")}
              onChange={(sceneLayers) =>
                mutate({
                  ...scene,
                  settings: {
                    ...scene.settings,
                    sceneLayers,
                  },
                })
              }
              renderItemHeader={({ item, index }) =>
                stackAssetPicker(
                  item.assetGuid,
                  `scene-layer-${index}-asset`,
                  `Layer ${index + 1} Asset`,
                  () => setSceneLayerPick(index),
                )
              }
              renderItem={({ item, index, onChange }) => (
                <FieldGroup className="flex-row flex-wrap items-center gap-1">
                  <Field
                    orientation="horizontal"
                    className="w-fit min-h-7 px-3 pointer-coarse:min-h-11"
                  >
                    <FieldLabel
                      className="sr-only"
                      htmlFor={`scene-layer-${index}-enabled`}
                    >
                      Layer {index + 1} Enabled
                    </FieldLabel>
                    <Switch
                      size="sm"
                      className="pointer-coarse:after:-inset-y-[15px]"
                      id={`scene-layer-${index}-enabled`}
                      data-testid={`scene-layer-${index}-enabled`}
                      title={item.enabled !== false ? "Enabled" : "Disabled"}
                      checked={item.enabled !== false}
                      onCheckedChange={(enabled) =>
                        onChange({ ...item, enabled })
                      }
                    />
                  </Field>
                  <Field
                    orientation="horizontal"
                    className="w-auto min-w-0 gap-1"
                  >
                    <FieldLabel htmlFor={`scene-layer-${index}-z`}>
                      Z-Order
                    </FieldLabel>
                    <NumberField
                      id={`scene-layer-${index}-z`}
                      data-testid={`scene-layer-${index}-z-order`}
                      className="h-7 w-12 px-1.5 pointer-coarse:h-11"
                      aria-label={`Layer ${index + 1} Z-Order`}
                      value={item.zOrder}
                      onChange={(zOrder) => onChange({ ...item, zOrder })}
                    />
                  </Field>
                </FieldGroup>
              )}
            />
          </div>
        ) : null}
        {!visibleSettingsRows.length && !showPostProcess && !showShadows && !showEnvironment && !showCel && !showSceneLayers
          ? noMatchingProperties
          : null}
        <AssetPicker
          open={envTexturePickOpen}
          onOpenChange={setEnvTexturePickOpen}
          assets={environmentPickerAssets}
          allowedTypes={["Texture"]}
          title="Pick Environment Texture"
          allowNone
          onPick={(environmentTextureGuid) => {
            mutate({
              ...scene,
              settings: { ...scene.settings, environmentTextureGuid },
            });
            setEnvTexturePickOpen(false);
          }}
          data-testid="scene-environment-texture-picker"
        />
        <AssetPicker
          open={sceneLayerPick !== null}
          onOpenChange={(open) => {
            if (!open) setSceneLayerPick(null);
          }}
          assets={pickerAssets}
          allowedTypes={["SceneLayer"]}
          title="Pick Scene Layer"
          allowNone={sceneLayerPick !== "add"}
          onPick={(assetGuid) => {
            const stack = [...scene.settings.sceneLayers];
            if (sceneLayerPick === "add") {
              if (assetGuid) {
                stack.push({
                  assetGuid,
                  zOrder: stack.length,
                  enabled: true,
                });
              }
            } else if (typeof sceneLayerPick === "number") {
              if (!assetGuid) {
                stack.splice(sceneLayerPick, 1);
              } else {
                const current = stack[sceneLayerPick];
                stack[sceneLayerPick] = {
                  assetGuid,
                  zOrder: current?.zOrder ?? sceneLayerPick,
                  enabled: current?.enabled !== false,
                };
              }
            }
            mutate({
              ...scene,
              settings: { ...scene.settings, sceneLayers: stack },
            });
            setSceneLayerPick(null);
          }}
          data-testid="scene-layers-picker"
        />
        <AssetPicker
          open={postProcessPick !== null}
          onOpenChange={(open) => {
            if (!open) setPostProcessPick(null);
          }}
          assets={postProcessPickerAssets}
          allowedTypes={["Material"]}
          title="Pick Post-Process Material"
          allowNone={postProcessPick !== "add"}
          onPick={(materialGuid) => {
            const stack = [...postProcessEntries];
            if (postProcessPick === "add") {
              if (materialGuid) {
                stack.push({ id: newGuid(), materialGuid, enabled: true });
              }
            } else if (postProcessPick) {
              const index = stack.findIndex((entry) => entry.id === postProcessPick.id);
              if (index < 0) {
                setPostProcessPick(null);
                return;
              }
              if (!materialGuid) {
                stack.splice(index, 1);
              } else {
                const current = stack[index]!;
                stack[index] = {
                  ...current,
                  materialGuid,
                  enabled: current?.enabled !== false,
                };
              }
            }
            mutate({
              ...scene,
              settings: { ...scene.settings, postProcessStack: normalizeScenePostProcessStack(stack) },
            });
            setPostProcessPick(null);
          }}
          data-testid="scene-post-process-picker"
        />
        <SceneComponentPicker
          open={cameraPickerOpen}
          onOpenChange={setCameraPickerOpen}
          components={sceneComponentEntries(scene, ["CameraComponent"])}
          allowedClassIds={["CameraComponent"]}
          title="Pick Default Camera"
          allowNone
          onPick={(ref) => {
            mutate({
              ...scene,
              settings: {
                ...scene.settings,
                mainCameraActorId: ref?.actorId ?? null,
                mainCameraComponentId: ref?.componentId ?? null,
              },
            });
            setCameraPickerOpen(false);
          }}
          data-testid="scene-default-camera-picker"
        />
      </PanelFrame>
    );
  }

  const selectedActors = selectedActorIds
    .map((id) => findActor(scene, id))
    .filter(
      (entry): entry is SerializedActor =>
        entry !== undefined && entry !== null,
    );
  const multiSelection = selectedActors.length > 1;
  const updateSelectedActors = (
    update: (entry: SerializedActor) => SerializedActor,
  ) => {
    const ids = new Set(selectedActorIds);
    mutate({
      ...scene,
      actors: scene.actors.map((entry) =>
        ids.has(entry.id) ? update(entry) : entry,
      ),
    });
  };
  const transformRows: PropertyRow[] = [
    {
      kind: "text",
      id: "actor-name",
      label: "Name",
      value: actor.name,
      onChange: (name) => updateActor((entry) => ({ ...entry, name })),
    },
    ...(multiSelection
      ? selectionTransformPropertyRows(
          selectedActors,
          scene.viewportMode,
          updateSelectedActors,
        )
      : spatialTransformPropertyRows(
          "actor",
          scene.viewportMode,
          actor.transform,
          (transform) => updateActor((entry) => ({ ...entry, transform })),
        )),
    {
      kind: "boolean",
      id: "actor-visible",
      label: "Visible",
      value: actor.visible,
      mixed: selectedActors.some((entry) => entry.visible !== actor.visible),
      defaultValue: true,
      onChange: (visible) =>
        updateSelectedActors((entry) => ({ ...entry, visible })),
    },
    {
      kind: "boolean",
      id: "actor-locked",
      label: "Locked",
      value: actor.locked,
      defaultValue: false,
      onChange: (locked) => {
        updateActor((entry) => ({ ...entry, locked }));
        setSelectedActorIds(
          selectionAfterLockChange(selectedActorIds, actor.id, locked),
        );
      },
    },
  ];

  const visibleTransformRows = filterRows(transformRows, "Actor Transform");
  const componentDetails = actor.components
    .map((component, index) => {
      const title = prefabComponentLabel(component, assetLabel);
      const template = component.sourceId
        ? prefabTemplates[actor.classId]?.find(
            (entry) => entry.id === component.sourceId,
          )
        : undefined;
      const rows = applyPrefabPropertyDefaults(
        componentPropertyRows(
          actor.id,
          component,
          (property, value) =>
            updateActor((entry) => ({
              ...entry,
              components: entry.components.map((candidate) =>
                candidate.id === component.id
                  ? {
                      ...candidate,
                      properties: patchInspectorComponentProperty(
                        candidate,
                        property,
                        value,
                      ),
                    }
                  : candidate,
              ),
            })),
          {
            sortingLayers,
            collisionLayers,
            assetLabel,
            assetType,
            modelMaterialSlots: (guid) => normalizeModelPayload(
              openDocuments.find((doc) => doc.ref.kind === "model" && doc.ref.path === assetRegistry?.getByGuid?.(guid)?.path)?.content
                ?? assetRegistry?.getByGuid?.(guid)?.header.payload ?? {},
            ).materialSlots,
            fontHasFacetype,
            fontHasMsdfJson,
            fontHasMsdfPng,
            physicsWorld: scene.settings.physicsWorld,
            onPickAsset: setAssetPick,
          },
        ),
        template,
      );
      const colliderRows =
        component.classId === "ColliderComponent"
          ? spatialTransformPropertyRows(
              `${actor.id}-${component.id}`,
              scene.viewportMode,
              component.transform ?? identitySerializedTransform(),
              (transform) =>
                updateActor((entry) => ({
                  ...entry,
                  components: entry.components.map((candidate) =>
                    candidate.id === component.id
                      ? { ...candidate, transform }
                      : candidate,
                  ),
                })),
              template?.transform,
            )
          : [];
      const extraLabels =
        component.classId === "NavMeshComponent"
          ? "Bake NavMesh"
          : [
                "Text3DComponent",
                "2DTextComponent",
                "2DRichTextComponent",
              ].includes(component.classId)
            ? "Text"
            : component.classId === "2DPanelComponent"
              ? "Nine Slice"
              : "";
      return {
        component,
        index,
        title,
        rows: filterRows(rows, title),
        colliderRows: filterRows(colliderRows, `${title} Transform`),
        showExtras:
          matches(title) || Boolean(extraLabels && matches(extraLabels)),
        expanded: !(
          needle ? filterCollapsedComponents : collapsedComponents
        ).has(`${actor.id}:${component.id}`),
      };
    })
    .filter(
      (entry) =>
        matches(entry.title) ||
        entry.rows.length ||
        entry.colliderRows.length ||
        entry.showExtras,
    );

  return (
    <PanelFrame data-testid="scene-details-panel">
      {propertySearch}
      <div className="flex flex-col gap-3 pb-4">
        {visibleTransformRows.length > 0 ? (
          <PropertyGrid
            title={
              multiSelection ? `${selectedActors.length} Actors` : actor.name
            }
            rows={
              multiSelection
                ? visibleTransformRows.filter(
                    (row) =>
                      row.id !== "actor-name" && row.id !== "actor-locked",
                  )
                : visibleTransformRows
            }
            data-testid="actor-transform-grid"
          />
        ) : null}
        {multiSelection &&
        visibleTransformRows.some(
          (row) => row.id === "actor-name" || row.id === "actor-locked",
        ) ? (
          <PropertyGrid
            title={`Primary Actor: ${actor.name}`}
            rows={visibleTransformRows.filter(
              (row) => row.id === "actor-name" || row.id === "actor-locked",
            )}
            data-testid="primary-actor-grid"
          />
        ) : null}
        {!visibleTransformRows.length && !componentDetails.length
          ? noMatchingProperties
          : null}
        <div className="mx-2 flex">
          <Button
            variant="outline"
            size="sm"
            aria-label={multiSelection ? `Add Component To ${actor.name}` : "Add Component"}
            onClick={() => setAddComponentOpen(true)}
            data-testid="details-add-component"
          >
            <PlusIcon data-icon="inline-start" />
            Add Component
          </Button>
        </div>
        {componentDetails.map(
          ({
            component,
            index,
            title,
            rows,
            colliderRows,
            showExtras,
            expanded,
          }) => (
            <div
              key={component.id}
              className="mx-2 overflow-hidden rounded-lg border border-border/60 bg-sidebar"
              data-testid={`component-card-${component.id}`}
            >
              <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-panel-header px-2 py-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="min-w-0 flex-1 justify-start px-0"
                  aria-label={title}
                  aria-expanded={expanded}
                  aria-controls={`component-details-${actor.id}-${component.id}`}
                  onClick={() => {
                    (needle
                      ? setFilterCollapsedComponents
                      : setCollapsedComponents)((current) => {
                      const next = new Set(current);
                      const key = `${actor.id}:${component.id}`;
                      if (expanded) next.add(key);
                      else next.delete(key);
                      return next;
                    });
                  }}
                >
                  <ChevronDownIcon
                    className={expanded ? undefined : "-rotate-90"}
                  />
                  <TypeVisualIcon
                    visual={resolveTypeVisual({
                      classId: component.classId,
                      ancestry: walkAncestry(
                        component.classId,
                        parentOf,
                      ),
                    })}
                    data-testid={`component-type-icon-${component.id}`}
                  />
                  <span className="truncate">{title}</span>
                </Button>
                <div className="flex shrink-0 items-center gap-1">
                  <IconActionButton
                    label={`Move ${title} Up`}
                    disabled={index === 0}
                    onClick={() =>
                      updateActor((entry) => {
                        const components = [...entry.components];
                        const [moved] = components.splice(index, 1);
                        components.splice(index - 1, 0, moved!);
                        return { ...entry, components };
                      })
                    }
                    data-testid={`component-up-${component.id}`}
                  >
                    <ChevronUpIcon />
                  </IconActionButton>
                  <IconActionButton
                    label={`Remove ${title}`}
                    onClick={() =>
                      updateActor((entry) => ({
                        ...entry,
                        components: entry.components.filter(
                          (candidate) => candidate.id !== component.id,
                        ),
                      }))
                    }
                    data-testid={`component-remove-${component.id}`}
                  >
                    <Trash2Icon />
                  </IconActionButton>
                </div>
              </div>
              {expanded ? (
                <div id={`component-details-${actor.id}-${component.id}`}>
                  {rows.length ? <PropertyGrid rows={rows} /> : null}
                  {showExtras && component.classId === "2DPanelComponent" ? (
                    <NineSlicePreview
                      {...parseOverlayPanelProperties(component.properties)}
                    />
                  ) : null}
                  {showExtras && component.classId === "Text3DComponent" ? (
                    <div className="p-2">
                      <Field>
                        <FieldLabel htmlFor={`text3d-text-${component.id}`}>
                          Text
                        </FieldLabel>
                        <MultilineTextField
                          id={`text3d-text-${component.id}`}
                          title="Text"
                          value={
                            parseText3DProperties(component.properties).text
                          }
                          onChange={(value) =>
                            updateActor((entry) => ({
                              ...entry,
                              components: entry.components.map((candidate) =>
                                candidate.id === component.id
                                  ? {
                                      ...candidate,
                                      properties: patchComponentProperties(
                                        candidate.properties,
                                        "text",
                                        value,
                                      ),
                                    }
                                  : candidate,
                              ),
                            }))
                          }
                          data-testid={`text3d-text-${component.id}`}
                        />
                      </Field>
                    </div>
                  ) : null}
                  {showExtras &&
                  (component.classId === "2DTextComponent" ||
                    component.classId === "2DRichTextComponent") ? (
                    <div className="p-2">
                      <Field>
                        <FieldLabel htmlFor={`text2d-text-${component.id}`}>
                          Text
                        </FieldLabel>
                        <MultilineTextField
                          id={`text2d-text-${component.id}`}
                          title="Text"
                          markup={component.classId === "2DRichTextComponent"}
                          value={
                            parseText2DProperties(component.properties, {
                              rich: component.classId === "2DRichTextComponent",
                            }).text
                          }
                          onChange={(value) =>
                            updateActor((entry) => ({
                              ...entry,
                              components: entry.components.map((candidate) =>
                                candidate.id === component.id
                                  ? {
                                      ...candidate,
                                      properties: patchComponentProperties(
                                        candidate.properties,
                                        "text",
                                        value,
                                      ),
                                    }
                                  : candidate,
                              ),
                            }))
                          }
                          data-testid={`text2d-text-${component.id}`}
                        />
                      </Field>
                    </div>
                  ) : null}
                  {colliderRows.length ? (
                    <PropertyGrid
                      title="Transform"
                      rows={colliderRows}
                      data-testid={`collider-transform-grid-${component.id}`}
                    />
                  ) : null}
                  {showExtras && component.classId === "NavMeshComponent" ? (
                    <div className="p-2">
                      <Button
                        type="button"
                        variant="outline"
                        className="w-full"
                        data-testid={`navmesh-bake-${component.id}`}
                        disabled={navBake?.baking}
                        onClick={() => {
                          void navBake?.startBake(component.properties);
                        }}
                      >
                        Bake NavMesh
                      </Button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ),
        )}
      </div>
      <AssetPicker
        open={assetPick !== null}
        onOpenChange={(open) => {
          if (!open) setAssetPick(null);
        }}
        assets={assetPick?.property === "materialGuid" && actor.components.some((component) => component.id === assetPick.componentId && component.classId === "MeshComponent" && component.properties.assetGuid)
          ? [MODEL_MATERIALS_PICKER_ENTRY, ...pickerAssets]
          : pickerAssets}
        allowedTypes={assetPick?.allowedTypes}
        title={assetPick?.title ?? "Pick Asset"}
        allowNone
        onPick={(guid) => {
          if (!assetPick) return;
          const { componentId, property } = assetPick;
          updateActor((entry) => ({
            ...entry,
            components: entry.components.map((candidate) => {
              if (candidate.id !== componentId) return candidate;
              let properties = patchInspectorComponentProperty(
                candidate,
                property,
                guid,
              );
              if (
                property === "fontAssetGuid" &&
                (candidate.classId === "2DTextComponent" ||
                  candidate.classId === "2DRichTextComponent")
              ) {
                const pair = Boolean(
                  guid && fontHasMsdfJson(guid) && fontHasMsdfPng(guid),
                );
                if (!pair) {
                  properties = patchComponentProperties(
                    properties,
                    "renderer",
                    "bitmap",
                  );
                }
              }
              return { ...candidate, properties };
            }),
          }));
          setAssetPick(null);
        }}
        data-testid="details-asset-picker"
      />
      <AddComponentDialog
        open={addComponentOpen}
        onOpenChange={setAddComponentOpen}
        projectItems={projectAddComponentItems(assetRegistry?.list() ?? [])}
        overlay={overlay}
        onSelect={(selection) =>
          updateActor((entry) => ({
            ...entry,
            components: [
              ...entry.components,
              {
                id: `${entry.id}-component-${entry.components.length + 1}`,
                classId: selection.classId,
                properties: {
                  ...defaultPropertiesFor(
                    selection.classId,
                    overlay ? "2d" : scene.settings.physicsWorld,
                    overlay ? "2d" : scene.viewportMode,
                  ),
                  ...selection.properties,
                },
              },
            ],
          }))
        }
        data-testid="add-component-catalog"
      />
    </PanelFrame>
  );
}

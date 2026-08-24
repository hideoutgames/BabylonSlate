import type { IDockviewPanelProps } from "dockview-react";
import { useCallback, useMemo, useState } from "react";
import {
  AssetPicker,
  NamedListEditor,
  PanelFrame,
  PropertyGrid,
  SceneComponentPicker,
  TypeVisualIcon,
  assetRowIdentity,
  classRowIdentity,
  resolveTypeVisual,
  selectedPickerIdentity,
  type PropertyRow,
} from "@babylonslate/editor-kit";
import {
  DEFAULT_COLLISION_LAYERS,
  DEFAULT_SORTING_LAYERS,
  createDefaultSceneSettings,
  findActor,
  identitySerializedTransform,
  patchComponentProperties,
  type SerializedActor,
  type SerializedScene,
} from "@babylonslate/core";
import { ChevronUpIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { Button } from "@babylonslate/ui/components/button";
import { Switch } from "@babylonslate/ui/components/switch";
import {
  Field,
  FieldLabel,
} from "@babylonslate/ui/components/field";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useSceneEditing, selectionAfterLockChange } from "../context/scene-editing-context";
import { useOptionalNavBake } from "../context/nav-bake-context";
import { IconActionButton } from "../components/icon-action-button";
import { AddComponentDialog } from "../components/add-component-dialog";
import {
  defaultPropertiesFor,
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
import { fontAssetHasFacetype } from "../lib/play-fonts";
import { collectClassGraphsForPalette } from "../lib/logic-graph-document";
import { classIdForGraphPath } from "../services/script-compiler";
import { prefabTemplatesByClassId } from "../lib/prefab-instance-sync";

export function SceneDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applySceneChange, projectDocument, assetRegistry } =
    useDocuments();
  const { selectedActorIds, setSelectedActorIds } = useSceneEditing();
  const navBake = useOptionalNavBake();
  const [addComponentOpen, setAddComponentOpen] = useState(false);
  const [assetPick, setAssetPick] = useState<AssetPickRequest | null>(null);
  const [cameraPickerOpen, setCameraPickerOpen] = useState(false);
  const [envTexturePickOpen, setEnvTexturePickOpen] = useState(false);
  const [postProcessPick, setPostProcessPick] = useState<"add" | number | null>(
    null,
  );
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
  const classEntries = gameInstanceClassEntries(assetRegistry?.list() ?? []);
  const sortingLayers =
    projectDocument?.settings.twoD.sortingLayers ?? DEFAULT_SORTING_LAYERS;
  const collisionLayers =
    projectDocument?.settings.physics?.collisionLayers ?? DEFAULT_COLLISION_LAYERS;
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
  const fontHasFacetype = (guid: string | null | undefined) => {
    if (!guid) return false;
    return fontAssetHasFacetype(assetRegistry?.getByGuid?.(guid)?.header.payload);
  };

  const doc = openDocuments.find((entry) => entry.id === documentId);
  const scene =
    doc?.ref.kind === "scene" ? (doc.content as SerializedScene) : null;
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
            (entry) =>
              entry.id === projectDocument?.settings.gameInstanceClass,
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

    return (
      <PanelFrame data-testid="scene-details-panel">
        <PropertyGrid
          title="Scene settings"
          rows={settingsRows}
          data-testid="scene-settings-grid"
        />
        <div className="px-2 pb-3">
          <NamedListEditor
            title="Post Process"
            data-testid="scene-post-process-stack"
            values={scene.settings.postProcessStack.map(
              (entry) => entry.materialGuid,
            )}
            addLabel="Add Pass"
            onAdd={() => setPostProcessPick("add")}
            onChange={(guids) =>
              mutate({
                ...scene,
                settings: {
                  ...scene.settings,
                  postProcessStack: stackFromGuids(
                    guids,
                    scene.settings.postProcessStack,
                  ),
                },
              })
            }
            renderItem={({ value, index }) => (
              <>
                <Field className="min-w-32 flex-1">
                  <FieldLabel htmlFor={`scene-post-process-${index}-material`}>
                    Material
                  </FieldLabel>
                  <Button
                    type="button"
                    id={`scene-post-process-${index}-material`}
                    variant="outline"
                    className="min-h-[var(--touch-target,44px)] h-auto w-full justify-start"
                    data-testid={`scene-post-process-${index}-material`}
                    onClick={() => setPostProcessPick(index)}
                  >
                    {selectedPickerIdentity(
                      assetRowIdentity(
                        pickerAssets.find((asset) => asset.guid === value),
                      ),
                      "Pick Material",
                    )}
                  </Button>
                </Field>
                <Field orientation="horizontal" className="w-auto">
                  <FieldLabel htmlFor={`scene-post-process-${index}-enabled`}>
                    Enabled
                  </FieldLabel>
                  <Switch
                    id={`scene-post-process-${index}-enabled`}
                    data-testid={`scene-post-process-${index}-enabled`}
                    className="min-h-[var(--touch-target,44px)]"
                    checked={
                      scene.settings.postProcessStack[index]?.enabled !== false
                    }
                    onCheckedChange={(checked) =>
                      mutate({
                        ...scene,
                        settings: {
                          ...scene.settings,
                          postProcessStack: scene.settings.postProcessStack.map(
                            (entry, row) =>
                              row === index
                                ? { ...entry, enabled: checked === true }
                                : entry,
                          ),
                        },
                      })
                    }
                  />
                </Field>
              </>
            )}
          />
        </div>
        <AssetPicker
          open={envTexturePickOpen}
          onOpenChange={setEnvTexturePickOpen}
          assets={pickerAssets}
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
          open={postProcessPick !== null}
          onOpenChange={(open) => {
            if (!open) setPostProcessPick(null);
          }}
          assets={postProcessPickerAssets}
          allowedTypes={["Material"]}
          title="Pick Post-Process Material"
          allowNone={postProcessPick !== "add"}
          onPick={(materialGuid) => {
            const stack = [...scene.settings.postProcessStack];
            if (postProcessPick === "add") {
              if (materialGuid) {
                stack.push({ materialGuid, enabled: true });
              }
            } else if (typeof postProcessPick === "number") {
              if (!materialGuid) {
                stack.splice(postProcessPick, 1);
              } else {
                const current = stack[postProcessPick];
                stack[postProcessPick] = {
                  materialGuid,
                  enabled: current?.enabled !== false,
                };
              }
            }
            mutate({
              ...scene,
              settings: { ...scene.settings, postProcessStack: stack },
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

  const transformRows: PropertyRow[] = [
    {
      kind: "text",
      id: "actor-name",
      label: "Name",
      value: actor.name,
      onChange: (name) => updateActor((entry) => ({ ...entry, name })),
    },
    ...spatialTransformPropertyRows(
      "actor",
      scene.viewportMode,
      actor.transform,
      (transform) => updateActor((entry) => ({ ...entry, transform })),
    ),
    {
      kind: "boolean",
      id: "actor-visible",
      label: "Visible",
      value: actor.visible,
      defaultValue: true,
      onChange: (visible) => updateActor((entry) => ({ ...entry, visible })),
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

  return (
    <PanelFrame
      data-testid="scene-details-panel"
      toolbar={
        <IconActionButton
          label="Add component"
          onClick={() => setAddComponentOpen(true)}
          data-testid="details-add-component"
        >
          <PlusIcon />
        </IconActionButton>
      }
    >
      <div className="flex flex-col gap-3 pb-4">
        <PropertyGrid
          title={
            selectedActorIds.length > 1
              ? `${selectedActorIds.length} Actors`
              : actor.name
          }
          rows={transformRows}
          data-testid="actor-transform-grid"
        />
        {actor.components.map((component, index) => (
          <div
            key={component.id}
            className="mx-2 rounded-lg border border-border bg-card"
            data-testid={`component-card-${component.id}`}
          >
            <div className="flex items-center justify-between gap-2 border-b border-border bg-secondary px-2 py-1">
              <span className="flex min-w-0 items-center gap-2 truncate text-sm font-medium">
                <TypeVisualIcon
                  visual={resolveTypeVisual({ classId: component.classId })}
                  data-testid={`component-type-icon-${component.id}`}
                />
                {component.classId}
              </span>
              <div className="flex shrink-0 items-center gap-1">
                <IconActionButton
                  label={`Move ${component.classId} up`}
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
                  label={`Remove ${component.classId}`}
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
            <PropertyGrid
              rows={applyPrefabPropertyDefaults(
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
                            properties: patchComponentProperties(
                              candidate.properties,
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
                  fontHasFacetype,
                  physicsWorld: scene.settings.physicsWorld,
                  onPickAsset: setAssetPick,
                },
              ),
                component.sourceId
                  ? prefabTemplates[actor.classId]?.find(
                      (row) => row.id === component.sourceId,
                    )
                  : undefined,
              )}
            />
            {component.classId === "ColliderComponent" ? (
              <PropertyGrid
                title="Transform"
                rows={spatialTransformPropertyRows(
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
                  component.sourceId
                    ? prefabTemplates[actor.classId]?.find(
                        (row) => row.id === component.sourceId,
                      )?.transform
                    : undefined,
                )}
                data-testid={`collider-transform-grid-${component.id}`}
              />
            ) : null}
            {component.classId === "NavMeshComponent" ? (
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
        ))}
      </div>
      <AssetPicker
        open={assetPick !== null}
        onOpenChange={(open) => {
          if (!open) setAssetPick(null);
        }}
        assets={pickerAssets}
        allowedTypes={assetPick?.allowedTypes}
        title={assetPick?.title ?? "Pick Asset"}
        allowNone
        onPick={(guid) => {
          if (!assetPick) return;
          const { componentId, property } = assetPick;
          updateActor((entry) => ({
            ...entry,
            components: entry.components.map((candidate) =>
              candidate.id === componentId
                ? {
                    ...candidate,
                    properties: patchComponentProperties(
                      candidate.properties,
                      property,
                      guid,
                    ),
                  }
                : candidate,
            ),
          }));
          setAssetPick(null);
        }}
        data-testid="details-asset-picker"
      />
      <AddComponentDialog
        open={addComponentOpen}
        onOpenChange={setAddComponentOpen}
        projectItems={projectAddComponentItems(assetRegistry?.list() ?? [])}
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
                    scene.settings.physicsWorld,
                    scene.viewportMode,
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

function stackFromGuids(
  guids: readonly string[],
  previous: readonly { materialGuid: string; enabled: boolean }[],
): { materialGuid: string; enabled: boolean }[] {
  const remaining = [...previous];
  return guids.map((guid) => {
    const index = remaining.findIndex((entry) => entry.materialGuid === guid);
    const prev = index >= 0 ? remaining.splice(index, 1)[0] : undefined;
    return { materialGuid: guid, enabled: prev?.enabled !== false };
  });
}

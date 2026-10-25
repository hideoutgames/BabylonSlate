import { usePlaySimulationDocumentId } from "../context/play-context";
import { SimulationInspector } from "./simulation-inspector";
import { useSimulationInspectionStore } from "../context/simulation-inspection-context";
import { saveGameVariableNames } from "../lib/save-game-property-rows";
import { SceneLayerSwitcherFields } from "../components/scene-layer-switcher-fields";

import { isEnvironmentTexturePayload, normalizeModelPayload } from "@haptic/assets";
import { MODEL_MATERIALS_PICKER_ENTRY, patchInspectorComponentProperty } from "../lib/mesh-material-properties";
import type { IDockviewPanelProps } from "dockview-react";
import { useCallback, useMemo, useState } from "react";
import { useAreaEmissionStatus } from "../lib/use-area-emission-status";

import {
  AssetPicker,
  PanelFrame,
  PropertyGrid,
  SearchInput,
  SearchDialog,
  humanizePropertyLabel,
  walkAncestry,
  type PropertyRow,
  type SearchDialogItem,
} from "@haptic/editor-kit";
import {
  DEFAULT_COLLISION_LAYERS,
  DEFAULT_SORTING_LAYERS,
  findActor,
  identitySerializedTransform,
  isFocusTargetClass,
  isSceneLayer3DActor,
  isSceneLayerAnchorActor,
  patchComponentProperties,
  setSceneStreamingTarget,
  type SerializedActor,
  type SerializedScene,
  isSceneWorkspaceKind,
  normalizeScenePostProcessStack,
  waterKindForClass,
  DEFORMER_COMPONENT_CLASS_ID,
} from "@haptic/core";
import { PlusIcon } from "lucide-react";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@haptic/ui/components/empty";
import {
  useDocumentActions,
  useProjectState,
  useRegistryState,
  useOpenDocument,
} from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import {
  useSceneEditing,
  selectionAfterLockChange,
} from "../context/scene-editing-context";
import { useOptionalNavBake } from "../context/nav-bake-context";
import { IconActionButton } from "../components/icon-action-button";
import { AddComponentMenu } from "../components/add-component-menu";
import { anchorBelow } from "../lib/menu-anchor";
import {
  defaultPropertiesFor,
  prefabComponentLabelParts,
  projectAddComponentItems,
} from "./add-component-catalog";
import { SceneComponentCard } from "./scene-details-component-card";
import { SceneDetailsSettings } from "./scene-details-settings";
import {
  applyPrefabPropertyDefaults,
  componentPropertyRows,
  gameInstanceClassEntries,
  subclassClassEntries,
  type AssetPickRequest,
} from "../lib/component-property-rows";
import {
  classParentLookup,
  isPostProcessMaterialForPicker,
  materialDomainsFromAssets,
} from "../lib/content-browser-helpers";
import { spatialTransformPropertyRows, type TransformRowsMode } from "../lib/transform-property-rows";
import { selectionTransformPropertyRows } from "../lib/selection-transform-property-rows";
import {
  fontAssetHasFacetype,
  fontAssetHasMsdfJson,
  fontAssetHasMsdfPng,
} from "../lib/play-fonts";
import { collectClassGraphsForPalette } from "../lib/logic-graph-document";
import { classIdForGraphPath } from "../services/script-compiler";
import {
  prefabAssetTemplates,
  prefabTemplateKey,
  prefabTemplatesByClassId,
} from "../lib/prefab-instance-sync";
import { physicsConstraintTargets } from "../lib/physics-constraint-targets";
import { sceneActorDisplayNames } from "../lib/scene-actor-names";
import { useRetainedValue } from "../lib/use-retained-value";
import {
  MATERIAL_DOCUMENT_KINDS,
  useOpenDocumentsOfKinds,
} from "../lib/use-open-documents-of-kinds";

const NO_SEARCH_ITEMS: SearchDialogItem[] = [];
const CLASS_KINDS = ["graph"] as const;
const PREFAB_KINDS = ["prefab"] as const;
const MODEL_KINDS = ["model"] as const;

export function SceneDetailsPanel(props: IDockviewPanelProps) {
  const { documentId } = useDocumentWorkspace();
  const simulationDocumentId = usePlaySimulationDocumentId();
  const store = useSimulationInspectionStore();
  return store && simulationDocumentId === documentId
    ? <SimulationInspector store={store} panel={props} />
    : <AuthoringSceneDetailsPanel {...props} />;
}

function AuthoringSceneDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { applySceneChange } = useDocumentActions();
  const { projectDocument } = useProjectState();
  const { assetRegistry, registryEpoch } = useRegistryState();
  const areaEmissionStatus = useAreaEmissionStatus();
  // Open Model tabs' unsaved material slots win over saved headers.
  const modelDocuments = useOpenDocumentsOfKinds(MODEL_KINDS);
  const { selectedActorIds, setSelectedActorIds, shapeEditTarget, setShapeEditTarget } = useSceneEditing();
  const navBake = useOptionalNavBake();
  const [propertyQuery, setPropertyQuery] = useState("");
  const [expandedOverrides, setExpandedOverrides] = useState<Set<string>>(() => new Set());
  const [filterCollapsedOverrides, setFilterCollapsedOverrides] = useState<Set<string>>(() => new Set());
  const [collapsedComponents, setCollapsedComponents] = useState<Set<string>>(
    () => new Set(),
  );
  const [filterCollapsedComponents, setFilterCollapsedComponents] = useState<
    Set<string>
  >(() => new Set());
  const [renamingComponentKey, setRenamingComponentKey] = useState<string | null>(null);
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
  const [addComponentAnchor, setAddComponentAnchor] = useState<{ x: number; y: number } | null>(null);
  const [componentSearch, setComponentSearch] = useState("");
  const [assetPick, setAssetPick] = useState<AssetPickRequest | null>(null);
  const [constraintTargetPick, setConstraintTargetPick] = useState<{ actorId: string; componentId: string } | null>(null);
  const [cameraPickerOpen, setCameraPickerOpen] = useState(false);
  const [envTexturePickOpen, setEnvTexturePickOpen] = useState(false);
  const [postProcessPick, setPostProcessPick] = useState<"add" | { id: string } | null>(
    null,
  );
  const [sceneLayerPick, setSceneLayerPick] = useState<"add" | number | null>(
    null,
  );
  // Registry-derived views: rebuilt when the registry changes, not on every
  // edit of this Scene.
  const registryViews = useMemo(() => {
    void registryEpoch;
    const assets = assetRegistry?.list() ?? [];
    const pickerAssets = assets.map((asset) => ({
      guid: asset.header.guid,
      name: asset.header.name,
      type: asset.header.type,
      path: asset.path,
    }));
    const environmentGuids = new Set(assets
      .filter((asset) => isEnvironmentTexturePayload(asset.header.payload))
      .map((asset) => asset.header.guid));
    return {
      parentOf: classParentLookup(assets),
      pickerAssets,
      environmentPickerAssets: pickerAssets.filter((entry) => environmentGuids.has(entry.guid)),
      classEntries: gameInstanceClassEntries(assets),
      sceneLayerClasses: subclassClassEntries("SceneLayerActor", assets),
      projectComponentItems: projectAddComponentItems(assets),
    };
  }, [assetRegistry, registryEpoch]);
  const { parentOf, pickerAssets, environmentPickerAssets, classEntries, sceneLayerClasses, projectComponentItems } = registryViews;
  // An open Material tab's unsaved domain wins over its saved header.
  const materialDocuments = useOpenDocumentsOfKinds(MATERIAL_DOCUMENT_KINDS);
  const materialDomains = useMemo(() => {
    void registryEpoch;
    return materialDomainsFromAssets(assetRegistry?.list() ?? [], materialDocuments);
  }, [assetRegistry, materialDocuments, registryEpoch]);
  const postProcessPickerAssets = useMemo(() => {
    void registryEpoch;
    return (assetRegistry?.list() ?? [])
      .filter((asset) => isPostProcessMaterialForPicker(asset, materialDocuments))
      .map((asset) => ({
        guid: asset.header.guid,
        name: asset.header.name,
        type: asset.header.type,
        path: asset.path,
      }));
  }, [assetRegistry, materialDocuments, registryEpoch]);
  const classDocuments = useOpenDocumentsOfKinds(CLASS_KINDS);
  const prefabDocuments = useOpenDocumentsOfKinds(PREFAB_KINDS);
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

  const doc = useOpenDocument(documentId);
  const scene = isSceneWorkspaceKind(doc?.ref.kind)
    ? (doc.content as SerializedScene)
    : null;
  const overlay = doc?.ref.kind === "scene-layer";
  const postProcessEntries = useMemo(
    () => normalizeScenePostProcessStack(scene?.settings.postProcessStack),
    [scene?.settings.postProcessStack],
  );
  const actorId = selectedActorIds[0] ?? null;
  const actor = scene && actorId ? (findActor(scene, actorId) ?? null) : null;
  const actorDisplayNames = useMemo(
    () => scene ? sceneActorDisplayNames(scene) : new Map<string, string>(),
    [scene],
  );
  const pickingCableTarget = actor?.components.find((component) => component.id === constraintTargetPick?.componentId)?.classId === "CableComponent";
  const classSaveGraphs = useMemo(() => {
    void registryEpoch;
    return collectClassGraphsForPalette({ assets: assetRegistry?.list() ?? [], openDocuments: classDocuments, classIdForPath: classIdForGraphPath });
  }, [assetRegistry, classDocuments, registryEpoch]);
  const prefabTemplates = useMemo(() => {
    void registryEpoch; // Registry headers mutate without replacing the registry.
    const assets = assetRegistry?.list() ?? [];
    const graphs = collectClassGraphsForPalette({
      assets,
      openDocuments: classDocuments,
      classIdForPath: classIdForGraphPath,
    });
    return {
      ...prefabTemplatesByClassId({
        classIds: Object.keys(graphs),
        parentOf: classParentLookup(assets),
        graphs,
      }),
      ...prefabAssetTemplates({ assets, openDocuments: prefabDocuments }),
    };
  }, [assetRegistry, classDocuments, prefabDocuments, registryEpoch]);

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

  // Focus Target choices across the Scene, read by every component's rows:
  // built once per Scene edit, not once per component per render.
  const focusTargets = useMemo(
    () =>
      scene
        ? scene.actors.flatMap((candidate) =>
            candidate.components
              .filter((entry) => isFocusTargetClass(entry.classId))
              .map((entry, index) => ({
                value: entry.id,
                label: `${actorDisplayNames.get(candidate.id) ?? candidate.name} / ${humanizePropertyLabel(entry.classId.replace(/Component$/, ""))} ${index + 1}`,
              })),
          )
        : [],
    [actorDisplayNames, scene],
  );

  // The constraint / cable target list covers every actor, so it is built only
  // while its picker is open; closed, the picker keeps the last list so it
  // fades out intact.
  const constraintPickerOpen =
    actor !== null && constraintTargetPick?.actorId === actor.id;
  const openConstraintTargets = useMemo((): SearchDialogItem[] | null => {
    if (!constraintPickerOpen || !scene || !actor) return null;
    return [
      {
        id: "",
        label: pickingCableTarget ? "Self" : "None",
        description: pickingCableTarget
          ? "Use this actor's cable or a local component"
          : "Leave the constraint unconnected",
      },
      ...(pickingCableTarget
        ? scene.actors
            .filter((candidate) => candidate.id !== actor.id)
            .map((candidate) => ({
              id: candidate.id,
              label: actorDisplayNames.get(candidate.id)!,
              description: candidate.classId,
              group: "Actors",
            }))
        : physicsConstraintTargets(scene, actor.id)),
    ];
  }, [actor, actorDisplayNames, constraintPickerOpen, pickingCableTarget, scene]);
  const constraintTargetItems = useRetainedValue(openConstraintTargets, NO_SEARCH_ITEMS);

  if (!scene) {
    return (
      <PanelFrame data-testid="scene-details-panel">
        <p className="p-4 text-sm text-muted-foreground">Open a scene.</p>
      </PanelFrame>
    );
  }

  if (!actor) {
    return (
      <PanelFrame data-testid="scene-details-panel">
        {propertySearch}
        <SceneDetailsSettings
          scene={scene}
          overlay={overlay}
          projectDocument={projectDocument}
          mutate={mutate}
          classEntries={classEntries}
          pickerAssets={pickerAssets}
          environmentPickerAssets={environmentPickerAssets}
          postProcessPickerAssets={postProcessPickerAssets}
          postProcessEntries={postProcessEntries}
          matches={matches}
          filterRows={filterRows}
          overrideOpen={overrideOpen}
          setOverrideOpen={setOverrideOpen}
          noMatchingProperties={noMatchingProperties}
          envTexturePickOpen={envTexturePickOpen}
          setEnvTexturePickOpen={setEnvTexturePickOpen}
          cameraPickerOpen={cameraPickerOpen}
          setCameraPickerOpen={setCameraPickerOpen}
          postProcessPick={postProcessPick}
          setPostProcessPick={setPostProcessPick}
          sceneLayerPick={sceneLayerPick}
          setSceneLayerPick={setSceneLayerPick}
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
  const spatialActors = selectedActors.filter((entry) => !isSceneLayerAnchorActor(entry));
  // Layer 3D geometry rotates and scales in 3D but keeps 2D placement; the viewport keeps the 2D box.
  const transformMode: TransformRowsMode = overlay && spatialActors.length > 0 && spatialActors.every(isSceneLayer3DActor)
    ? "layer3d"
    : scene.viewportMode;
  const shapeComponents = actor.components.filter((component) =>
    component.classId === "SplineComponent" || component.classId === DEFORMER_COMPONENT_CLASS_ID || waterKindForClass(component.classId) !== null,
  );
  const activeShapeComponent = !multiSelection && !actor.locked
    ? shapeComponents.find((component) => shapeEditTarget?.actorId === actor.id && shapeEditTarget.componentId === component.id) ?? shapeComponents[0]
    : undefined;
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
    ...(spatialActors.length === 0 ? [] : multiSelection
      ? selectionTransformPropertyRows(
          spatialActors,
          transformMode,
          (update) => updateSelectedActors((entry) => isSceneLayerAnchorActor(entry) ? entry : update(entry)),
        )
      : spatialTransformPropertyRows(
          "actor",
          transformMode,
          actor.transform,
          (transform) => updateActor((entry) => ({ ...entry, transform })),
        )),
    ...(spatialActors.length === 0 ? [] : [{
      kind: "boolean",
      id: "actor-visible",
      label: "Visible",
      value: spatialActors[0]?.visible ?? true,
      mixed: spatialActors.some((entry) => entry.visible !== spatialActors[0]?.visible),
      defaultValue: true,
      onChange: (visible) =>
        updateSelectedActors((entry) => isSceneLayerAnchorActor(entry) ? entry : ({ ...entry, visible })),
    } satisfies PropertyRow]),
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
      const nameParts = prefabComponentLabelParts(component, assetLabel);
      const title = nameParts.detail ? `${nameParts.name} ${nameParts.detail}` : nameParts.name;
      const template = component.sourceId
        ? prefabTemplates[prefabTemplateKey(actor)]?.find(
            (entry) => entry.id === component.sourceId,
          )
        : undefined;
      const rows = applyPrefabPropertyDefaults(
        componentPropertyRows(
          actor.id,
          component,
          (property, value, alsoSet) => {
            if (component.classId === "SceneStreamingComponent" && property === "sceneGuid") {
              const guid = typeof value === "string" ? value : null;
              updateActor((entry) => ({ ...entry, components: setSceneStreamingTarget(entry.components, component.id, guid, assetLabel(guid) ?? "") }));
              return;
            }
            updateActor((entry) => ({
              ...entry,
              components: entry.components.map((candidate) =>
                candidate.id === component.id
                  ? {
                      ...candidate,
                      properties: {
                        ...patchInspectorComponentProperty(
                          candidate,
                          property,
                          value,
                        ),
                        ...alsoSet,
                      },
                    }
                  : candidate,
              ),
            }));
          },
          {
            sortingLayers,
            collisionLayers,
            collisionPresets: projectDocument?.settings.physics?.collisionPresets,
            assetLabel,
            assetType,
            modelMaterialSlots: (guid) => normalizeModelPayload(
              modelDocuments.find((doc) => doc.ref.path === assetRegistry?.getByGuid?.(guid)?.path)?.content
                ?? assetRegistry?.getByGuid?.(guid)?.header.payload ?? {},
            ).materialSlots,
            fontHasFacetype,
            fontHasMsdfJson,
            fontHasMsdfPng,
            physicsWorld: scene.settings.physicsWorld,
            onPickAsset: setAssetPick,
            areaEmissionStatus,
            actorLabel: (targetId) => actorDisplayNames.get(targetId),
            actorComponents: (targetId) => scene.actors.find((candidate) => candidate.id === targetId)?.components ?? [],
            actorVariableNames: () => saveGameVariableNames(actor.classId, classSaveGraphs, parentOf),
            componentVariableNames: (classId) => saveGameVariableNames(classId, classSaveGraphs, parentOf),
            sceneLayerClasses,
            focusTargets,
            onPickActor: (componentId) => setConstraintTargetPick({ actorId: actor.id, componentId }),
          },
        ),
        template,
      );
      const colliderRows =
        component.classId === "ColliderComponent" || component.classId === "SceneStreamingComponent"
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
      const extraLabels = component.classId === "2DDropdownComponent" ? "Options Items Select Dropdown" :
        component.classId === "NavMeshComponent"
          ? "Bake NavMesh"
          : component.classId === "2DRichTextComponent"
            ? "Text Appear Modes Fade Scale Slide Instant Off"
          : [
                "Text3DComponent",
                "2DTextComponent",
              ].includes(component.classId)
            ? "Text"
            : component.classId === "2DPanelComponent"
              ? "Nine Slice"
              : component.classId === "RenderTargetCaptureComponent"
                ? "Capture Actors"
                : component.classId === "RagdollComponent"
                  ? "Bone Names"
                  : "";
      return {
        component,
        template,
        index,
        title,
        nameParts,
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
  const componentNeedle = componentSearch.trim().toLowerCase();
  const shownComponentDetails = componentNeedle
    ? componentDetails.filter(({ title }) => title.toLowerCase().includes(componentNeedle))
    : componentDetails;

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
        {!multiSelection && walkAncestry(actor.classId, parentOf).includes("SceneLayerActorSwitcher") && matches("Scene Layer Actors Switcher Initial Index Defaults") ? <SceneLayerSwitcherFields classId={actor.classId} properties={actor.properties ?? {}} onChange={properties => updateActor(entry => ({ ...entry, properties }))} /> : null}
        {!visibleTransformRows.length && !componentDetails.length
          ? noMatchingProperties
          : null}
        {/* The Components panel's header: find a component, or add one to this actor. */}
        <div className="mx-2 flex items-center gap-1" data-testid="details-components-header">
          <SearchInput
            className="h-7 pointer-coarse:h-11"
            placeholder="Search components"
            aria-label="Search components"
            value={componentSearch}
            onChange={setComponentSearch}
            data-testid="details-component-search"
          />
          <IconActionButton
            label={`Add Component To ${actor.name}`}
            className="pointer-coarse:size-11"
            onClick={(event) => setAddComponentAnchor(anchorBelow(event.currentTarget))}
            data-testid="details-add-component"
          >
            <PlusIcon />
          </IconActionButton>
        </div>
        {componentNeedle && !shownComponentDetails.length && componentDetails.length ? (
          <p className="mx-2 text-xs text-muted-foreground" data-testid="details-component-search-empty">
            No Matching Components
          </p>
        ) : null}
        {shownComponentDetails.map((detail) => (
          <SceneComponentCard
            key={detail.component.id}
            {...detail}
            actor={actor}
            scene={scene}
            parentOf={parentOf}
            updateActor={updateActor}
            renamingComponentKey={renamingComponentKey}
            setRenamingComponentKey={setRenamingComponentKey}
            setCollapsedKeys={needle ? setFilterCollapsedComponents : setCollapsedComponents}
            shapeEditable={shapeComponents.includes(detail.component)}
            shapeEditing={activeShapeComponent?.id === detail.component.id}
            multiSelection={multiSelection}
            setShapeEditTarget={setShapeEditTarget}
            navBake={navBake}
          />
        ))}
      </div>
      <AssetPicker
        open={assetPick !== null}
        onOpenChange={(open) => {
          if (!open) setAssetPick(null);
        }}
        assets={assetPick?.materialDomain === "text" ? pickerAssets.filter((asset) => materialDomains[asset.guid] === "text") : assetPick?.property === "materialGuid" && actor.components.some((component) => component.id === assetPick.componentId && component.classId === "MeshComponent" && component.properties.assetGuid)
          ? [MODEL_MATERIALS_PICKER_ENTRY, ...pickerAssets]
          : pickerAssets}
        allowedTypes={assetPick?.allowedTypes}
        // Domain rows (Text Material) only accept Materials of that domain, so
        // Create New makes one; a parentless Material Instance would be refused.
        createTypes={assetPick?.materialDomain ? ["Material"] : undefined}
        createOptions={assetPick?.materialDomain ? { materialDomain: assetPick.materialDomain } : undefined}
        title={assetPick?.title ?? "Pick Asset"}
        allowNone
        onPick={(guid) => {
          if (!assetPick) return;
          if (guid && assetPick.materialDomain === "text" && materialDomains[guid] !== "text") return;
          const { componentId, property } = assetPick;
          if (property === "sceneGuid" && actor.components.some((candidate) => candidate.id === componentId && candidate.classId === "SceneStreamingComponent")) {
            updateActor((entry) => ({ ...entry, components: setSceneStreamingTarget(entry.components, componentId, guid, assetLabel(guid) ?? "") }));
            setAssetPick(null);
            return;
          }
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
      <SearchDialog
        open={constraintPickerOpen}
        onOpenChange={(open) => { if (!open) setConstraintTargetPick(null); }}
        title="Pick Target Actor"
        description={pickingCableTarget ? "Choose an actor for the cable end, or Self for a local attachment." : "Choose a physics actor in this scene. Both actors need collision; at least one must be dynamic."}
        placeholder={pickingCableTarget ? "Search Actors" : "Search Physics Actors"}
        emptyLabel={pickingCableTarget ? "No Matching Actors" : "No Matching Physics Actors"}
        items={constraintTargetItems}
        onSelect={(targetActorId) => {
          if (constraintTargetPick?.actorId !== actor.id) return;
          updateActor((entry) => ({
            ...entry,
            components: entry.components.map((component) => component.id === constraintTargetPick.componentId
              ? { ...component, properties: pickingCableTarget
                ? patchInspectorComponentProperty(component, "targetActorId", targetActorId || null)
                : { ...component.properties, targetActorId } }
              : component),
          }));
          setConstraintTargetPick(null);
        }}
        data-testid={pickingCableTarget ? "details-cable-target-picker" : "details-constraint-target-picker"}
      />
      <AddComponentMenu
        open={addComponentAnchor !== null}
        onOpenChange={(open) => {
          if (!open) setAddComponentAnchor(null);
        }}
        anchor={addComponentAnchor}
        title={`Add Component To ${actor.name}`}
        projectItems={projectComponentItems}
        overlay={overlay}
        physicsWorld={scene.settings.physicsWorld}
        onSelect={(selection) =>
          updateActor((entry) => {
            const usedIds = new Set(entry.components.map((component) => component.id));
            let suffix = entry.components.length + 1;
            while (usedIds.has(`${entry.id}-component-${suffix}`)) suffix += 1;
            return {
              ...entry,
              components: [
                ...entry.components,
                {
                  id: `${entry.id}-component-${suffix}`,
                  classId: selection.classId,
                  properties: {
                    ...defaultPropertiesFor(
                      selection.classId,
                      overlay ? "2d" : scene.settings.physicsWorld,
                      overlay ? "2d" : scene.viewportMode,
                      entry.components,
                    ),
                    ...selection.properties,
                  },
                },
              ],
            };
          })
        }
        data-testid="add-component-catalog"
      />
    </PanelFrame>
  );
}

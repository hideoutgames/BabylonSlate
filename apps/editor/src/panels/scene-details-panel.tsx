import { usePlaySimulationDocumentId } from "../context/play-context";
import { SimulationInspector } from "./simulation-inspector";
import { useSimulationInspectionStore } from "../context/simulation-inspection-context";
import { saveGameVariableNames } from "../lib/save-game-property-rows";
import { SceneLayerSwitcherFields } from "../components/scene-layer-switcher-fields";
import { sameActorTags, useInheritedActorTags, withActorTags } from "./actor-defaults-grid";

import { isEnvironmentTexturePayload, normalizeModelPayload } from "@haptic/assets";
import { MODEL_MATERIALS_PICKER_ENTRY, patchInspectorComponentProperty } from "../lib/mesh-material-properties";
import type { IDockviewPanelProps } from "dockview-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { useAreaEmissionStatus } from "../lib/use-area-emission-status";

import {
  AssetPicker,
  PanelFrame,
  PropertyGrid,
  SearchInput,
  SearchDialog,
  humanizePropertyLabel,
  mergePropertyRows,
  walkAncestry,
  type PropertyRow,
  type SearchDialogItem,
} from "@haptic/editor-kit";
import {
  ACTOR_TAGS_PROPERTY,
  DEFAULT_COLLISION_LAYERS,
  DEFAULT_SORTING_LAYERS,
  findActor,
  normalizeTagContainer,
  identitySerializedTransform,
  isFocusTargetClass,
  isSceneLayer3DActor,
  isSceneLayerAnchorActor,
  patchComponentProperties,
  setSceneStreamingTarget,
  type SerializedActor,
  type SerializedComponent,
  type SerializedScene,
  type TagContainer,
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
import { useOptionalSceneTools } from "../context/scene-tools-context";
import { documentSceneMode } from "../shell/scene-document-layout";
import { TimelineInspector } from "./timeline-inspector";
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
  type ComponentPropertyContext,
} from "../lib/component-property-rows";
import {
  classParentLookup,
  isPostProcessMaterialForPicker,
  materialDomainsFromAssets,
} from "../lib/content-browser-helpers";
import { spatialTransformPropertyRows, type TransformRowsMode } from "../lib/transform-property-rows";
import { selectionTransformPropertyRows } from "../lib/selection-transform-property-rows";
import { scaleLinkKey, useLinkedScale } from "../lib/linked-scale";
import {
  fontAssetHasFacetype,
  fontAssetHasMsdfJson,
  fontAssetHasMsdfPng,
  textFontPixelSize,
} from "../lib/play-fonts";
import { useClassGraphs } from "../lib/use-class-graphs";
import {
  mergedPrefabComponentsForClass,
  prefabAssetTemplate,
  prefabTemplateKey,
} from "../lib/prefab-instance-sync";
import { physicsConstraintTargets } from "../lib/physics-constraint-targets";
import { sceneActorDisplayNames } from "../lib/scene-actor-names";
import { useRetainedValue } from "../lib/use-retained-value";
import type { ComponentPropertyUpdate } from "../lib/component-property-row-helpers";
import { particleParameterOverrideRows } from "../lib/particle-parameter-override-rows";
import { particleSystemGuidsOf, useParticleSystemParameters } from "../lib/use-particle-system-parameters";
import {
  MATERIAL_DOCUMENT_KINDS,
  useOpenDocumentsOfKinds,
} from "../lib/use-open-documents-of-kinds";

const NO_SEARCH_ITEMS: SearchDialogItem[] = [];
const PREFAB_KINDS = ["prefab"] as const;
const MODEL_KINDS = ["model"] as const;

/** One selected actor's component that a component card edits. */
type ComponentTarget = { owner: SerializedActor; component: SerializedComponent };

export function SceneDetailsPanel(props: IDockviewPanelProps) {
  const { documentId } = useDocumentWorkspace();
  const simulationDocumentId = usePlaySimulationDocumentId();
  const store = useSimulationInspectionStore();
  const doc = useOpenDocument(documentId);
  const sceneTools = useOptionalSceneTools();
  if (store && simulationDocumentId === documentId) return <SimulationInspector store={store} panel={props} />;
  // Timeline mode edits the selected clip's keys, tracks and settings here.
  const timelineClip = documentSceneMode(doc?.ref.kind, doc?.layout) === "timeline" && sceneTools?.timelineClipId
    ? (doc?.content as SerializedScene | undefined)?.timelineClips?.some((clip) => clip.id === sceneTools.timelineClipId)
    : false;
  return timelineClip ? <TimelineInspector /> : <AuthoringSceneDetailsPanel {...props} />;
}

function AuthoringSceneDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { applySceneChange } = useDocumentActions();
  const { projectDocument } = useProjectState();
  const { assetRegistry, registryEpoch } = useRegistryState();
  const areaEmissionStatus = useAreaEmissionStatus();
  const linkedScale = useLinkedScale();
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
  // Both sides humanized, so a label typed as shown (`Screen-Space Shadows`) finds itself.
  const humanizedNeedle = needle ? humanizePropertyLabel(needle).toLowerCase() : "";
  const matches = (label: string) =>
    !needle || humanizePropertyLabel(label).toLowerCase().includes(humanizedNeedle);
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
  const [effectsLutPickOpen, setEffectsLutPickOpen] = useState(false);
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
  const fontPixelSize = (guid: string | null | undefined) =>
    textFontPixelSize(guid, projectDocument?.settings.fonts.defaultFontGuid, (target) => assetRegistry?.getByGuid?.(target)?.header.payload);

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
  // The primary actor first; a multi-selection shows what they all share.
  const selectedActors = useMemo(
    () => scene
      ? selectedActorIds
          .map((id) => findActor(scene, id))
          .filter((entry): entry is SerializedActor => entry !== undefined && entry !== null)
      : [],
    [scene, selectedActorIds],
  );
  const actorDisplayNames = useMemo(
    () => scene ? sceneActorDisplayNames(scene) : new Map<string, string>(),
    [scene],
  );
  const pickingCableTarget = actor?.components.find((component) => component.id === constraintTargetPick?.componentId)?.classId === "CableComponent";
  const particleParameters = useParticleSystemParameters(
    particleSystemGuidsOf({ components: selectedActors.flatMap((entry) => entry.components) }),
  );
  const classSaveGraphs = useClassGraphs();
  const inheritedActorTags = useInheritedActorTags(selectedActors.map((entry) => entry.classId));
  // An actor's prefab template: its Prefab asset's when placed from one, else
  // its Class's ancestor-merged components. Cached per Prefab and Class.
  const templateOf = useMemo(() => {
    void registryEpoch; // Registry headers mutate without replacing the registry.
    const cache = new Map<string, SerializedComponent[] | undefined>();
    const resolve = ({ classId, prefabGuid }: SerializedActor) => {
      if (prefabGuid) {
        return prefabAssetTemplate({ asset: assetRegistry?.getByGuid(prefabGuid), openDocuments: prefabDocuments });
      }
      if (!Object.hasOwn(classSaveGraphs, classId)) return undefined;
      return mergedPrefabComponentsForClass({ classId, parentOf, graphs: classSaveGraphs }) ?? undefined;
    };
    return (owner: SerializedActor) => {
      const key = prefabTemplateKey(owner);
      if (!cache.has(key)) cache.set(key, resolve(owner));
      return cache.get(key);
    };
  }, [assetRegistry, classSaveGraphs, parentOf, prefabDocuments, registryEpoch]);

  const mutate = useCallback(
    (next: SerializedScene) => {
      void applySceneChange(documentId, next);
    },
    [applySceneChange, documentId],
  );

  // While a multi-selection edit runs, each actor's change lands on this
  // working copy instead of the Scene this render read.
  const workingSceneRef = useRef<SerializedScene | null>(null);
  const changeScene = useCallback(
    (update: (current: SerializedScene) => SerializedScene) => {
      const working = workingSceneRef.current;
      if (working) workingSceneRef.current = update(working);
      else if (scene) mutate(update(scene));
    },
    [mutate, scene],
  );
  /** Runs one edit's per-actor changes on one working copy and applies it once: one Scene change, one Undo step. */
  const batchSceneChange = useCallback(
    (apply: () => void) => {
      if (workingSceneRef.current || !scene) {
        apply();
        return;
      }
      workingSceneRef.current = scene;
      let next: SerializedScene;
      try {
        apply();
        next = workingSceneRef.current;
      } finally {
        workingSceneRef.current = null;
      }
      if (next !== scene) mutate(next);
    },
    [mutate, scene],
  );

  const updateActorById = useCallback(
    (id: string, update: (actor: SerializedActor) => SerializedActor) =>
      changeScene((current) => ({
        ...current,
        actors: current.actors.map((entry) => entry.id === id ? update(entry) : entry),
      })),
    [changeScene],
  );
  const updateActor = useCallback(
    (update: (actor: SerializedActor) => SerializedActor) => {
      if (actorId) updateActorById(actorId, update);
    },
    [actorId, updateActorById],
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
  // fades out intact. A selected actor never targets itself, so the list
  // leaves out every selected actor.
  const constraintPickerOpen =
    actor !== null && constraintTargetPick?.actorId === actor.id;
  const openConstraintTargets = useMemo((): SearchDialogItem[] | null => {
    if (!constraintPickerOpen || !scene || !actor) return null;
    const selected = new Set(selectedActors.map((entry) => entry.id));
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
            .filter((candidate) => candidate.id !== actor.id && !selected.has(candidate.id))
            .map((candidate) => ({
              id: candidate.id,
              label: actorDisplayNames.get(candidate.id)!,
              description: candidate.classId,
              group: "Actors",
            }))
        : physicsConstraintTargets(scene, actor.id).filter((candidate) => !selected.has(candidate.id))),
    ];
  }, [actor, actorDisplayNames, constraintPickerOpen, pickingCableTarget, scene, selectedActors]);
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
          effectsLutPickOpen={effectsLutPickOpen}
          setEffectsLutPickOpen={setEffectsLutPickOpen}
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
    changeScene((current) => ({
      ...current,
      actors: current.actors.map((entry) =>
        ids.has(entry.id) ? update(entry) : entry,
      ),
    }));
  };
  const tagsOf = (entry: SerializedActor): TagContainer =>
    entry.properties?.[ACTOR_TAGS_PROPERTY] === undefined
      ? inheritedActorTags(entry.classId)
      : normalizeTagContainer(entry.properties[ACTOR_TAGS_PROPERTY]);
  const withTags = (entry: SerializedActor, tags: TagContainer): SerializedActor => {
    const properties = withActorTags(entry.properties, tags, inheritedActorTags(entry.classId));
    const next = { ...entry, ...(properties ? { properties } : {}) };
    if (!properties) delete next.properties;
    return next;
  };
  // Outliner anchors have no Tags, so a selection holding one shows none.
  const tagsRow = ((): PropertyRow | null => {
    if (selectedActors.some(isSceneLayerAnchorActor)) return null;
    if (!multiSelection) {
      return {
        kind: "tag-container",
        id: "actor-tags",
        label: "Tags",
        value: tagsOf(actor),
        defaultValue: inheritedActorTags(actor.classId),
        onChange: (tags) => updateActor((entry) => withTags(entry, tags)),
      };
    }
    const tagLists = selectedActors.map((entry) => tagsOf(entry).Tags);
    const common = tagLists[0]!.filter((tag) => tagLists.every((tags) => tags.includes(tag)));
    const inherited = selectedActors.map((entry) => inheritedActorTags(entry.classId));
    const sharedDefault = inherited.every((tags) => sameActorTags(tags, inherited[0]!)) ? inherited[0] : undefined;
    return {
      kind: "tag-container",
      id: "actor-tags",
      label: "Tags",
      value: { Tags: common },
      mixed: tagLists.some((tags) => !sameActorTags({ Tags: tags }, { Tags: tagLists[0]! })),
      defaultValue: sharedDefault,
      // Reset gives each actor its Class's Tags; picking a Tag adds it to, or
      // removes it from, every actor and keeps the rest of each actor's own.
      onChange: (tags) => updateSelectedActors((entry) => {
        if (tags === sharedDefault) return withTags(entry, inheritedActorTags(entry.classId));
        const kept = tagsOf(entry).Tags.filter((tag) => !common.includes(tag) || tags.Tags.includes(tag));
        return withTags(entry, { Tags: [...new Set([...kept, ...tags.Tags])] });
      }),
    };
  })();
  const transformRows: PropertyRow[] = [
    {
      kind: "text",
      id: "actor-name",
      label: "Name",
      value: actor.name,
      mixed: selectedActors.some((entry) => entry.name !== actor.name),
      onChange: (name) => updateSelectedActors((entry) => ({ ...entry, name })),
    },
    ...(spatialActors.length === 0 ? [] : multiSelection
      ? selectionTransformPropertyRows(
          spatialActors,
          transformMode,
          (update) => updateSelectedActors((entry) => isSceneLayerAnchorActor(entry) ? entry : update(entry)),
          linkedScale,
        )
      : spatialTransformPropertyRows(
          "actor",
          transformMode,
          actor.transform,
          (transform) => updateActor((entry) => ({ ...entry, transform })),
          { scaleLink: linkedScale.link(scaleLinkKey.actor(actor.id)) },
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
      mixed: selectedActors.some((entry) => entry.locked !== actor.locked),
      defaultValue: false,
      onChange: (locked) => {
        updateSelectedActors((entry) => ({ ...entry, locked }));
        setSelectedActorIds(selectedActors.reduce(
          (ids, entry) => selectionAfterLockChange(ids, entry.id, locked),
          selectedActorIds,
        ));
      },
    },
    ...(tagsRow ? [tagsRow] : []),
  ];

  const visibleTransformRows = filterRows(transformRows, "Actor Transform");

  const componentContext = (owner: SerializedActor): ComponentPropertyContext => ({
    sortingLayers,
    collisionLayers,
    collisionPresets: projectDocument?.settings.physics?.collisionPresets,
    assetLabel,
    assetType,
    assetPayload: (guid) => assetRegistry?.getByGuid?.(guid)?.header.payload,
    modelMaterialSlots: (guid) => normalizeModelPayload(
      modelDocuments.find((doc) => doc.ref.path === assetRegistry?.getByGuid?.(guid)?.path)?.content
        ?? assetRegistry?.getByGuid?.(guid)?.header.payload ?? {},
    ).materialSlots,
    fontHasFacetype,
    fontHasMsdfJson,
    fontHasMsdfPng,
    fontPixelSize,
    physicsWorld: scene.settings.physicsWorld,
    onPickAsset: setAssetPick,
    areaEmissionStatus,
    actorLabel: (targetId) => actorDisplayNames.get(targetId),
    actorComponents: (targetId) => scene.actors.find((candidate) => candidate.id === targetId)?.components ?? [],
    actorVariableNames: () => saveGameVariableNames(owner.classId, classSaveGraphs, parentOf),
    componentVariableNames: (classId) => saveGameVariableNames(classId, classSaveGraphs, parentOf),
    sceneLayerClasses,
    focusTargets,
    onPickActor: (componentId) => setConstraintTargetPick({ actorId: owner.id, componentId }),
  });
  /** One actor's rows for one of its components, built as a single selection builds them. */
  const componentRowSets = ({ owner, component }: ComponentTarget) => {
    const template = component.sourceId
      ? templateOf(owner)?.find((entry) => entry.id === component.sourceId)
      : undefined;
    const updateComponent: ComponentPropertyUpdate = (property, value, alsoSet) => {
      if (component.classId === "SceneStreamingComponent" && property === "sceneGuid") {
        const guid = typeof value === "string" ? value : null;
        updateActorById(owner.id, (entry) => ({ ...entry, components: setSceneStreamingTarget(entry.components, component.id, guid, assetLabel(guid) ?? "") }));
        return;
      }
      updateActorById(owner.id, (entry) => ({
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
    };
    const rows = applyPrefabPropertyDefaults(
      componentPropertyRows(owner.id, component, updateComponent, componentContext(owner)),
      template,
    );
    const colliderRows =
      component.classId === "ColliderComponent" || component.classId === "SceneStreamingComponent"
        ? spatialTransformPropertyRows(
            `${owner.id}-${component.id}`,
            scene.viewportMode,
            component.transform ?? identitySerializedTransform(),
            (transform) =>
              updateActorById(owner.id, (entry) => ({
                ...entry,
                components: entry.components.map((candidate) =>
                  candidate.id === component.id
                    ? { ...candidate, transform }
                    : candidate,
                ),
              })),
            {
              defaults: template?.transform,
              scaleLink: linkedScale.link(scaleLinkKey.actorComponent(owner.id, component.id)),
            },
          )
        : [];
    const parameterRows = component.classId === "ParticleComponent"
      ? particleParameterOverrideRows(owner.id, component,
        particleParameters.get(String(component.properties.particleSystemGuid ?? "")) ?? [], updateComponent)
      : [];
    return { template, rows, colliderRows, parameterRows };
  };
  // A multi-selection shows one card per component class every selected actor
  // has; it edits the first component of that class on each actor.
  const cardComponents = multiSelection
    ? actor.components.filter((component, index, all) =>
        all.findIndex((candidate) => candidate.classId === component.classId) === index &&
        selectedActors.every((entry) => entry.components.some((candidate) => candidate.classId === component.classId)))
    : actor.components;
  const componentTargets = (component: SerializedComponent): ComponentTarget[] =>
    multiSelection
      ? selectedActors.flatMap((owner) => {
          const match = owner.components.find((candidate) => candidate.classId === component.classId);
          return match ? [{ owner, component: match }] : [];
        })
      : [{ owner: actor, component }];
  /** The components an edit from the card of the primary actor's `componentId` changes. */
  const pickTargets = (componentId: string): ComponentTarget[] => {
    const component = actor.components.find((candidate) => candidate.id === componentId);
    return component ? componentTargets(component) : [];
  };
  /** Changes or (with null) removes the card's component on every target, as one Scene change. */
  const editTargets = (
    targets: readonly ComponentTarget[],
    update: (component: SerializedComponent) => SerializedComponent | null,
  ) =>
    batchSceneChange(() => {
      for (const { owner, component } of targets) {
        updateActorById(owner.id, (entry) => ({
          ...entry,
          components: entry.components.flatMap((candidate) => {
            if (candidate.id !== component.id) return [candidate];
            const next = update(candidate);
            return next ? [next] : [];
          }),
        }));
      }
    });
  const mergeTargetRows = (targets: readonly ComponentTarget[], sets: readonly PropertyRow[][]) => {
    const card = `${targets[0]!.owner.id}-${targets[0]!.component.id}-`;
    // Rows match by their id after the actor and component part, kept as the card's.
    return mergePropertyRows(
      sets.map((rows, index) => {
        const own = `${targets[index]!.owner.id}-${targets[index]!.component.id}-`;
        return own === card ? rows : rows.map((row) => row.id.startsWith(own) ? { ...row, id: card + row.id.slice(own.length) } : row);
      }),
      { batch: batchSceneChange },
    );
  };
  const componentDetails = cardComponents
    .map((component) => {
      const index = actor.components.indexOf(component);
      const targets = componentTargets(component);
      const sets = targets.map(componentRowSets);
      // A shared card names the class unless every component has the same name.
      const labels = targets.map((target) => prefabComponentLabelParts(target.component, assetLabel));
      const nameParts = {
        name: labels.every((parts) => parts.name === labels[0]!.name)
          ? labels[0]!.name
          : prefabComponentLabelParts({ classId: component.classId }).name,
        ...(labels.every((parts) => parts.detail === labels[0]!.detail) && labels[0]!.detail
          ? { detail: labels[0]!.detail }
          : {}),
      };
      const title = nameParts.detail ? `${nameParts.name} ${nameParts.detail}` : nameParts.name;
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
        template: sets[0]!.template,
        index,
        title,
        nameParts,
        targets,
        rows: filterRows(mergeTargetRows(targets, sets.map((set) => set.rows)), title),
        colliderRows: filterRows(mergeTargetRows(targets, sets.map((set) => set.colliderRows)), `${title} Transform`),
        parameterRows: filterRows(mergeTargetRows(targets, sets.map((set) => set.parameterRows)), `${title} Parameters`),
        // Class extras edit one component's own data, so a multi-selection leaves them out.
        showExtras: !multiSelection &&
          (matches(title) || Boolean(extraLabels && matches(extraLabels))),
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
        entry.parameterRows.length ||
        entry.showExtras,
    );
  const componentNeedle = componentSearch.trim().toLowerCase();
  const shownComponentDetails = componentNeedle
    ? componentDetails.filter(({ title }) => title.toLowerCase().includes(componentNeedle))
    : componentDetails;
  const addComponentLabel = `Add Component To ${multiSelection ? `${selectedActors.length} Actors` : actor.name}`;
  // Model Materials is offered when every Mesh the pick changes shows a Model.
  const pickedComponents = assetPick ? pickTargets(assetPick.componentId) : [];
  const pickedMeshesHaveModels = assetPick?.property === "materialGuid" && pickedComponents.length > 0 &&
    pickedComponents.every(({ component }) => component.classId === "MeshComponent" && Boolean(component.properties.assetGuid));

  return (
    <PanelFrame data-testid="scene-details-panel">
      {propertySearch}
      <div className="flex flex-col gap-3 pb-4">
        {visibleTransformRows.length > 0 ? (
          <PropertyGrid
            title={
              multiSelection ? `${selectedActors.length} Actors` : actor.name
            }
            rows={visibleTransformRows}
            data-testid="actor-transform-grid"
          />
        ) : null}
        {!multiSelection && walkAncestry(actor.classId, parentOf).includes("SceneLayerActorSwitcher") && matches("Scene Layer Actors Switcher Initial Index Defaults") ? <SceneLayerSwitcherFields classId={actor.classId} properties={actor.properties ?? {}} onChange={properties => updateActor(entry => ({ ...entry, properties }))} /> : null}
        {!visibleTransformRows.length && !componentDetails.length
          ? noMatchingProperties
          : null}
        {/* The Components panel's header: find a component, or add one to every selected actor. */}
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
            label={addComponentLabel}
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
        {shownComponentDetails.map(({ targets, ...detail }) => (
          <SceneComponentCard
            key={detail.component.id}
            {...detail}
            actor={actor}
            scene={scene}
            parentOf={parentOf}
            updateActor={updateActor}
            editComponent={(update) => editTargets(targets, update)}
            removeComponent={() => editTargets(targets, () => null)}
            renamingComponentKey={renamingComponentKey}
            setRenamingComponentKey={setRenamingComponentKey}
            setCollapsedKeys={needle ? setFilterCollapsedComponents : setCollapsedComponents}
            shapeEditable={!multiSelection && shapeComponents.includes(detail.component)}
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
        assets={assetPick?.materialDomain ? pickerAssets.filter((asset) => materialDomains[asset.guid] === assetPick.materialDomain) : pickedMeshesHaveModels
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
          if (guid && assetPick.materialDomain && materialDomains[guid] !== assetPick.materialDomain) return;
          const { componentId, property } = assetPick;
          batchSceneChange(() => {
            for (const { owner, component: picked } of pickTargets(componentId)) {
              if (property === "sceneGuid" && picked.classId === "SceneStreamingComponent") {
                updateActorById(owner.id, (entry) => ({ ...entry, components: setSceneStreamingTarget(entry.components, picked.id, guid, assetLabel(guid) ?? "") }));
                continue;
              }
              updateActorById(owner.id, (entry) => ({
                ...entry,
                components: entry.components.map((candidate) => {
                  if (candidate.id !== picked.id) return candidate;
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
            }
          });
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
          editTargets(pickTargets(constraintTargetPick.componentId), (component) => ({
            ...component,
            properties: pickingCableTarget
              ? patchInspectorComponentProperty(component, "targetActorId", targetActorId || null)
              : { ...component.properties, targetActorId },
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
        title={addComponentLabel}
        projectItems={projectComponentItems}
        overlay={overlay}
        physicsWorld={scene.settings.physicsWorld}
        onSelect={(selection) =>
          updateSelectedActors((entry) => {
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

import { SimulationInspector } from "./simulation-inspector";
import { ActorDefaultsGrid } from "./actor-defaults-grid";
import { useSimulationInspectionStore } from "../context/simulation-inspection-context";
import { SceneLayerSwitcherFields } from "../components/scene-layer-switcher-fields";
import { normalizeClassMemberCategory } from "@haptic/core";
import { useMemo, useState } from "react";
import {
  ClassPicker,
  PanelFrame,
  PropertyGrid,
  walkAncestry,
  type ClassPickerEntry,
} from "@haptic/editor-kit";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@haptic/ui/components/field";
import { Button } from "@haptic/ui/components/button";
import type { IDockviewPanelProps } from "dockview-react";
import {
  DEFAULT_COLLISION_LAYERS,
  DEFAULT_SORTING_LAYERS,
  type SerializedGraph,
} from "@haptic/core";
import {
  animGraphMembersFromVariables,
  decorateTransitionRuleGraph,
  persistTransitionRuleGraph,
  findReverseTransition,
  parseAnimGraphDocument,
  patchTransition,
} from "@haptic/anim-graph";
import {
  useDocumentActions,
  useProjectState,
  useRegistryState,
  useActiveDocumentState,
  useOpenDocument,
} from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useValidation } from "../context/validation-context";
import { usePlayFocusedNodeId, usePlaySimulationDocumentId } from "../context/play-context";
import {
  resolveInspectorNodeId,
  useGraphEditing,
} from "../context/graph-editing-context";
import { useOptionalAnimGraphEditing } from "../context/anim-graph-editing-context";
import { usePrefabEditing } from "../context/prefab-editing-context";
import { useOptionalSceneEditing } from "../context/scene-editing-context";
import { PREFAB_ROOT_ID } from "../lib/prefab-preview";
import {
  COMPONENT_GRAPH_MEMBER_CATEGORY,
  componentGraphMembers,
} from "../lib/component-graph-members";
import { classDocumentShowsPrefab, classIdFromClassAsset } from "../lib/content-browser-helpers";
import { physicsWorldFromOpenDocuments, prefabComponentLabel } from "./add-component-catalog";
import {
  commitLogicGraph,
  collectClassGraphsForPalette,
  collectScriptInterfacesForPalette,
  logicGraphEditMergeKey,
  serializedGraphFromDocument,
} from "../lib/logic-graph-document";
import { hydrateSerializedGraphForEditor } from "../services/graph-validation";
import { isDataGraphNode } from "../lib/data-graph";
import { classIdForGraphPath } from "../services/script-compiler";
import { useOpenDocumentsOfKinds } from "../lib/use-open-documents-of-kinds";
import { ClassMemberDetails } from "./inspector-class-member-details";
import { PrefabComponentDetails } from "./inspector-prefab-component-details";
import { GraphNodeDetails } from "./inspector-graph-node-details";
import type { CommittedPinRowIds } from "./inspector-member-rows";
import { useInspectorCatalogs } from "./use-inspector-catalogs";

const CLASS_KINDS = ["graph"] as const;
const WORLD_KINDS = ["scene", "scene-layer"] as const;
const INTERFACE_KINDS = ["script-interface"] as const;

export function InspectorPanel(props: IDockviewPanelProps) {
  const { documentId } = useDocumentWorkspace();
  const simulationDocumentId = usePlaySimulationDocumentId();
  const store = useSimulationInspectionStore();
  return store && simulationDocumentId === documentId
    ? <SimulationInspector store={store} panel={props} />
    : <AuthoringInspectorPanel {...props} />;
}

function AuthoringInspectorPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { applyGraphChange, applyAssetDocumentChange, reparentClassDocument } =
    useDocumentActions();
  const { projectDocument } = useProjectState();
  const { assetRegistry, registryEpoch } = useRegistryState();
  const { animEditorMode } = useActiveDocumentState();
  // The open world Scene or Scene Layer sets the physics world.
  const worldDocuments = useOpenDocumentsOfKinds(WORLD_KINDS);
  const { focusDiagnostic } = useValidation();
  const focusedNodeId = usePlayFocusedNodeId();
  const { selectedNodeIds, selectedMemberId, activeFunctionId } =
    useGraphEditing();
  const animEditing = useOptionalAnimGraphEditing();
  const {
    selectedId: prefabSelectedId,
    selectedIds: prefabSelectedIds,
    components: prefabComponents,
    updateComponent,
    updateComponentTransform,
    setComponentCategory,
  } = usePrefabEditing();
  const viewportMode = useOptionalSceneEditing()?.viewportMode ?? "3d";
  const [parentClassPickOpen, setParentClassPickOpen] = useState(false);
  const [renameEventOpen, setRenameEventOpen] = useState(false);
  const [selectedJsPin, selectJsPin] = useState<string | null>(null);
  const [parentClassError, setParentClassError] = useState<string | null>(null);
  const [classPinPick, setClassPinPick] = useState<{
    pinId: string;
    constraintClassId: string;
  } | null>(null);
  const [assetPinPick, setAssetPinPick] = useState<{
    pinId: string;
    assetType: string;
    allowedTypes: string[];
  } | null>(null);
  const [eventPinRowIds, setEventPinRowIds] = useState<CommittedPinRowIds | null>(null);
  /** Command parameter row ids from the last commit, as for member pins. */
  const [commandRowIds, setCommandRowIds] = useState<{
    nodeId: string;
    parameters: string;
    ids: string[];
  } | null>(null);

  const doc = useOpenDocument(documentId);
  const docPath = doc?.ref.path;
  const catalogs = useInspectorCatalogs(docPath);
  const {
    indexed,
    parentClass,
    parentOf,
    interfaceAssets,
    pickerAssets,
    objectClassEntries,
    projectClasses,
    dataAssets,
    enumMembers,
    typeSchemas,
    typeAssets,
    assetLabel,
    assetType,
    fontHasFacetype,
    fontHasMsdfJson,
    fontHasMsdfPng,
  } = catalogs;
  // Open Class and Script Interface tabs' unsaved content feeds pin hydration.
  const classDocuments = useOpenDocumentsOfKinds(CLASS_KINDS);
  const interfaceDocuments = useOpenDocumentsOfKinds(INTERFACE_KINDS);
  const parsedAnim = useMemo(
    () =>
      doc?.ref.kind === "anim-graph"
        ? parseAnimGraphDocument(doc.content)
        : null,
    [doc?.content, doc?.ref.kind],
  );
  const openRuleId = animEditorMode === "stateMachine"
    ? animEditing?.openTransitionId ?? null
    : null;
  const ruleTransition =
    openRuleId && parsedAnim
      ? (parsedAnim.transitions.find((row) => row.id === openRuleId) ?? null)
      : null;
  const graph = useMemo(
    () => ruleTransition && parsedAnim
      ? {
          ...decorateTransitionRuleGraph(
            ruleTransition.ruleGraph,
            !findReverseTransition(
              parsedAnim.transitions,
              ruleTransition.fromStateId,
              ruleTransition.toStateId,
            ),
          ),
          members: animGraphMembersFromVariables(parsedAnim.variables),
        }
      : serializedGraphFromDocument(doc?.ref.kind ?? "", doc?.content),
    [doc?.content, doc?.ref.kind, parsedAnim, ruleTransition],
  );
  const persistGraph = (next: SerializedGraph) => {
    if (!doc) return;
    if (ruleTransition && parsedAnim) {
      const ruleKey = logicGraphEditMergeKey(graph, next);
      void applyAssetDocumentChange(
        documentId,
        patchTransition(parsedAnim, ruleTransition.id, {
          ruleGraph: persistTransitionRuleGraph(next),
        }) as unknown as Record<string, unknown>,
        ruleKey ? `anim-rule:${ruleTransition.id}:${ruleKey}` : undefined,
      );
      return;
    }
    const commit = commitLogicGraph(doc.ref.kind, doc.content, next);
    if (commit.kind !== "graph") {
      void applyAssetDocumentChange(documentId, commit.payload, commit.mergeKey);
      return;
    }
    void applyGraphChange(documentId, commit.graph);
  };
  const inspectGraph = useMemo(() => {
    if (!graph) return null;
    if (!activeFunctionId) return graph;
    const slice = graph.functionGraphs?.[activeFunctionId];
    if (!slice) return graph;
    return { ...graph, nodes: slice.nodes, edges: slice.edges };
  }, [activeFunctionId, graph]);

  const selectedMember =
    graph && selectedMemberId
      ? (graph.members ?? []).find((member) => member.id === selectedMemberId)
      : undefined;

  const selectedSerializedNode = useMemo(() => {
    if (!inspectGraph || selectedMember) return null;
    const id = resolveInspectorNodeId(
      selectedNodeIds,
      focusDiagnostic?.nodeId,
      focusedNodeId,
    );
    if (!id) return null;
    return inspectGraph.nodes.find((node) => node.id === id) ?? null;
  }, [
    focusDiagnostic?.nodeId,
    focusedNodeId,
    inspectGraph,
    selectedMember,
    selectedNodeIds,
  ]);
  const needsPinHydration = Boolean(selectedSerializedNode && (
    isDataGraphNode(selectedSerializedNode.type) ||
    selectedSerializedNode.type === "struct.make" ||
    selectedSerializedNode.type === "struct.break" ||
    selectedSerializedNode.type === "debug.executeJavaScript" ||
    selectedSerializedNode.type === "tags.select" ||
    !Array.isArray(selectedSerializedNode.data.__pins) ||
    selectedSerializedNode.data.__pins.length === 0
  ));
  // Reuse editor metadata when present. Loaded graphs without pins share one
  // hydrated view across selection changes; edits still persist the raw graph.
  const hydratedInspectGraph = useMemo(() => {
    if (!needsPinHydration || !inspectGraph) return null;
    void registryEpoch; // Registry headers mutate without replacing the registry.
    return hydrateSerializedGraphForEditor(inspectGraph, undefined, {
      parentOf,
      structs: typeSchemas.structs,
      dataDefinitions: typeSchemas.dataDefinitions,
      enums: typeSchemas.enums,
      dataAssets,
      classId: doc?.ref.path ? classIdForGraphPath(doc.ref.path) : undefined,
      otherClassGraphs: collectClassGraphsForPalette({
        assets: assetRegistry?.list() ?? [],
        openDocuments: classDocuments,
        classIdForPath: classIdForGraphPath,
      }),
      functionGraphs: graph?.functionGraphs,
      scriptInterfaces: collectScriptInterfacesForPalette({
        assets: assetRegistry?.list() ?? [],
        openDocuments: interfaceDocuments,
      }),
    });
  }, [
    assetRegistry,
    classDocuments,
    doc?.ref.path,
    graph?.functionGraphs,
    inspectGraph,
    interfaceDocuments,
    needsPinHydration,
    parentOf,
    registryEpoch,
    typeSchemas,
    dataAssets,
  ]);
  const selectedNode = hydratedInspectGraph
    ? hydratedInspectGraph.nodes.find(
        (node) => node.id === selectedSerializedNode?.id,
      ) ?? null
    : selectedSerializedNode;

  const sortingLayers =
    projectDocument?.settings.twoD?.sortingLayers ?? DEFAULT_SORTING_LAYERS;
  const collisionLayers =
    projectDocument?.settings.physics?.collisionLayers ??
    DEFAULT_COLLISION_LAYERS;
  const physicsWorld = physicsWorldFromOpenDocuments(worldDocuments);

  const selectedPrefabComponentIds = prefabSelectedIds.filter(
    (id) => id !== PREFAB_ROOT_ID,
  );

  if (selectedPrefabComponentIds.length > 1) {
    return (
      <PanelFrame data-testid="inspector-panel">
        <div
          className="flex flex-col gap-2 p-3"
          data-testid="inspector-prefab-multi"
        >
          <p className="text-sm font-semibold text-foreground">
            {`${selectedPrefabComponentIds.length} Components`}
          </p>
          <p className="text-xs text-muted-foreground">
            Select one component to edit its properties. Use the Components
            panel to reorder or reparent this selection.
          </p>
          <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
            {prefabComponents
              .filter((component) =>
                selectedPrefabComponentIds.includes(component.id),
              )
              .map((component) => (
                <li key={component.id}>
                  {prefabComponentLabel(component, assetLabel)}
                </li>
              ))}
          </ul>
        </div>
      </PanelFrame>
    );
  }

  const selectedPrefabComponent =
    prefabSelectedId && prefabSelectedId !== PREFAB_ROOT_ID
      ? prefabComponents.find((component) => component.id === prefabSelectedId)
      : undefined;

  if (selectedPrefabComponent) {
    return (
      <PanelFrame data-testid="inspector-panel">
        <PrefabComponentDetails
          actorClassId={doc?.ref.kind === "graph" && doc.ref.path ? classIdForGraphPath(doc.ref.path) : "Actor"}
          component={selectedPrefabComponent}
          components={prefabComponents}
          sceneLayerClasses={objectClassEntries.filter(entry => walkAncestry(entry.id, parentOf).includes("SceneLayerActor"))}
          sortingLayers={sortingLayers}
          collisionLayers={collisionLayers}
          collisionPresets={projectDocument?.settings.physics?.collisionPresets}
          physicsWorld={physicsWorld}
          viewportMode={viewportMode}
          pickerAssets={pickerAssets}
          parentOf={parentOf}
          assetLabel={assetLabel}
          assetType={assetType}
          fontHasFacetype={fontHasFacetype}
          fontHasMsdfJson={fontHasMsdfJson}
          fontHasMsdfPng={fontHasMsdfPng}
          onUpdate={(property, value, alsoSet) =>
            updateComponent(selectedPrefabComponent.id, property, value, alsoSet)
          }
          onUpdateTransform={(transform) =>
            updateComponentTransform(selectedPrefabComponent.id, transform)
          }
        />
      </PanelFrame>
    );
  }

  const selectedComponentMember =
    graph && !selectedMember && selectedMemberId && !openRuleId
      ? componentGraphMembers({ components: prefabComponents, assetLabel }).find(
          (member) => member.id === selectedMemberId,
        )
      : undefined;

  if (selectedComponentMember) {
    const { componentId, name, category } = selectedComponentMember;
    return (
      <PanelFrame data-testid="inspector-panel">
        <div
          className="flex flex-col gap-3 p-3"
          data-testid="inspector-member-component"
        >
          <div className="text-sm font-medium">{name}</div>
          <PropertyGrid
            rows={[
              {
                id: "category",
                kind: "text",
                label: "Category",
                value: category ?? "",
                onChange: () => {},
                onCommit: (next: string) => {
                  const normalized = normalizeClassMemberCategory(next) ?? "";
                  if (normalized === (category ?? "")) return;
                  setComponentCategory(
                    componentId,
                    normalized === COMPONENT_GRAPH_MEMBER_CATEGORY ? undefined : normalized,
                  );
                },
              },
            ]}
          />
        </div>
      </PanelFrame>
    );
  }

  if (
    graph &&
    selectedMember &&
    !openRuleId &&
    selectedMember.kind !== "event"
  ) {
    return (
      <PanelFrame data-testid="inspector-panel">
        <ClassMemberDetails
          graph={graph}
          member={selectedMember}
          interfaceAssets={interfaceAssets}
          classEntries={objectClassEntries}
          typeAssets={typeAssets}
          pickerAssets={pickerAssets}
          schemas={typeSchemas}
          enumMembers={enumMembers}
          classId={doc?.ref.path ? classIdForGraphPath(doc.ref.path) : undefined}
          onChange={persistGraph}
        />
      </PanelFrame>
    );
  }

  if (prefabSelectedId === PREFAB_ROOT_ID && doc?.ref.kind === "prefab") {
    return (
      <PanelFrame data-testid="inspector-panel">
        <div
          className="flex flex-col gap-2 p-3"
          data-testid="inspector-prefab-asset-root"
        >
          <p className="text-sm font-semibold text-foreground">Prefab Root</p>
          <p className="text-xs text-muted-foreground">
            Prefabs have no graph, events, variables, functions or Tick. Placed
            instances copy these components and add no per-frame logic.
          </p>
        </div>
      </PanelFrame>
    );
  }

  if (
    prefabSelectedId === PREFAB_ROOT_ID &&
    doc?.ref.kind === "graph" &&
    graph
  ) {
    const showActorDefaults = classDocumentShowsPrefab(parentClass, parentOf);
    const defaults = graph.actorDefaults ?? {};
    const selfClassId = classIdFromClassAsset({
      path: doc.ref.path,
      header: {
        type: indexed?.header.type ?? "Class",
        name: indexed?.header.name ?? doc.ref.label,
        parentClass,
      },
    });
    const parentOptions: ClassPickerEntry[] = [
      { id: "Actor", name: "Actor", group: "Engine" },
      { id: "SceneLayerActor", name: "Scene Layer Actor", group: "Engine" },
      { id: "SceneLayerActorSwitcher", name: "Scene Layer Actor Switcher", group: "Engine" },
      ...projectClasses
        .filter(
          (entry) =>
            entry.id !== selfClassId &&
            classDocumentShowsPrefab(entry.parentClass, parentOf),
        )
        .map(({ id, name, group }) => ({ id, name, group })),
    ];
    return (
      <PanelFrame data-testid="inspector-panel">
        <FieldGroup className="p-4">
          <Field>
            <FieldLabel>Parent Class</FieldLabel>
            <Button
              type="button"
              variant="outline"
              className="min-h-[var(--touch-target,44px)] w-full justify-start"
              data-testid="inspector-parent-class"
              onClick={() => {
                setParentClassError(null);
                setParentClassPickOpen(true);
              }}
            >
              {parentClass ?? "Actor"}
            </Button>
            {parentClassError ? (
              <FieldError data-testid="inspector-parent-class-error">
                {parentClassError}
              </FieldError>
            ) : null}
          </Field>
        </FieldGroup>
        <ClassPicker
          open={parentClassPickOpen}
          onOpenChange={setParentClassPickOpen}
          title="Parent Class"
          allowNone={false}
          classes={parentOptions}
          data-testid="inspector-parent-class-picker"
          onPick={(classId) => {
            if (!classId || classId === (parentClass ?? "Actor")) return;
            void reparentClassDocument(doc.id, classId).then((error) => {
              setParentClassError(error);
            });
          }}
        />
        {walkAncestry(parentClass ?? "Actor", parentOf).includes("SceneLayerActorSwitcher") ? <SceneLayerSwitcherFields classId={selfClassId} properties={defaults.properties ?? {}} onChange={properties => persistGraph({ ...graph, actorDefaults: { ...defaults, properties } })} /> : null}
        {showActorDefaults ? <>
        <ActorDefaultsGrid
          parentClass={parentClass ?? "Actor"}
          defaults={defaults}
          onChange={(actorDefaults) => persistGraph({ ...graph, actorDefaults })}
        />
        <p
          className="p-4 text-sm text-muted-foreground"
          data-testid="inspector-prefab-origin"
        >
          Prefab Origin is the actor transform in the Scene. Drag the viewport
          gizmo on Prefab Root to move that origin relative to the components.
        </p>
        </> : null}
      </PanelFrame>
    );
  }

  if (!graph || !selectedNode) {
    return (
      <PanelFrame data-testid="inspector-panel">
        <p
          className="p-4 text-sm text-muted-foreground"
          data-testid={openRuleId ? "anim-rule-details-empty" : undefined}
        >
          {openRuleId
            ? "Select a Node"
            : "Select a graph node, class member, or prefab component to edit properties."}
        </p>
      </PanelFrame>
    );
  }

  return (
    <PanelFrame data-testid="inspector-panel">
      <GraphNodeDetails
        graph={graph}
        inspectGraph={inspectGraph}
        hydratedInspectGraph={hydratedInspectGraph}
        selectedNode={selectedNode}
        activeFunctionId={activeFunctionId}
        docPath={docPath}
        focusBodyLine={focusDiagnostic?.bodyLine}
        catalogs={catalogs}
        persistGraph={persistGraph}
        selectedJsPin={selectedJsPin}
        selectJsPin={selectJsPin}
        renameEventOpen={renameEventOpen}
        setRenameEventOpen={setRenameEventOpen}
        classPinPick={classPinPick}
        setClassPinPick={setClassPinPick}
        assetPinPick={assetPinPick}
        setAssetPinPick={setAssetPinPick}
        eventPinRowIds={eventPinRowIds}
        setEventPinRowIds={setEventPinRowIds}
        commandRowIds={commandRowIds}
        setCommandRowIds={setCommandRowIds}
      />
    </PanelFrame>
  );
}

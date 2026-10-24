import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { GlslCodePreview } from "../components/glsl-code-preview";
import {
  canBreakOnNode,
  canvasNodeTitle,
  GraphEditor,
  GRAPH_DEFAULT_ZOOM,
  hasSerializedPins,
  type GraphCanvasDropApi,
  type GraphPasteElements,
  type PaletteNode,
} from "@haptic/graph-ui";
import { formatEventMemberName, NamePromptDialog, PanelFrame, walkAncestry, type NestedMenuItem } from "@haptic/editor-kit";
import { isEditorGraphHost, type SerializedGraph } from "@haptic/core";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@haptic/ui/components/empty";
import {
  useDocumentActions,
  useRegistryState,
  useActiveDocumentState,
  useOpenDocument,
} from "../context/document-context";
import { GraphPinDefaultHostContext } from "../context/graph-pin-defaults-provider";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { usePlay } from "../context/play-context";
import { useBreakpointStore } from "../context/breakpoints-context";
import { breakpointMenuItems } from "../lib/breakpoint-menu";
import { watchablePins, watchPinMenuItems } from "../lib/watch-menu";
import { useWatchStore } from "../context/watch-store-context";
import { conditionPins } from "../lib/breakpoint-settings";
import { useBreakpointSettingsEditor } from "../lib/use-breakpoint-settings-editor";
import { useKeybindChord } from "../context/keybind-context";
import { useValidation } from "../context/validation-context";
import { useGraphEditing } from "../context/graph-editing-context";
import { useAppSettings } from "../context/app-settings-context";
import { useGraphSessionViewport } from "../lib/graph-session-viewport";
import { applyDataGraphAssetPicks } from "../lib/data-graph";
import { prepareClassGraphPaste } from "../lib/graph-paste";
import { canRenameCustomEvent, customEventRenameError, functionLibraryShowsEventGraphEmpty, renameCustomEvent } from "../lib/class-members";
import {
  classMemberSymbolsFromGraphs,
  createDefaultLogicGraphSerialized,
  hydrateSerializedGraphForEditor,
  knownClassIdSet,
  ScriptPaletteCache,
  scriptPaletteInjectorKey,
  scriptPaletteNodes,
  scriptPinCompatibility,
  validateSerializedGraph,
  defaultNodeRegistry,
} from "../services/graph-validation";
import { classIdForGraphPath, functionGraphExportName } from "../services/script-compiler";
import { useAnimObjectGraphRunTrace, useClassGraphRunTrace, useGraphDebugStore } from "../context/graph-debug-context";
import { useSimulationControls } from "../context/simulation-controls-context";
import { GraphSteppingBar } from "../components/graph-stepping-bar";
import type { GraphDebugStepPosition } from "../services/graph-debug-store";
import { sceneAssetClassId } from "@haptic/object-model";
import { shouldPublishGraphDiagnostics } from "../lib/graph-diagnostics-scope";
import {
  MODEL_DOCUMENT_KINDS,
  modelSimpleColliderCounter,
  physicsPairingDiagnostics,
} from "../lib/physics-pairing-diagnostics";
import { useOpenDocumentsOfKinds } from "../lib/use-open-documents-of-kinds";
import { PREFAB_ROOT_ID } from "../lib/prefab-preview";
import {
  commitLogicGraph,
  serializedGraphFromDocument,
} from "../lib/logic-graph-document";
import { useGraphPanelCatalogs } from "./graph-panel-catalogs";
import {
  collectImplementedInterfaceContexts,
  collectParentFunctionSignatures,
} from "../lib/overridable-functions";
import {
  EVENT_GRAPH_PANEL_ID,
  openFunctionGraphPanel,
  type FunctionGraphPanelParams,
} from "../shell/function-graph-panels";
import { claimFocusRouting, graphOwningNode } from "../lib/function-graph-focus";

const registry = defaultNodeRegistry;
const VALIDATION_DEBOUNCE_MS = 250;

/**
 * The Class Event Graph (`graph` panel), or one function graph when DockView
 * passes `functionId` params (`function-graph` panels).
 */
export function GraphPanel(
  props: IDockviewPanelProps<Partial<FunctionGraphPanelParams>>,
) {
  const functionId = props.params?.functionId ?? null;
  const panelApi = props.api as IDockviewPanelProps["api"] | undefined;
  const { documentId } = useDocumentWorkspace();
  const { applyGraphChange, applyAssetDocumentChange } = useDocumentActions();
  const { assetRegistry, registryEpoch } = useRegistryState();
  const { activeDocumentId, animEditorMode } = useActiveDocumentState();
  const { focusedNodeId, openSessionSource } = usePlay();
  const {
    setSelectedNodeIds,
    activeFunctionId: focusedFunctionId,
    setActiveFunctionId,
    releaseActiveFunctionId,
    setCanvasDropApi,
  } = useGraphEditing();
  // Several graph tabs can be mounted at once; the last focused one owns the
  // shared Class, Inspector, drop target, and diagnostics state.
  const focused = focusedFunctionId === functionId;
  const activeFunctionId = functionId;
  const { diagnostics, setDiagnostics, focusDiagnostic, setFocusDiagnostic } =
    useValidation();
  const { settings: appSettings } = useAppSettings();
  const defaultZoom = appSettings.graphDefaultZoom ?? GRAPH_DEFAULT_ZOOM;
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [renameEventId, setRenameEventId] = useState<string | null>(null);
  const paletteCacheRef = useRef(new ScriptPaletteCache());
  const { sessionViewport, onSessionViewportChange } = useGraphSessionViewport(
    documentId,
    activeFunctionId ?? "event",
  );

  const doc = useOpenDocument(documentId);
  const modelDocuments = useOpenDocumentsOfKinds(MODEL_DOCUMENT_KINDS);
  const indexed = useMemo(() => {
    void registryEpoch;
    return (assetRegistry?.list() ?? []).find(
      (asset) => asset.path === doc?.ref.path,
    );
  }, [assetRegistry, registryEpoch, doc?.ref.path]);
  const parentClass =
    indexed?.header.parentClass ??
    (doc?.ref.kind === "anim-graph" ? "BObject" : null);
  const {
    parentOf,
    otherClassGraphs,
    functionLibraries,
    subsystemClasses,
    sceneDocuments,
    scriptInterfaces,
    typeAssets,
    typeSchemas,
    hierarchy,
    inputAssets,
    saveGameDefinition,
    materialDomains,
    dataAssets,
  } = useGraphPanelCatalogs();
  const classId = doc?.ref.path ? classIdForGraphPath(doc.ref.path) : undefined;
  const graphContent = useMemo(
    () => serializedGraphFromDocument(doc?.ref.kind ?? "", doc?.content),
    [doc?.ref.kind, doc?.content],
  );
  // While a Simulation follows an instance of this Class, the canvas shows what that instance ran in this graph.
  const runGraphId = activeFunctionId
    ? functionGraphExportName({
        id: activeFunctionId,
        name: graphContent?.members?.find((member) => member.id === activeFunctionId)?.name,
      })
    : "event-graph";
  const classRunTrace = useClassGraphRunTrace(doc?.ref.kind === "graph" ? doc.ref.path : undefined, classId, runGraphId);
  // An Animation Graph's Animation Object graph is compiled like a Class graph, under its own id.
  const animObjectRunTrace = useAnimObjectGraphRunTrace(
    doc?.ref.kind === "anim-graph" ? doc.ref.path : undefined,
    indexed?.header.guid,
  );
  const runTrace = classRunTrace ?? animObjectRunTrace;
  // While a debugged graph is paused, its canvas carries the stepping control.
  const graphDebug = useGraphDebugStore();
  const simulationControls = useSimulationControls();
  const focusStep = useCallback((position: GraphDebugStepPosition) => {
    void openSessionSource({
      severity: "info", code: "editor.step", message: "Step",
      assetGuid: position.assetGuid, graphId: position.graphId, nodeId: position.nodeId,
    });
  }, [openSessionSource]);
  const steppingBar = runTrace && graphDebug && simulationControls?.paused
    ? <GraphSteppingBar store={graphDebug} controls={simulationControls} onFocus={focusStep} />
    : undefined;
  const memberSymbols = useMemo(() => {
    const graphs = { ...otherClassGraphs };
    if (classId && graphContent) graphs[classId] = graphContent;
    return classMemberSymbolsFromGraphs(graphs, { parentOf });
  }, [classId, graphContent, otherClassGraphs, parentOf]);
  const knownClassIds = useMemo(
    () =>
      knownClassIdSet(parentOf, [
        ...Object.keys(otherClassGraphs),
        ...sceneDocuments.map((scene) => sceneAssetClassId(scene.guid)),
      ]),
    [otherClassGraphs, parentOf, sceneDocuments],
  );
  const pinCompatibility = useMemo(
    () => scriptPinCompatibility(hierarchy),
    [hierarchy],
  );
  const pinTypeNames = useMemo(() => {
    const names: Record<string, string> = {};
    for (const [guid, schema] of Object.entries(typeSchemas.structs)) {
      names[guid] = schema.name;
    }
    for (const [guid, schema] of Object.entries(typeSchemas.enums)) {
      names[guid] = schema.name;
    }
    return names;
  }, [typeSchemas]);
  const graph = useMemo(() => {
    const slice =
      activeFunctionId && graphContent?.functionGraphs?.[activeFunctionId]
        ? graphContent.functionGraphs[activeFunctionId]
        : null;
    const visible: SerializedGraph | null = slice
      ? {
          nodes: slice.nodes,
          edges: slice.edges,
          members: graphContent?.members,
          components: graphContent?.components,
        }
      : graphContent;
    return hydrateSerializedGraphForEditor(
      visible ??
        createDefaultLogicGraphSerialized(registry, {
          parentClass,
          parentOf,
          assetType: indexed?.header.type,
        }),
      registry,
      {
        parentOf,
        inputAssets,
        dataAssets,
        structs: typeSchemas.structs,
        dataDefinitions: typeSchemas.dataDefinitions,
        enums: typeSchemas.enums,
        classId,
        otherClassGraphs,
        functionGraphs: graphContent?.functionGraphs,
        functionId: activeFunctionId ?? undefined,
        scriptInterfaces,
      },
    );
  }, [
    activeFunctionId,
    classId,
    graphContent,
    indexed?.header.type,
    otherClassGraphs,
    parentClass,
    parentOf,
    scriptInterfaces,
    typeSchemas,
    inputAssets,
    dataAssets,
  ]);

  const assetGuid = doc?.ref.path ?? documentId;

  // Breakpoints use the compiler's terms: the Class path and the graph's run id.
  const breakpointStore = useBreakpointStore();
  const breakpointAsset = breakpointStore && doc?.ref.kind === "graph" ? doc.ref.path : undefined;
  // Pin watches use the same terms.
  const watchStore = useWatchStore();
  const watchAsset = watchStore && doc?.ref.kind === "graph" ? doc.ref.path : undefined;
  const toggleBreakpointChord = useKeybindChord("graph.toggleBreakpoint");
  const graphName = activeFunctionId
    ? graphContent?.members?.find((member) => member.id === activeFunctionId)?.name ?? activeFunctionId
    : "Event Graph";
  const latestGraph = useRef(graph);
  latestGraph.current = graph;
  const breakpointLabel = useCallback((nodeId: string) => {
    const node = latestGraph.current.nodes.find((candidate) => candidate.id === nodeId);
    return {
      className: classId ?? breakpointAsset ?? "",
      graphName,
      nodeTitle: node ? canvasNodeTitle(node.data, node.type) : nodeId,
    };
  }, [breakpointAsset, classId, graphName]);
  const breakpoints = useMemo(
    () => breakpointStore && breakpointAsset ? breakpointStore.graphView(breakpointAsset, runGraphId, breakpointLabel) : undefined,
    [breakpointAsset, breakpointLabel, breakpointStore, runGraphId],
  );
  const { edit: editBreakpoint, dialog: breakpointSettingsDialog } = useBreakpointSettingsEditor(breakpointStore);
  // A function graph runs under its name, so renaming a function moves its breakpoints and watches with it.
  const functionRunIds = useMemo(() => new Map(
    Object.keys(graphContent?.functionGraphs ?? {}).map((id) => [id, functionGraphExportName({
      id,
      name: graphContent?.members?.find((member) => member.id === id)?.name,
    })]),
  ), [graphContent?.functionGraphs, graphContent?.members]);
  const previousFunctionRunIds = useRef(functionRunIds);
  useEffect(() => {
    const before = previousFunctionRunIds.current;
    previousFunctionRunIds.current = functionRunIds;
    if (before === functionRunIds) return;
    for (const [id, runId] of functionRunIds) {
      const previous = before.get(id);
      if (previous === undefined || previous === runId) continue;
      const name = graphContent?.members?.find((member) => member.id === id)?.name ?? id;
      if (breakpointStore && breakpointAsset) breakpointStore.renameGraph(breakpointAsset, previous, runId, name);
      if (watchStore && watchAsset) watchStore.renameGraph(watchAsset, previous, runId, name);
    }
  }, [breakpointAsset, breakpointStore, functionRunIds, graphContent?.members, watchAsset, watchStore]);

  useEffect(() => {
    if (!panelApi) return;
    const claim = () => setActiveFunctionId(functionId);
    if (panelApi.isActive || panelApi.isVisible) claim();
    const subscriptions = [
      panelApi.onDidActiveChange((event) => {
        if (event.isActive) claim();
      }),
      panelApi.onDidVisibilityChange((event) => {
        if (event.isVisible) claim();
      }),
    ];
    return () => {
      for (const subscription of subscriptions) subscription.dispose();
      if (functionId) releaseActiveFunctionId(functionId);
    };
  }, [functionId, panelApi, releaseActiveFunctionId, setActiveFunctionId]);

  const functionMember = functionId
    ? graphContent?.members?.find((member) => member.id === functionId)
    : undefined;
  const functionMissing =
    functionId !== null &&
    graphContent !== null &&
    graphContent !== undefined &&
    !graphContent.functionGraphs?.[functionId];
  useEffect(() => {
    if (!panelApi) return;
    // A deleted function closes its tab; a rename retitles it.
    if (functionMissing) {
      panelApi.close();
      return;
    }
    const title = functionId ? functionMember?.name : undefined;
    if (title && panelApi.title !== title) panelApi.setTitle(title);
  }, [functionId, functionMember?.name, functionMissing, panelApi]);

  // A node chosen elsewhere (Session Report, project search) can live in a
  // graph whose tab is not showing: bring that tab forward so the node frames.
  const graphContentRef = useRef(graphContent);
  graphContentRef.current = graphContent;
  const containerApi = props.containerApi as
    | IDockviewPanelProps["containerApi"]
    | undefined;
  useEffect(() => {
    const nodeId = focusDiagnostic?.nodeId;
    if (!focusDiagnostic || !nodeId || !containerApi || documentId !== activeDocumentId) return;
    const content = graphContentRef.current;
    const owner = graphOwningNode(content, nodeId);
    if (!owner || !claimFocusRouting(focusDiagnostic)) return;
    if (owner.kind === "event") {
      if (functionId !== null) containerApi.getPanel(EVENT_GRAPH_PANEL_ID)?.api.setActive();
    } else if (owner.functionId !== functionId) {
      const name = content?.members?.find((member) => member.id === owner.functionId)?.name;
      openFunctionGraphPanel(containerApi, owner.functionId, name ?? owner.functionId);
    }
  }, [activeDocumentId, containerApi, documentId, focusDiagnostic, functionId]);

  const [canvasApi, setCanvasApi] = useState<GraphCanvasDropApi | null>(null);
  useEffect(() => {
    if (!focused) return;
    setCanvasDropApi(canvasApi);
    return () => setCanvasDropApi(null);
  }, [canvasApi, focused, setCanvasDropApi]);

  // Edit-time validation is debounced so typing in a node does not re-run the
  // whole pass on every keystroke; save and pre-Preview sweeps are immediate.
  useEffect(() => {
    if (
      !focused ||
      !shouldPublishGraphDiagnostics({
        documentId,
        activeDocumentId,
        documentKind: doc?.ref.kind ?? "",
        animEditorMode:
          doc?.ref.kind === "anim-graph" ? animEditorMode : undefined,
      })
    ) {
      return;
    }
    const handle = window.setTimeout(() => {
      const graphPayload = graphContent ?? graph;
      setDiagnostics([
        ...validateSerializedGraph(graphPayload, {
          assetGuid,
          graphId: documentId,
          hierarchy,
          classId,
          activeFunctionId,
          members: memberSymbols,
          knownClassIds,
          implementedInterfaces: collectImplementedInterfaceContexts({
            graph: graphContent ?? undefined,
            classId,
            parentOf,
            parentGraphs: otherClassGraphs,
            scriptInterfaces,
          }),
          parentFunctionSignatures: collectParentFunctionSignatures({
            classId,
            parentOf,
            parentGraphs: otherClassGraphs,
          }),
          enums: typeSchemas.enums,
          inputAssets,
          dataAssets,
          structs: typeSchemas.structs,
          dataDefinitions: typeSchemas.dataDefinitions,
          materialDomains,
          parentOf,
          otherClassGraphs,
          subsystemClasses,
        }),
        ...physicsPairingDiagnostics(
          [
            {
              id: PREFAB_ROOT_ID,
              components: graphContent?.components ?? [],
            },
          ],
          {
            assetGuid,
            graphId: documentId,
            modelSimpleColliderCount: modelSimpleColliderCounter(assetRegistry, modelDocuments),
          },
        ),
      ]);
    }, VALIDATION_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [
    activeDocumentId,
    activeFunctionId,
    assetGuid,
    assetRegistry,
    registryEpoch,
    modelDocuments,
    classId,
    doc?.ref.kind,
    documentId,
    graphContent,
    graph,
    hierarchy,
    knownClassIds,
    memberSymbols,
    otherClassGraphs,
    parentOf,
    scriptInterfaces,
    setDiagnostics,
    inputAssets,
    dataAssets,
    typeSchemas,
    animEditorMode,
    focused,
    materialDomains,
    subsystemClasses,
  ]);

  const paletteInput = {
    saveGameDefinition,
    inputAssets,
    parentClass,
    parentOf,
    classId,
    graph: graphContent ?? undefined,
    otherClassGraphs,
    // Inherited prefab components become Get rows, as in hydrate and validation.
    parentGraphs: otherClassGraphs,
    activeFunctionId,
    assetType: indexed?.header.type,
    functionLibraries,
    scriptInterfaces,
    structures: typeAssets.structures,
    dataDefinitions: typeAssets.dataDefinitions,
    enums: typeAssets.enums,
    sceneDocuments,
    subsystemClasses,
    animationGraphHost:
      doc?.ref.kind === "anim-graph" ? ("object" as const) : undefined,
  };
  const paletteInputRef = useRef(paletteInput);
  paletteInputRef.current = paletteInput;
  // A closed palette holds only catalog rows, which follow the host's ancestry
  // and graph slice. The injector key walks every class, asset and scene, so it
  // is built only while Add Node is open.
  const paletteKey = paletteOpen
    ? scriptPaletteInjectorKey(paletteInput)
    : JSON.stringify([
        classId ?? null,
        paletteInput.assetType ?? null,
        paletteInput.animationGraphHost ?? null,
        activeFunctionId ?? null,
        walkAncestry(parentClass ?? "Actor", parentOf),
      ]);
  const paletteNodes = useMemo(
    (): PaletteNode[] =>
      scriptPaletteNodes(registry, paletteInputRef.current, {
        injectors: paletteOpen,
        cache: paletteCacheRef.current,
      }),
    [paletteKey, paletteOpen],
  );

  const focusId = focusDiagnostic?.nodeId ?? focusedNodeId ?? undefined;
  const graphDiagnostics = useMemo(
    () =>
      diagnostics.map((d) => ({
        nodeId: d.nodeId,
        pinId: d.pinId,
        severity: d.severity,
        message: d.message,
      })),
    [diagnostics],
  );
  const nodeTypeById = useMemo(() => {
    const nodes = activeFunctionId
      ? graphContent?.functionGraphs?.[activeFunctionId]?.nodes
      : graphContent?.nodes;
    return new Map((nodes ?? []).map((node) => [node.id, node.type]));
  }, [activeFunctionId, graphContent]);
  const renderNodeBody = useCallback(
    (nodeId: string, data: Record<string, unknown>) =>
      nodeTypeById.get(nodeId) === "debug.executeJavaScript" ? (
        <div className="w-88 border-t px-3 py-2">
          <GlslCodePreview
            value={String(data.body ?? "")}
            language="javascript"
          />
        </div>
      ) : null,
    [nodeTypeById],
  );
  const onNavigateRequest = useCallback(
    () => setFocusDiagnostic(null),
    [setFocusDiagnostic],
  );
  const contextMenuItemsForNode = useCallback(
    (nodeId: string) => {
      const items: NestedMenuItem[] = graphContent && canRenameCustomEvent(graphContent, nodeId)
        ? [{ id: "rename-event", label: "Rename Event", onSelect: () => setRenameEventId(nodeId) }]
        : [];
      const { nodes, edges } = latestGraph.current;
      const node = nodes.find((candidate) => candidate.id === nodeId);
      if (watchStore && watchAsset) {
        const pins = watchablePins(node?.data, (pinId) => edges.some((edge) => edge.target === nodeId && edge.targetHandle === pinId));
        items.push(...watchPinMenuItems(watchStore, pins, (pin) => ({
          kind: "pin", assetGuid: watchAsset, graphId: runGraphId, nodeId, pinId: pin.id, direction: pin.direction,
          label: { ...breakpointLabel(nodeId), className: classId ?? watchAsset, pinName: pin.name },
        })));
      }
      if (!breakpointStore || !breakpointAsset || !canBreakOnNode(node?.data)) return items;
      const location = { assetGuid: breakpointAsset, graphId: runGraphId, nodeId };
      const edit = () => {
        const { nodes, edges } = latestGraph.current;
        const data = nodes.find((candidate) => candidate.id === nodeId)?.data;
        editBreakpoint({
          location,
          nodeTitle: breakpointLabel(nodeId).nodeTitle,
          pins: conditionPins(hasSerializedPins(data) ? data.__pins : [],
            (pinId) => edges.some((edge) => edge.target === nodeId && edge.targetHandle === pinId)),
        });
      };
      return [
        ...items,
        ...breakpointMenuItems(breakpointStore, location, () => breakpointLabel(nodeId), toggleBreakpointChord, edit),
      ];
    },
    [breakpointAsset, breakpointLabel, breakpointStore, classId, editBreakpoint, graphContent, runGraphId, toggleBreakpointChord, watchAsset, watchStore],
  );

  const preparePaste = useCallback(
    (pasted: GraphPasteElements, current: GraphPasteElements) =>
      prepareClassGraphPaste(pasted, current, graphContent, activeFunctionId),
    [activeFunctionId, graphContent],
  );

  const showLibraryEmpty = functionLibraryShowsEventGraphEmpty({
    parentClass,
    parentOf,
    activeFunctionId,
  });

  return (
    <PanelFrame data-testid="graph-panel">
      {showLibraryEmpty ? (
        <Empty data-testid="function-library-event-graph-empty">
          <EmptyHeader>
            <EmptyTitle>No Event Graph</EmptyTitle>
            <EmptyDescription>
              Function libraries only have functions. Add one in the Class
              panel.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <GraphPinDefaultHostContext.Provider value={isEditorGraphHost({ parentClass, parentOf, assetType: indexed?.header.type })}>
          <GraphEditor
            renderNodeBody={renderNodeBody}
            key={`${documentId}:${activeFunctionId ?? "event"}`}
            initialGraph={graph}
            runTrace={runTrace}
            overlay={steppingBar}
            breakpoints={breakpoints}
            commitPositionsOnDragEnd
            singleExecOutputOnConnect
            colorMode="dark"
            defaultZoom={defaultZoom}
            sessionViewport={sessionViewport}
            onSessionViewportChange={onSessionViewportChange}
            focusedNodeId={focusId}
            diagnostics={graphDiagnostics}
            paletteNodes={paletteNodes}
            onPaletteOpenChange={setPaletteOpen}
            pinCompatibility={pinCompatibility}
            pinTypeNames={pinTypeNames}
            onCanvasApi={setCanvasApi}
            onNavigateRequest={onNavigateRequest}
            onSelectionChange={setSelectedNodeIds}
            contextMenuItemsForNode={contextMenuItemsForNode}
            preparePaste={preparePaste}
            onChange={(next) => {
              if (!doc) return;
              const edited = applyDataGraphAssetPicks(graph, next, dataAssets);
              const current = graphContent ?? { nodes: [], edges: [] };
              const merged: SerializedGraph = activeFunctionId
                ? {
                    ...current,
                    functionGraphs: {
                      ...current.functionGraphs,
                      [activeFunctionId]: {
                        nodes: edited.nodes,
                        edges: edited.edges,
                      },
                    },
                  }
                : {
                    ...edited,
                    members: edited.members ?? current.members,
                    components: edited.components ?? current.components,
                    functionGraphs: current.functionGraphs,
                  };
              const commit = commitLogicGraph(doc.ref.kind, doc.content, merged);
              if (commit.kind !== "graph") {
                void applyAssetDocumentChange(documentId, commit.payload, commit.mergeKey);
                return;
              }
              void applyGraphChange(documentId, commit.graph);
            }}
          />
        </GraphPinDefaultHostContext.Provider>
      )}
      <NamePromptDialog
        open={renameEventId !== null}
        onOpenChange={(open) => { if (!open) setRenameEventId(null); }}
        title="Rename Event"
        label="Event Name"
        confirmLabel="Rename"
        initialValue={(() => {
          const node = graphContent?.nodes.find((entry) => entry.id === renameEventId);
          return formatEventMemberName(String(node?.data.name ?? node?.data.title ?? ""));
        })()}
        validate={(name) => graphContent && renameEventId ? customEventRenameError(graphContent, renameEventId, name) : null}
        onSubmit={(name) => {
          if (!doc || !graphContent || !renameEventId) return;
          const next = renameCustomEvent(graphContent, renameEventId, name, classId);
          const commit = commitLogicGraph(doc.ref.kind, doc.content, next);
          if (commit.kind === "graph") void applyGraphChange(documentId, commit.graph);
          else void applyAssetDocumentChange(documentId, commit.payload, commit.mergeKey);
        }}
      />
      {breakpointSettingsDialog}
    </PanelFrame>
  );
}

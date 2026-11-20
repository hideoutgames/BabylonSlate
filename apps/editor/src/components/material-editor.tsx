import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ViewportZoomControls } from "./viewport-zoom-controls";
import { MessageDetails } from "./message-details";
import { DiagnosticResultRow } from "./diagnostic-result-row";
import { nodeDiagnosticDetails } from "../lib/diagnostic-details";
import { MaterialCustomGlsl, renderMaterialNodeBody } from "./material-custom-glsl";
import { GlobalParameterNodePicker } from "./global-parameter-node-picker";
import { useGlobalParameterCatalog } from "../lib/global-parameter-catalog";
import type { IDockviewPanelProps } from "dockview-react";
import {
  AssetPicker,
  AssetPickerControl,
  EntryListEditor,
  PanelFrame,
  mergePropertyRows,
  PinListEditor,
  PropertyGrid,
  SelectableText,
  WindowedList,
  WINDOWED_LIST_TOUCH_ROW_HEIGHT,
  assetRowIdentity,
  selectedPickerIdentity,
  type KeyChord,
  type NestedMenuItem,
  type PinListRow,
  type PropertyRow,
} from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";
import { Empty, EmptyDescription, EmptyTitle } from "@haptic/ui/components/empty";
import { ScrollArea } from "@haptic/ui/components/scroll-area";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@haptic/ui/components/toggle-group";
import { GraphEditor, type GraphPasteElements, type PaletteNode } from "@haptic/graph-ui";
import { useGraphSessionViewport } from "../lib/graph-session-viewport";
import { useRevealResultWindow } from "../lib/use-reveal-result-window";
import { useDockPanelShown } from "../lib/use-dock-panel-shown";
import { primaryDockPanel } from "../shell/window-catalog";
import { isMaterialSamplerTextureAsset } from "../lib/content-browser-helpers";
import {
  MATERIAL_PREVIEW_MESHES,
  classifyMaterialCost,
  canConvertMaterialConstantToParameter,
  canConvertMaterialParameterToConstant,
  convertMaterialConstantToParameter,
  convertMaterialParameterToConstant,
  isMaterialParameterNode,
  materialParameterName,
  materialParameterValueType,
  renameMaterialParameter,
  retypeMaterialParameter,
  type MaterialParameterValueType,
  materialGradientStops,
  vectorMaskChannelName,
  vectorMaskChannels,
  swizzleComponents,
  SWIZZLE_AXES,
  VECTOR_MASK_CHANNELS,
  materialNodeDefinition,
  customGlslInterface,
  hydrateMaterialGraphForEditor,
  MATERIAL_GLOBAL_PARAMETER_NODE_TYPE,
  selectMaterialGlobalParameter,
  listUnconnectedMaterialPinDefaults,
  materialGraphToSerialized,
  materialAddNodePalette,
  isNamedRerouteDeclarationType,
  isNamedRerouteUsageType,
  namedRerouteColor,
  namedRerouteDeclarationId,
  namedRerouteName,
  namedReroutePaletteNodes,
  remapPastedNamedReroutes,
  renameNamedReroute,
  NAMED_REROUTE_DECLARATION_TYPE,
  type MaterialPaletteNode,
  materialNodePreviewOutputs,
  materialNodeTitle,
  materialPinDefaultPropertyKey,
  materialPinsAreCompatible,
  normalizeMaterialDocument,
  normalizeMaterialFunctionDocument,
  serializedToMaterialFunctionGraph,
  serializedToMaterialGraph,
  setMaterialDomain,
  parseMaterialDomain,
  materialBlendModesFor,
  validateMaterialDocument,
  validateMaterialFunctionDocument,
  type MaterialBlendMode,
  type MaterialDocument,
  type MaterialFunctionDocument,
  type MaterialDomain,
  type MaterialFunctionPin,
  type MaterialPreviewMesh,
  type MaterialNodePreviewTarget,
  type MaterialPreviewSettings,
} from "@haptic/shader-graph";
import {
  BoxIcon,
  BoxSelectIcon,
  CircleIcon,
  ConeIcon,
  CylinderIcon,
  EyeIcon,
  EyeOffIcon,
  PencilIcon,
  RouteIcon,
  SquareIcon,
  type LucideIcon,
} from "lucide-react";
import {
  useDocumentActions,
  useOpenDocument,
  useRegistryState,
} from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useKeybindChord, useKeybindCommand } from "../context/keybind-context";
import { useMaterialEditing } from "../context/material-editing-context";
import { documentBatch, type DocumentBatch } from "../lib/document-batch";

const PREVIEW_MESH_LABEL: Record<MaterialPreviewMesh, string> = {
  cube: "Cube",
  sphere: "Sphere",
  cylinder: "Cylinder",
  cone: "Cone",
  plane: "Plane",
  custom: "Custom",
};

function previewMeshIcon(mesh: MaterialPreviewMesh): LucideIcon {
  // Resolve live imports when rendering; lazy production chunks can initialize
  // shared icons after this module, so a module-level map can capture undefined.
  const icons: Record<MaterialPreviewMesh, LucideIcon> = {
    cube: BoxIcon,
    sphere: CircleIcon,
    cylinder: CylinderIcon,
    cone: ConeIcon,
    plane: SquareIcon,
    custom: BoxSelectIcon,
  };
  return icons[mesh];
}

type MaterialGraphDocument = MaterialDocument | MaterialFunctionDocument;

function materialPinDefaultRows(
  document: MaterialGraphDocument,
  nodeId: string,
  functions: Record<string, MaterialFunctionDocument>,
  onPatch: (patch: Record<string, unknown>) => void,
): PropertyRow[] {
  return listUnconnectedMaterialPinDefaults(document, nodeId, { functions }).map(
    (entry) => {
      const key = materialPinDefaultPropertyKey(entry.pinId);
      if (entry.colorHint) {
        const alpha = entry.type === "vec4" ? (entry.value[3] ?? 1) : undefined;
        return {
          id: entry.pinId,
          kind: "color",
          label: entry.name,
          value: [
            entry.value[0] ?? 0,
            entry.value[1] ?? 0,
            entry.value[2] ?? 0,
          ],
          onChange: (next) =>
            onPatch({
              [key]:
                alpha === undefined
                  ? [next[0], next[1], next[2]]
                  : [next[0], next[1], next[2], alpha],
            }),
        };
      }
      if (entry.type === "float" || entry.type === "generic") {
        return {
          id: entry.pinId,
          kind: "number",
          label: entry.name,
          value: entry.value[0] ?? 0,
          onChange: (next) => onPatch({ [key]: [next] }),
        };
      }
      if (entry.type === "vec2") {
        return {
          id: entry.pinId,
          kind: "vector3",
          label: entry.name,
          value: [entry.value[0] ?? 0, entry.value[1] ?? 0, 0],
          axes: ["X", "Y"],
          onChange: (next) => onPatch({ [key]: [next[0], next[1]] }),
        };
      }
      if (entry.type === "vec4") {
        return {
          id: entry.pinId,
          kind: "vector3",
          label: entry.name,
          value: [
            entry.value[0] ?? 0,
            entry.value[1] ?? 0,
            entry.value[2] ?? 0,
            entry.value[3] ?? 0,
          ],
          axes: ["X", "Y", "Z", "W"],
          onChange: (next) =>
            onPatch({
              [key]: [
                next[0],
                next[1],
                next[2],
                next.length > 3 ? next[3]! : 0,
              ],
            }),
        };
      }
      return {
        id: entry.pinId,
        kind: "vector3",
        label: entry.name,
        value: [
          entry.value[0] ?? 0,
          entry.value[1] ?? 0,
          entry.value[2] ?? 0,
        ],
        axes: ["X", "Y", "Z"],
        onChange: (next) => onPatch({ [key]: [next[0], next[1], next[2]] }),
      };
    },
  );
}

function useMaterialDocument(): {
  documentId: string;
  document: MaterialDocument;
  commit: (next: MaterialDocument, mergeKey?: string) => void;
} {
  const { documentId } = useDocumentWorkspace();
  const { applyAssetDocumentChange } = useDocumentActions();
  const doc = useOpenDocument(documentId);
  const document = useMemo(
    () => normalizeMaterialDocument(doc?.content ?? {}),
    [doc?.content],
  );
  const commit = useCallback(
    (next: MaterialDocument, mergeKey?: string) => {
      void applyAssetDocumentChange(
        documentId,
        next as unknown as Record<string, unknown>,
        mergeKey,
      );
    },
    [applyAssetDocumentChange, documentId],
  );
  return { documentId, document, commit };
}

function useMaterialFunctionDocument(): {
  documentId: string;
  document: MaterialFunctionDocument;
  commit: (next: MaterialFunctionDocument, mergeKey?: string) => void;
} {
  const { documentId } = useDocumentWorkspace();
  const { applyAssetDocumentChange } = useDocumentActions();
  const doc = useOpenDocument(documentId);
  const document = useMemo(
    () => normalizeMaterialFunctionDocument(doc?.content ?? {}),
    [doc?.content],
  );
  const commit = useCallback(
    (next: MaterialFunctionDocument, mergeKey?: string) => {
      void applyAssetDocumentChange(
        documentId,
        next as unknown as Record<string, unknown>,
        mergeKey,
      );
    },
    [applyAssetDocumentChange, documentId],
  );
  return { documentId, document, commit };
}

function useTextureExists(): (guid: string) => boolean {
  const { assetRegistry } = useRegistryState();
  return useCallback(
    (guid: string) => {
      const header = assetRegistry?.getByGuid(guid)?.header;
      return header ? isMaterialSamplerTextureAsset(header) : false;
    },
    [assetRegistry],
  );
}

const MATERIAL_PARAMETER_TYPE_OPTIONS: { value: MaterialParameterValueType; label: string }[] = [
  { value: "float", label: "Float" },
  { value: "vec2", label: "Vector2" },
  { value: "vec3", label: "Vector3" },
  { value: "vec4", label: "Vector4" },
  { value: "color", label: "Color" },
  { value: "texture", label: "Texture" },
];

/**
 * The node menu's **Convert to Parameter** on a Float, Vector2, Vector3, Vector4 or Color Constant and
 * **Convert to Constant** on a parameter that is not a Texture. It reads the document as it is
 * when picked.
 */
function useMaterialConversionMenu<T extends MaterialGraphDocument>(document: T, commit: (next: T) => void) {
  const documentRef = useRef(document);
  documentRef.current = document;
  return useCallback((nodeId: string): NestedMenuItem[] => {
    const node = documentRef.current.nodes.find((entry) => entry.id === nodeId);
    if (node && canConvertMaterialConstantToParameter(node.type)) {
      return [{ id: "convert-to-parameter", label: "Convert to Parameter", testId: "material-convert-to-parameter", onSelect: () => {
        const next = convertMaterialConstantToParameter(documentRef.current, nodeId);
        if (next) commit(next);
      } }];
    }
    if (node && canConvertMaterialParameterToConstant(node.type)) {
      return [{ id: "convert-to-constant", label: "Convert to Constant", testId: "material-convert-to-constant", onSelect: () => {
        const next = convertMaterialParameterToConstant(documentRef.current, nodeId);
        if (next) commit(next);
      } }];
    }
    return [];
  }, [commit]);
}

/**
 * What the **Preview Node** key does with the one selected node: stop when that node is previewed, or
 * when it is the output node while another node is; otherwise preview its first numeric output.
 * Undefined when the key does nothing (a node with no numeric output, or the output node with nothing previewed).
 */
function previewNodeKeyResult(
  document: MaterialDocument,
  nodeId: string,
  previewNode: MaterialNodePreviewTarget | null,
  functions: Record<string, MaterialFunctionDocument>,
): MaterialNodePreviewTarget | null | undefined {
  const node = document.nodes.find((entry) => entry.id === nodeId);
  if (!node) return undefined;
  if (previewNode?.nodeId === nodeId) return null;
  if (materialNodeDefinition(node.type)?.terminal) return previewNode ? null : undefined;
  const first = materialNodePreviewOutputs(document, nodeId, { functions })[0];
  return first ? { nodeId, pinId: first.pinId } : undefined;
}

/**
 * The node menu's **Preview Node**: an item for a node with one numeric output, a submenu of its outputs
 * for a node with several, and **Stop Previewing Node** on the previewed node and on the output node.
 * `shortcut` is the key's chord, shown on the entry the key would run.
 */
function usePreviewNodeMenu(document: MaterialDocument, shortcut: KeyChord | undefined) {
  const editing = useMaterialEditing();
  const { previewNode, setPreviewNode, functions } = editing;
  const documentRef = useRef(document);
  documentRef.current = document;
  return useCallback((nodeId: string): NestedMenuItem[] => {
    const current = documentRef.current;
    const stop: NestedMenuItem = { id: "stop-previewing-node", label: "Stop Previewing Node", testId: "material-stop-previewing-node", icon: <EyeOffIcon />, shortcut, onSelect: () => setPreviewNode(null) };
    const node = current.nodes.find((entry) => entry.id === nodeId);
    if (node && materialNodeDefinition(node.type)?.terminal) return previewNode ? [stop] : [];
    const outputs = materialNodePreviewOutputs(current, nodeId, { functions });
    if (outputs.length === 0) return [];
    const previewed = previewNode?.nodeId === nodeId ? previewNode.pinId : null;
    if (outputs.length === 1) {
      return previewed ? [stop] : [{ id: "preview-node", label: "Preview Node", testId: "material-preview-node", icon: <EyeIcon />, shortcut, onSelect: () => setPreviewNode({ nodeId, pinId: outputs[0]!.pinId }) }];
    }
    const choose: NestedMenuItem = {
      type: "submenu", id: "preview-node", label: "Preview Node", testId: "material-preview-node", icon: <EyeIcon />,
      items: [{
        type: "radio-group", id: "preview-node-output", value: previewed ?? "", closeOnClick: true,
        onValueChange: (pinId) => setPreviewNode({ nodeId, pinId }),
        // The key previews the first output; on the previewed node it stops instead.
        items: outputs.map((output, index) => ({ id: output.pinId, label: output.name, value: output.pinId, testId: `material-preview-node-${output.pinId}`, shortcut: index === 0 && !previewed ? shortcut : undefined })),
      }],
    };
    return previewed ? [stop, choose] : [choose];
  }, [functions, previewNode, setPreviewNode, shortcut]);
}

/**
 * The previewed node as the canvas titles it, with the output's name when the node has several, for
 * the Preview banner and the node's tag. Null while the Material's own output is previewed.
 */
function usePreviewedNode(document: MaterialDocument): { nodeId: string; title: string; output: string | null } | null {
  const { previewNode, functions } = useMaterialEditing();
  const globalParameters = useGlobalParameterCatalog();
  return useMemo(() => {
    const node = previewNode && document.nodes.find((entry) => entry.id === previewNode.nodeId);
    if (!previewNode || !node) return null;
    const outputs = materialNodePreviewOutputs(document, node.id, { functions });
    return {
      nodeId: node.id,
      title: materialNodeTitle(node, { functions, globalParameters, graphNodes: document.nodes }),
      output: outputs.length > 1 ? outputs.find((output) => output.pinId === previewNode.pinId)?.name ?? null : null,
    };
  }, [document, functions, globalParameters, previewNode]);
}

/** Nodes the canvas renames in their header: parameters and Named Reroute declarations. */
function isRenamableMaterialNode(type: string): boolean {
  return isMaterialParameterNode(type) || isNamedRerouteDeclarationType(type);
}

/** Rows whose chips, titles or pin types differ; Add Node rebuilds its list only when this changes. */
function namedRerouteRowsSignature(rows: readonly MaterialPaletteNode[]): string {
  return JSON.stringify(rows.map((row) => [row.id, row.title, row.headerColor, row.pins.map((pin) => pin.type.kind)]));
}

/**
 * Naming on a Material or Material Function canvas: the Named Reroute Add Node rows (one per
 * declaration, after **Create Named Reroute…**), the header rename of parameters and declarations
 * (a new declaration, a title double-click or the node menu's **Rename**), **Select Declaration** on
 * a usage, and pasted usages following a declaration pasted with them. Everything reads the document
 * as it is when used.
 */
function useMaterialCanvasNaming<T extends MaterialGraphDocument>(
  document: T,
  commit: (next: T) => void,
  staticPalette: readonly PaletteNode[],
  context: { functions: Record<string, MaterialFunctionDocument>; functionInterface?: MaterialFunctionDocument },
  focusNode: (nodeId: string) => void,
) {
  const documentRef = useRef(document);
  documentRef.current = document;
  const contextRef = useRef(context);
  contextRef.current = context;

  // A node move or an unrelated edit keeps the same rows, so Add Node does not rebuild.
  const rowsRef = useRef<{ signature: string; rows: MaterialPaletteNode[] } | null>(null);
  const rerouteRows = useMemo(() => {
    const rows = namedReroutePaletteNodes(document, { functions: context.functions, functionInterface: context.functionInterface });
    const signature = namedRerouteRowsSignature(rows);
    if (rowsRef.current?.signature !== signature) rowsRef.current = { signature, rows };
    return rowsRef.current.rows;
  }, [document, context.functions, context.functionInterface]);
  const paletteNodes = useMemo(() => [...staticPalette, ...rerouteRows], [rerouteRows, staticPalette]);

  // `seen` turns true once the document holds the node: a new declaration is renamed before its add
  // commits, and the rename ends when the node leaves the document (deleted, or the add undone).
  const [renaming, setRenaming] = useState<{ nodeId: string; seen: boolean } | null>(null);
  if (renaming) {
    const exists = document.nodes.some((node) => node.id === renaming.nodeId);
    if (exists && !renaming.seen) setRenaming({ nodeId: renaming.nodeId, seen: true });
    else if (!exists && renaming.seen) setRenaming(null);
  }

  // Parameters and Named Reroute declarations rename in their header; each keeps its own unique-name rule.
  const onNodeRenameCommit = useCallback((nodeId: string, name: string) => {
    setRenaming(null);
    const current = documentRef.current;
    const node = current.nodes.find((entry) => entry.id === nodeId);
    if (!node || !name.trim()) return;
    if (isNamedRerouteDeclarationType(node.type)) {
      const nodes = renameNamedReroute(current.nodes, nodeId, name);
      if (nodes !== current.nodes) commit({ ...current, nodes });
    } else if (isMaterialParameterNode(node.type) && name.trim() !== materialParameterName(node)) {
      commit(renameMaterialParameter(current, nodeId, name));
    }
  }, [commit]);
  const onNodeRenameCancel = useCallback(() => setRenaming(null), []);
  // The field starts from the stored name: a blank parameter is titled by its type, not edited as one.
  const renamingNode = renaming ? document.nodes.find((node) => node.id === renaming.nodeId) : undefined;
  const renamingNodeValue = renamingNode
    ? isNamedRerouteDeclarationType(renamingNode.type) ? namedRerouteName(renamingNode) : materialParameterName(renamingNode)
    : undefined;

  // The Create row takes a name and colour free in the graph as it is now, not when the list was built.
  const preparePaletteNode = useCallback((row: PaletteNode): PaletteNode => {
    if (row.id !== NAMED_REROUTE_DECLARATION_TYPE) return row;
    const fresh = namedReroutePaletteNodes(documentRef.current, contextRef.current)[0]!;
    return { ...row, nodeTitle: fresh.nodeTitle, defaultData: fresh.defaultData, headerColor: fresh.headerColor };
  }, []);
  // A new declaration opens its rename at once (GraphEditor focuses it once Add Node closes).
  const onPaletteNodeAdded = useCallback((row: PaletteNode, nodeId: string) => {
    if (row.id === NAMED_REROUTE_DECLARATION_TYPE) setRenaming({ nodeId, seen: false });
  }, []);

  const selectDeclaration = useCallback((nodeId: string): boolean => {
    const nodes = documentRef.current.nodes;
    const node = nodes.find((entry) => entry.id === nodeId);
    if (!node || !isNamedRerouteUsageType(node.type)) return false;
    const declarationId = namedRerouteDeclarationId(node);
    if (!nodes.some((entry) => entry.id === declarationId && isNamedRerouteDeclarationType(entry.type))) return false;
    focusNode(declarationId);
    return true;
  }, [focusNode]);

  // Double-click: a declaration opens its rename, a usage goes to its declaration.
  // Double-click on a usage, title or body, goes to its declaration; a renamable node's title renames it.
  const onNodeDoubleClick = useCallback((nodeId: string) => { selectDeclaration(nodeId); }, [selectDeclaration]);
  const onNodeTitleDoubleClick = useCallback((nodeId: string) => {
    const node = documentRef.current.nodes.find((entry) => entry.id === nodeId);
    if (node && isRenamableMaterialNode(node.type)) setRenaming({ nodeId, seen: true });
    else selectDeclaration(nodeId);
  }, [selectDeclaration]);

  const menu = useCallback((nodeId: string): NestedMenuItem[] => {
    const nodes = documentRef.current.nodes;
    const node = nodes.find((entry) => entry.id === nodeId);
    if (node && isRenamableMaterialNode(node.type)) {
      return [{ id: "rename-node", label: "Rename", testId: "material-rename-node", icon: <PencilIcon />, onSelect: () => setRenaming({ nodeId, seen: true }) }];
    }
    if (node && isNamedRerouteUsageType(node.type)) {
      const declarationId = namedRerouteDeclarationId(node);
      if (!nodes.some((entry) => entry.id === declarationId && isNamedRerouteDeclarationType(entry.type))) return [];
      return [{ id: "select-named-reroute-declaration", label: "Select Declaration", testId: "material-select-named-reroute-declaration", icon: <RouteIcon />, onSelect: () => { selectDeclaration(nodeId); } }];
    }
    return [];
  }, [selectDeclaration]);

  const preparePaste = useCallback(
    (pasted: GraphPasteElements, _current: GraphPasteElements, idMap: ReadonlyMap<string, string>) =>
      ({ nodes: remapPastedNamedReroutes(pasted.nodes, idMap) }),
    [],
  );

  return {
    menu,
    props: {
      paletteNodes,
      renamingNodeId: renaming?.nodeId ?? null,
      renamingNodeValue,
      onNodeTitleDoubleClick,
      onNodeRenameCommit,
      onNodeRenameCancel,
      preparePaletteNode,
      onPaletteNodeAdded,
      onNodeDoubleClick,
      preparePaste,
    },
  };
}

export function MaterialGraphPanel(_props: IDockviewPanelProps) {
  void _props;
  const { document, documentId, commit } = useMaterialDocument();
  const editing = useMaterialEditing();
  const functions = editing.functions;
  const conversionMenu = useMaterialConversionMenu(document, commit);
  const { sessionViewport, onSessionViewportChange } =
    useGraphSessionViewport(documentId);
  const textureExists = useTextureExists();
  const globalParameters = useGlobalParameterCatalog();

  const diagnostics = useMemo(
    () =>
      [
        ...validateMaterialDocument(document, {
          functions,
          textureExists,
          warnPostProcessCost: true,
          globalParameters,
        }),
      ].map((row) => ({
        nodeId: row.nodeId,
        severity: row.severity,
        message: row.message,
      })),
    [document, functions, textureExists, globalParameters],
  );

  const initialGraph = useMemo(
    () =>
      hydrateMaterialGraphForEditor(materialGraphToSerialized(document), {
        functions,
        globalParameters,
      }),
    [document, functions, globalParameters],
  );
  // Preview Node's key acts on one selected node only: several have no one output to show.
  const previewChord = useKeybindChord("material.previewNode");
  const canvasRef = useRef<HTMLDivElement>(null);
  const keyNodeId = editing.selectedNodeIds.length === 1 ? editing.selectedNodeIds[0]! : null;
  const keyResult = useMemo(
    () => keyNodeId ? previewNodeKeyResult(document, keyNodeId, editing.previewNode, functions) : undefined,
    [document, editing.previewNode, functions, keyNodeId],
  );
  useKeybindCommand("material.previewNode", () => { if (keyResult !== undefined) editing.setPreviewNode(keyResult); }, {
    enabled: keyResult !== undefined,
    focusWithinRef: canvasRef,
  });
  const previewMenu = usePreviewNodeMenu(document, previewChord);
  const staticPalette = useMemo(() => materialAddNodePalette(document.domain), [document.domain]);
  const reroutes = useMaterialCanvasNaming(document, commit, staticPalette, { functions }, editing.focusNode);
  const rerouteMenu = reroutes.menu;
  const nodeMenu = useCallback(
    (nodeId: string) => [...rerouteMenu(nodeId), ...previewMenu(nodeId), ...conversionMenu(nodeId)],
    [conversionMenu, previewMenu, rerouteMenu],
  );
  const previewed = usePreviewedNode(document);
  const previewedNode = useMemo(
    () => previewed ? { nodeId: previewed.nodeId, label: previewed.output ? `Previewing ${previewed.output}` : "Previewing" } : null,
    [previewed],
  );

  return (
    <PanelFrame className="flex-1" data-testid="material-graph-panel">
      <div
        ref={canvasRef}
        className="flex h-full min-h-0 flex-col"
        data-testid="material-graph-editor"
      >
        <GraphEditor
          renderNodeBody={renderMaterialNodeBody}
          initialGraph={initialGraph}
          diagnostics={diagnostics}
          {...reroutes.props}
          pinCompatibility={materialPinsAreCompatible}
          addNodeHistoryScope="material"
          sessionViewport={sessionViewport}
          onSessionViewportChange={onSessionViewportChange}
          onSelectionChange={editing.setSelectedNodeIds}
          focusedNodeId={editing.focusedNodeId ?? undefined}
          focusRequest={editing.focusRequest}
          commitPositionsOnDragEnd
          contextMenuItemsForNode={nodeMenu}
          previewedNode={previewedNode}
          onChange={(next, meta) => {
            const nextDocument = serializedToMaterialGraph(next, document);
            commit(
              nextDocument,
              meta?.kind === "position" && meta.transactionId
                ? `material-node-move:${meta.transactionId}`
                : undefined,
            );
          }}
        />
      </div>
    </PanelFrame>
  );
}

export function MaterialFunctionGraphPanel(_props: IDockviewPanelProps) {
  void _props;
  const { document, documentId, commit } = useMaterialFunctionDocument();
  const editing = useMaterialEditing();
  const conversionMenu = useMaterialConversionMenu(document, commit);
  const { sessionViewport, onSessionViewportChange } =
    useGraphSessionViewport(documentId);
  const globalParameters = useGlobalParameterCatalog();

  const diagnostics = useMemo(
    () =>
      validateMaterialFunctionDocument(document, {
        functions: editing.functions,
        globalParameters,
      }).map((row) => ({
        nodeId: row.nodeId,
        severity: row.severity,
        message: row.message,
      })),
    [document, editing.functions, globalParameters],
  );

  const initialGraph = useMemo(
    () =>
      hydrateMaterialGraphForEditor(materialGraphToSerialized(document), {
        functions: editing.functions,
        functionInterface: document,
        globalParameters,
      }),
    [document, editing.functions, globalParameters],
  );
  const staticPalette = useMemo(() => materialAddNodePalette("surface"), []);
  const rerouteContext = useMemo(() => ({ functions: editing.functions, functionInterface: document }), [document, editing.functions]);
  const reroutes = useMaterialCanvasNaming(document, commit, staticPalette, rerouteContext, editing.focusNode);
  const rerouteMenu = reroutes.menu;
  const nodeMenu = useCallback(
    (nodeId: string) => [...rerouteMenu(nodeId), ...conversionMenu(nodeId)],
    [conversionMenu, rerouteMenu],
  );

  return (
    <PanelFrame className="flex-1" data-testid="material-function-graph-panel">
      <div
        className="flex h-full min-h-0 flex-col"
        data-testid="material-function-graph-editor"
      >
        <GraphEditor
          renderNodeBody={renderMaterialNodeBody}
          initialGraph={initialGraph}
          diagnostics={diagnostics}
          {...reroutes.props}
          pinCompatibility={materialPinsAreCompatible}
          addNodeHistoryScope="material"
          sessionViewport={sessionViewport}
          onSessionViewportChange={onSessionViewportChange}
          onSelectionChange={editing.setSelectedNodeIds}
          focusedNodeId={editing.focusedNodeId ?? undefined}
          focusRequest={editing.focusRequest}
          commitPositionsOnDragEnd
          contextMenuItemsForNode={nodeMenu}
          onChange={(next, meta) => {
            const nextDocument = serializedToMaterialFunctionGraph(next, document);
            commit(
              nextDocument,
              meta?.kind === "position" && meta.transactionId
                ? `material-node-move:${meta.transactionId}`
                : undefined,
            );
          }}
        />
      </div>
    </PanelFrame>
  );
}

/**
 * Preview dock: primitive picker, the Render control, and the live canvas the
 * render host draws into.
 */
export function MaterialPreviewPanel(props: IDockviewPanelProps) {
  const shown = useDockPanelShown(props.api);
  const { document, commit } = useMaterialDocument();
  const { setPreviewNode } = useMaterialEditing();
  return (
    <MaterialPreviewSurface
      preview={document.preview}
      domain={document.domain}
      onPreviewChange={(preview) => commit({ ...document, preview })}
      previewedNode={usePreviewedNode(document)}
      onStopPreviewingNode={() => setPreviewNode(null)}
      shown={shown}
    />
  );
}

/** The preview canvas with its mesh picker; shared by Materials and Material Instances. */
export function MaterialPreviewSurface({
  preview,
  domain,
  onPreviewChange,
  previewedNode = null,
  onStopPreviewingNode,
  shown = true,
}: {
  preview: MaterialPreviewSettings;
  domain: MaterialDomain | null;
  onPreviewChange: (preview: MaterialPreviewSettings) => void;
  /** The node the preview shows instead of the Material's output (**Preview Node**). */
  previewedNode?: { title: string; output: string | null } | null;
  onStopPreviewingNode?: () => void;
  /** Whether the Preview window is on screen (`useDockPanelShown`); the preview requests no frames otherwise. */
  shown?: boolean;
}) {
  const editing = useMaterialEditing();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [meshPickOpen, setMeshPickOpen] = useState(false);
  const { assetRegistry, registryEpoch } = useRegistryState();

  useEffect(() => {
    editing.attachPreviewCanvas(canvasRef.current);
    return () => editing.attachPreviewCanvas(null);
  }, [editing.attachPreviewCanvas]);
  const { setPreviewShown } = editing;
  useEffect(() => setPreviewShown(shown), [setPreviewShown, shown]);

  const modelAssets = useMemo(() => {
    void registryEpoch; // Registry contents mutate without replacing its instance.
    if (!meshPickOpen) return [];
    return (assetRegistry?.list() ?? [])
      .filter((asset) => asset.header.type === "Model")
      .map((asset) => ({
        guid: asset.header.guid,
        name: asset.header.name,
        type: asset.header.type,
        path: asset.path,
      }));
  }, [assetRegistry, registryEpoch, meshPickOpen]);

  const status = editing.previewState.status;
  // Dismissing the picker keeps the current mesh; only a pick changes it.
  const openCustomMeshPicker = () => setMeshPickOpen(true);

  return (
    <PanelFrame className="flex-1" data-testid="material-preview-panel">
      {previewedNode ? (
        <div
          className="flex min-h-7 shrink-0 items-center gap-1.5 border-b border-(--warning)/40 bg-(--warning)/15 pr-1 pl-2 text-xs text-(--warning)"
          role="status"
          data-testid="material-preview-node-banner"
        >
          <EyeIcon className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 truncate">
            Previewing Node: <span className="font-semibold">{previewedNode.output ? `${previewedNode.title} · ${previewedNode.output}` : previewedNode.title}</span>
          </span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="ml-auto shrink-0 text-(--warning) hover:bg-(--warning)/20 hover:text-(--warning) pointer-coarse:h-[var(--touch-target,44px)]"
            onClick={onStopPreviewingNode}
            data-testid="material-preview-node-stop"
          >
            Stop Previewing
          </Button>
        </div>
      ) : null}
      <div className="relative flex h-full min-h-0 flex-col">
        {/* Frames the canvas so a node's value is never taken for the Material. */}
        {previewedNode ? <div className="pointer-events-none absolute inset-0 z-10 ring-2 ring-inset ring-(--warning)" aria-hidden="true" /> : null}
        {domain !== "particle" && domain !== "text" && domain !== "decal" ? <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center p-2">
          <div
            className="pointer-events-auto toolbar-island flex-wrap"
            data-testid="material-preview-overlay"
          >
            <ToggleGroup
              variant="outline"
              size="sm"
              spacing={1}
              value={[preview.mesh]}
              onValueChange={(value) => {
                const next = value[0] as MaterialPreviewMesh | undefined;
                if (!next) return;
                if (next === "custom") {
                  openCustomMeshPicker();
                  return;
                }
                onPreviewChange({ mesh: next, customMeshGuid: null });
              }}
              aria-label="Preview Mesh"
              data-testid="material-preview-mesh"
            >
              {MATERIAL_PREVIEW_MESHES.map((mesh) => {
                const Icon = previewMeshIcon(mesh);
                return (
                  <ToggleGroupItem
                    key={mesh}
                    value={mesh}
                    aria-label={PREVIEW_MESH_LABEL[mesh]}
                    data-testid={`material-preview-mesh-${mesh}`}
                    onClick={
                      mesh === "custom"
                        ? openCustomMeshPicker
                        : undefined
                    }
                  >
                    <Icon />
                  </ToggleGroupItem>
                );
              })}
            </ToggleGroup>
          </div>
        </div> : null}
        <canvas
          ref={canvasRef}
          data-testid="material-preview-canvas"
          data-status={status}
          data-ready-generation={editing.previewState.readyGeneration ?? -1}
          className="min-h-40 w-full flex-1 touch-none bg-background"
        />
        {/* The zoom buttons sit in the corner, above the error line while one shows. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex flex-col items-end">
          <div className="mb-3 mr-3">
            <ViewportZoomControls drive={editing.previewZoomDrive} testId="material-preview-zoom-controls" />
          </div>
          {editing.previewState.lastError ? (
            <p
              className="pointer-events-auto w-full px-3 py-1 text-xs text-destructive"
              data-testid="material-preview-error"
            >
              <SelectableText>{editing.previewState.lastError}</SelectableText>
            </p>
          ) : null}
        </div>
        <AssetPicker
          open={meshPickOpen}
          onOpenChange={setMeshPickOpen}
          assets={modelAssets}
          allowedTypes={["Model"]}
          title="Pick Preview Mesh"
          allowNone
          onPick={(guid) => {
            onPreviewChange(guid
              ? { mesh: "custom", customMeshGuid: guid }
              : { mesh: "cube", customMeshGuid: null });
            setMeshPickOpen(false);
          }}
          data-testid="material-preview-mesh-picker"
        />
      </div>
    </PanelFrame>
  );
}

const MATERIAL_BLEND_MODE_LABELS: Record<MaterialBlendMode, string> = {
  opaque: "Opaque",
  masked: "Masked",
  translucent: "Translucent",
  additive: "Additive",
  multiply: "Multiply",
};
const POST_PROCESS_BLEND_MODES: readonly MaterialBlendMode[] = ["opaque", "masked", "translucent", "additive"];

/** Domain, shading and blend settings plus the selected node's properties. */
export function MaterialDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const doc = useOpenDocument(documentId);
  const isFunction = doc?.ref.kind === "material-function";
  return isFunction ? (
    <MaterialFunctionDetails />
  ) : (
    <MaterialDocumentDetails />
  );
}

function MaterialDocumentDetails() {
  const { document, commit } = useMaterialDocument();
  const editing = useMaterialEditing();
  const rows: PropertyRow[] = [
    {
      id: "domain",
      kind: "enum",
      label: "Domain",
      value: document.domain,
      options: [
        { value: "surface", label: "Surface" },
        { value: "landscape", label: "Landscape" },
        { value: "postProcess", label: "Post Process" },
        { value: "particle", label: "Particle" },
        { value: "text", label: "Text" },
        { value: "decal", label: "Decal" },
      ],
      onChange: (value) =>
        commit(setMaterialDomain(document, parseMaterialDomain(value))),
    },
    {
      id: "shadingModel",
      kind: "enum",
      label: "Shading Model",
      value: document.shadingModel,
      options: [
        { value: "pbr", label: "PBR" },
        { value: "unlit", label: "Unlit" },
      ],
      onChange: (value) =>
        commit({
          ...document,
          shadingModel: value === "unlit" ? "unlit" : "pbr",
        }),
    },
    {
      id: "blendMode",
      kind: "enum",
      label: "Blend Mode",
      value: document.blendMode,
      // Post Process keeps the row it had, though no pass reads it.
      options: (document.domain === "postProcess" ? POST_PROCESS_BLEND_MODES : materialBlendModesFor(document.domain))
        .map((mode) => ({ value: mode, label: MATERIAL_BLEND_MODE_LABELS[mode] })),
      onChange: (value) =>
        commit({
          ...document,
          blendMode: value as MaterialDocument["blendMode"],
        }),
    },
    {
      id: "twoSided",
      kind: "boolean",
      label: "Two Sided",
      value: document.twoSided,
      onChange: (value) => commit({ ...document, twoSided: value }),
    },
    {
      id: "defaultNormals",
      kind: "enum",
      label: "Default Normals",
      description: "Used when the Normal input is unconnected. Flat Normals shade each triangle as a flat face.",
      value: document.defaultNormals,
      defaultValue: "model",
      options: [
        { value: "model", label: "Model Normals" },
        { value: "flat", label: "Flat Normals" },
      ],
      onChange: (value) => commit({ ...document, defaultNormals: value === "flat" ? "flat" : "model" }),
    },
  ];
  if ((document.domain === "surface" || document.domain === "landscape")) rows.push({ id: "boundsPadding", kind: "number", label: "Bounds Padding (Local)", value: document.boundsPadding ?? 0, min: 0, onChange: (boundsPadding) => commit({ ...document, boundsPadding }, "material:boundsPadding") });
  if ((document.domain !== "surface" && document.domain !== "landscape")) {
    // Particle emitters own blending (their Render module), so particle Materials hide Blend Mode.
    // A decal draws a box's far faces over the surfaces in it, and its normal is the surface's: no Two Sided or Default Normals.
    const hidden = document.domain === "particle" || document.domain === "text" ? ["shadingModel", "blendMode", "twoSided", "defaultNormals"]
      : document.domain === "decal" ? ["twoSided", "defaultNormals"] : ["shadingModel", "twoSided", "defaultNormals"];
    for (let i = rows.length - 1; i >= 0; i--) if (hidden.includes(rows[i]!.id)) rows.splice(i, 1);
  }
  if ((document.domain === "surface" || document.domain === "landscape" || document.domain === "decal") && document.blendMode === "masked") {
    rows.push({
      id: "alphaCutoff",
      kind: "slider",
      label: "Alpha Cutoff",
      value: document.alphaCutoff,
      min: 0,
      max: 1,
      onChange: (value) => commit({ ...document, alphaCutoff: value }, "material:alphaCutoff"),
    });
  }

  const selected = selectedMaterialNodes(document, editing.selectedNodeIds);

  return (
    <PanelFrame className="flex-1" data-testid="material-details-panel">
      {selected.length > 1 ? (
        <MaterialNodesDetails document={document} commit={commit} nodes={selected} />
      ) : selected.length === 1 ? (
        <MaterialNodeDetails
          document={document}
          commit={commit}
          selectedNodeId={selected[0]!.id}
        />
      ) : (
        <div className="flex flex-col gap-2" data-testid="material-settings">
          <PropertyGrid rows={rows} />
          <MaterialCostSummary />
        </div>
      )}
    </PanelFrame>
  );
}

function MaterialCostSummary() {
  const { document } = useMaterialDocument();
  const editing = useMaterialEditing();
  // The provider lowers this document once per edit; lowering it again here doubled the cost.
  const lowered = editing.lowering;
  if (!lowered?.ok) return null;
  const cost = lowered.plan.cost;
  const costClass = classifyMaterialCost(cost, {
    frameBudgetMs: editing.frameBudgetMs,
    domain: document.domain,
    observedCompileMs: editing.previewState.compileSamplesMs,
  });
  return (
    <p
      className="px-3 text-xs text-muted-foreground"
      data-testid="material-cost"
      data-cost-class={costClass}
    >
      {cost.operations} operations · {cost.textureSamples} texture samples ·{" "}
      {costClass === "cheap" ? "renders automatically" : "press Render"}
    </p>
  );
}

/** Every selected node in the document, in selection order. */
function selectedMaterialNodes<T extends MaterialGraphDocument>(
  document: T,
  ids: readonly string[],
): T["nodes"][number][] {
  return ids.flatMap((id) => document.nodes.find((entry) => entry.id === id) ?? []);
}

/**
 * Keyed by node and property names: a value scrub, color drag or typed field
 * is one undo step, while each separate click still starts a new one.
 */
function setMaterialNodeProperties<T extends MaterialGraphDocument>(
  edit: DocumentBatch<T>,
  nodeId: string,
  properties: Record<string, unknown>,
) {
  const document = edit.read();
  const node = document.nodes.find((entry) => entry.id === nodeId);
  if (!node) return;
  const pins = node.type === "custom.glsl" && (properties.inputs || properties.outputs) ? customGlslInterface({ ...node.properties, ...properties }) : null;
  edit.write({
    ...document,
    ...(pins ? { edges: document.edges.filter((edge) => (edge.sourceNodeId !== node.id || pins.outputs.some((pin) => pin.id === edge.sourcePinId)) && (edge.targetNodeId !== node.id || pins.inputs.some((pin) => pin.id === edge.targetPinId))) } : {}),
    nodes: document.nodes.map((entry) =>
      entry.id === node.id
        ? { ...entry, properties: { ...entry.properties, ...properties } }
        : entry,
    ),
  }, `material-node:${node.id}:${Object.keys(properties).sort().join(",")}`);
}

/**
 * A node's Details rows. Callbacks read and write through `edit`, so a
 * multi-selection's batch applies every node's change to one document.
 */
function materialNodeRows<T extends MaterialGraphDocument>(
  node: T["nodes"][number],
  edit: DocumentBatch<T>,
  functions: Record<string, MaterialFunctionDocument>,
  multi = false,
): PropertyRow[] {
  const setProperties = (properties: Record<string, unknown>) =>
    setMaterialNodeProperties(edit, node.id, properties);

  const rows: PropertyRow[] = materialPinDefaultRows(
    edit.read(),
    node.id,
    functions,
    setProperties,
  );
  if (isMaterialParameterNode(node.type)) {
    rows.unshift({
      id: "parameterType",
      kind: "enum",
      label: "Type",
      value: materialParameterValueType(node.type) ?? "float",
      options: MATERIAL_PARAMETER_TYPE_OPTIONS,
      // The default is resized; wires from an output the new type lacks are dropped.
      onChange: (type) => edit.write(retypeMaterialParameter(edit.read(), node.id, type as MaterialParameterValueType)),
    });
    // A parameter's name is its own, so a multi-selection never sets one name on several.
    if (!multi) rows.unshift({
      id: "name",
      kind: "text",
      label: "Parameter Name",
      value: materialParameterName(node),
      onChange: () => undefined,
      onCommit: (name) => edit.write(renameMaterialParameter(edit.read(), node.id, name)),
    });
    // A Material's own Float or Color parameter can vary per actor and still draw in one batch.
    if ((node.type === "param.float" || node.type === "param.color") && "domain" in edit.read()) rows.splice(multi ? 1 : 2, 0, {
      id: "perInstance",
      kind: "boolean",
      label: "Per Instance",
      value: node.properties.perInstance === true,
      onChange: (perInstance) => setProperties({ perInstance }),
    });
  }
  if (isNamedRerouteDeclarationType(node.type)) {
    // A declaration's name is its own, so a multi-selection only shares Color.
    if (!multi) rows.push({
      id: "rerouteName",
      kind: "text",
      label: "Name",
      value: namedRerouteName(node),
      onChange: () => undefined,
      onCommit: (name) => {
        const document = edit.read();
        const nodes = renameNamedReroute(document.nodes, node.id, name);
        if (nodes !== document.nodes) edit.write({ ...document, nodes });
      },
    });
    rows.push({
      id: "rerouteColor",
      kind: "color",
      label: "Color",
      value: namedRerouteColor(node),
      onChange: (next) => setProperties({ color: [next[0], next[1], next[2]] }),
    });
  }
  if (isNamedRerouteUsageType(node.type) && !multi) {
    const declarationId = namedRerouteDeclarationId(node);
    const declaration = edit.read().nodes.find((entry) => entry.id === declarationId && isNamedRerouteDeclarationType(entry.type));
    rows.push({ id: "reroute", kind: "info", label: "Reroute", value: declaration ? namedRerouteName(declaration) : "Missing Reroute" });
  }
  if (node.type === "const.float" || node.type === "param.float") {
    const value = Array.isArray(node.properties.value)
      ? Number(node.properties.value[0] ?? 0)
      : 0;
    rows.push({
      id: "value",
      kind: "number",
      label: "Value",
      value,
      onChange: (next) => setProperties({ value: [next] }),
    });
  }
  if (node.type === "const.color" || node.type === "param.color") {
    const value = Array.isArray(node.properties.value)
      ? (node.properties.value as number[])
      : [1, 1, 1, 1];
    rows.push({
      id: "color",
      kind: "color",
      label: "Color",
      value: [value[0] ?? 1, value[1] ?? 1, value[2] ?? 1],
      onChange: (next) =>
        setProperties({ value: [next[0], next[1], next[2], value[3] ?? 1] }),
    });
  }
  if (node.type === "param.color") {
    const value = Array.isArray(node.properties.value)
      ? node.properties.value as number[]
      : [];
    rows.push({
      id: "value",
      kind: "vector3",
      label: "Default Value",
      axes: ["X", "Y", "Z", "W"],
      value: [value[0] ?? 1, value[1] ?? 1, value[2] ?? 1, value[3] ?? 1],
      onChange: (next) => setProperties({ value: [...next] }),
    });
  }
  if (node.type === "const.vec2" || node.type === "const.vec3" || node.type === "const.vec4" ||
    node.type === "param.vec2" || node.type === "param.vec3" || node.type === "param.vec4") {
    const width = node.type.endsWith("vec2") ? 2 : node.type.endsWith("vec3") ? 3 : 4;
    const value = Array.isArray(node.properties.value)
      ? (node.properties.value as number[])
      : [];
    rows.push({
      id: "vector",
      kind: "vector3",
      label: "Value",
      value: width === 4 ? [value[0] ?? 0, value[1] ?? 0, value[2] ?? 0, value[3] ?? 0] : [value[0] ?? 0, value[1] ?? 0, value[2] ?? 0],
      axes: ["X", "Y", "Z", "W"].slice(0, width),
      onChange: (next) => setProperties({ value: next.slice(0, width) }),
    });
  }

  if (node.type === "vector.mask") {
    const selected = vectorMaskChannels(node.properties);
    for (const channel of VECTOR_MASK_CHANNELS) rows.push({ id: `mask-${channel}`, kind: "boolean", label: vectorMaskChannelName(channel), value: selected.includes(channel), disabled: selected.length === 1 && selected.includes(channel), onChange: (value) => setProperties({ [channel]: value }) });
  }
  if (node.type === "vector.swizzle") {
    // One row per output component; a row set to None ends the vector there.
    const axes = swizzleComponents(node.properties);
    for (let index = 0; index < 4; index += 1) rows.push({
      id: `swizzle-${index}`, kind: "enum", label: `Component ${index + 1}`, value: axes[index] ?? "none",
      options: [...(index > 0 ? [{ value: "none", label: "None" }] : []), ...SWIZZLE_AXES.map((axis) => ({ value: axis, label: axis.toUpperCase() }))],
      disabled: index > axes.length,
      onChange: (axis) => setProperties({ components: (axis === "none" ? axes.slice(0, index) : [...axes.slice(0, index), axis, ...axes.slice(index + 1)]).join("") }),
    });
  }
  if (node.type === "texture.sample" || node.type === "texture.sampleLod" || node.type === "texture.triplanar") rows.push({
    id: "colorSpace", kind: "enum", label: "Color Space", value: String(node.properties.colorSpace ?? "color"),
    options: [{ value: "color", label: "Color (sRGB)" }, { value: "data", label: "Data (Linear)" }],
    onChange: (colorSpace) => setProperties({ colorSpace }),
  });
  if (node.type === "input.uv") rows.push({
    id: "channel", kind: "enum", label: "UV Channel", value: node.properties.channel === 1 ? "1" : "0",
    options: [{ value: "0", label: "UV 0" }, { value: "1", label: "UV 1" }],
    onChange: (channel) => setProperties({ channel: Number(channel) }),
  });
  if (node.type === "texture.sample") rows.push({
    id: "filter", kind: "enum", label: "Filter", value: node.properties.filter === "nearest" ? "nearest" : "linear",
    options: [{ value: "linear", label: "Linear" }, { value: "nearest", label: "Nearest" }],
    onChange: (filter) => setProperties({ filter }),
  });

  return rows;
}

/** The rows several selected nodes share: a property or unconnected input every one has under the same name and type. */
function MaterialNodesDetails<T extends MaterialGraphDocument>({
  document,
  commit,
  nodes,
}: {
  document: T;
  commit: (next: T, mergeKey?: string) => void;
  nodes: readonly T["nodes"][number][];
}) {
  const editing = useMaterialEditing();
  const edit = documentBatch(document, commit);
  const rows = mergePropertyRows(
    nodes.map((node) => materialNodeRows(node, edit, editing.functions, true)),
    { batch: edit.batch },
  );
  return (
    <div className="flex flex-col gap-2" data-testid="material-node-details">
      <p className="px-3 text-xs text-muted-foreground">{`${nodes.length} Nodes`}</p>
      {rows.length > 0 ? <PropertyGrid rows={rows} /> : null}
    </div>
  );
}

/** Per-node properties for the selected graph node. */
function MaterialNodeDetails<T extends MaterialGraphDocument>({
  document,
  commit,
  selectedNodeId,
}: {
  document: T;
  commit: (next: T, mergeKey?: string) => void;
  selectedNodeId: string | null;
}) {
  const { assetRegistry, registryEpoch } = useRegistryState();
  const editing = useMaterialEditing();
  const [pickOpen, setPickOpen] = useState(false);
  const node = document.nodes.find((entry) => entry.id === selectedNodeId);
  const isTextureNode = node?.type === "param.texture" ||
    node?.type === "texture.sample" || node?.type === "texture.sampleLod";
  const textureAssets = useMemo(() => {
    void registryEpoch; // Registry contents mutate without replacing its instance.
    if (!pickOpen || !isTextureNode) return [];
    return (assetRegistry?.list() ?? [])
      .filter((asset) => isMaterialSamplerTextureAsset(asset.header))
      .map((asset) => ({
        guid: asset.header.guid,
        name: asset.header.name,
        type: asset.header.type,
        path: asset.path,
      }));
  }, [assetRegistry, registryEpoch, pickOpen, isTextureNode]);
  if (!node) return null;
  const edit = documentBatch(document, commit);
  const setProperties = (properties: Record<string, unknown>) =>
    setMaterialNodeProperties(edit, node.id, properties);
  const rows = materialNodeRows(node, edit, editing.functions);

  return (
    <div className="flex flex-col gap-2" data-testid="material-node-details">
      <p className="px-3 text-xs text-muted-foreground">{materialNodeDefinition(node.type)?.title ?? node.type}</p>
      {rows.length > 0 ? <PropertyGrid rows={rows} /> : null}
      {node.type === "color.gradient" ? <div className="px-3"><EntryListEditor
        title="Gradient Stops" items={materialGradientStops(node.properties.stops)}
        minItems={2} maxItems={32}
        onCreate={() => ({ position: 0.5, color: [1, 1, 1] as [number, number, number] })}
        onChange={(stops) => setProperties({ stops })}
        renderItem={({ item, onChange }) => <PropertyGrid rows={[
          { id: "position", kind: "number", label: "Position", value: item.position, min: 0, max: 1, onChange: (position) => onChange({ ...item, position }) },
          { id: "color", kind: "color", label: "Color", value: item.color, onChange: (color) => onChange({ ...item, color: [color[0], color[1], color[2]] }) },
        ]} />}
      /></div> : null}
      {node.type === "custom.glsl" ? (
        <MaterialCustomGlsl node={node} setProperties={setProperties} bodyLine={editing.compileDiagnostics.find((diagnostic) => diagnostic.nodeId === node.id)?.line} />
      ) : null}
      {isTextureNode ? (
        <div className="px-3">
          <AssetPickerControl
            value={
              typeof node.properties.textureGuid === "string"
                ? node.properties.textureGuid
                : null
            }
          >
            <Button
              type="button"
              variant="outline"
              className="min-h-[var(--touch-target,44px)] h-auto w-full justify-start"
              onClick={() => setPickOpen(true)}
              data-testid="material-node-texture"
            >
              {selectedPickerIdentity(
                assetRowIdentity(
                  (() => {
                    const guid =
                      typeof node.properties.textureGuid === "string"
                        ? node.properties.textureGuid
                        : "";
                    const asset = assetRegistry?.getByGuid(guid);
                    return asset
                      ? { name: asset.header.name, type: asset.header.type }
                      : undefined;
                  })(),
                ),
                "Pick Texture",
              )}
            </Button>
          </AssetPickerControl>
          <AssetPicker
            open={pickOpen}
            onOpenChange={setPickOpen}
            assets={textureAssets}
            allowedTypes={["Texture", "RenderTargetTexture"]}
            title="Pick Texture"
            allowNone
            onPick={(guid) => {
              setProperties({ textureGuid: guid ?? null });
              setPickOpen(false);
            }}
            data-testid="material-node-texture-picker"
          />
        </div>
      ) : null}
      {node.type === "function.call" ? (
        <MaterialFunctionPicker node={node.id} document={document} commit={commit} />
      ) : null}
      {node.type === MATERIAL_GLOBAL_PARAMETER_NODE_TYPE ? (
        <GlobalParameterNodePicker
          collectionGuid={typeof node.properties.collectionGuid === "string" ? node.properties.collectionGuid : ""}
          parameterId={typeof node.properties.parameterId === "string" ? node.properties.parameterId : ""}
          onChange={(collectionGuid, parameter) => commit(selectMaterialGlobalParameter(document, node.id, collectionGuid, parameter))}
          testId="material-global-parameter"
        />
      ) : null}
    </div>
  );
}

function MaterialFunctionPicker<T extends MaterialGraphDocument>({
  node,
  document,
  commit,
}: {
  node: string;
  document: T;
  commit: (next: T) => void;
}) {
  const { assetRegistry, registryEpoch } = useRegistryState();
  const [open, setOpen] = useState(false);
  const current = document.nodes.find((entry) => entry.id === node);
  const guid =
    typeof current?.properties.functionGuid === "string"
      ? current.properties.functionGuid
      : "";
  const functionAssets = useMemo(() => {
    void registryEpoch; // Registry contents mutate without replacing its instance.
    if (!open) return [];
    return (assetRegistry?.list() ?? [])
      .filter((asset) => asset.header.type === "MaterialFunction")
      .map((asset) => ({
        guid: asset.header.guid,
        name: asset.header.name,
        type: asset.header.type,
        path: asset.path,
      }));
  }, [assetRegistry, registryEpoch, open]);
  return (
    <div className="px-3">
      <AssetPickerControl value={guid}>
        <Button
          type="button"
          variant="outline"
          className="min-h-[var(--touch-target,44px)] h-auto w-full justify-start"
          onClick={() => setOpen(true)}
          data-testid="material-node-function"
        >
          {selectedPickerIdentity(
            assetRowIdentity(
              (() => {
                const asset = assetRegistry?.getByGuid(guid);
                return asset
                  ? { name: asset.header.name, type: asset.header.type }
                  : undefined;
              })(),
            ),
            "Pick Material Function",
          )}
        </Button>
      </AssetPickerControl>
      <AssetPicker
        open={open}
        onOpenChange={setOpen}
        assets={functionAssets}
        allowedTypes={["MaterialFunction"]}
        title="Pick Material Function"
        allowNone
        onPick={(picked) => {
          commit({
            ...document,
            nodes: document.nodes.map((entry) =>
              entry.id === node
                ? {
                    ...entry,
                    properties: { ...entry.properties, functionGuid: picked },
                  }
                : entry,
            ),
            // A different function has a different interface, so stale
            // connections to the old pins are dropped.
            edges: document.edges.filter(
              (edge) => edge.sourceNodeId !== node && edge.targetNodeId !== node,
            ),
          });
          setOpen(false);
        }}
        data-testid="material-node-function-picker"
      />
    </div>
  );
}

function MaterialFunctionDetails() {
  const { document, commit } = useMaterialFunctionDocument();
  const editing = useMaterialEditing();
  const selected = selectedMaterialNodes(document, editing.selectedNodeIds);
  return (
    <PanelFrame className="flex-1" data-testid="material-details-panel">
      {selected.length > 1 ? (
        <MaterialNodesDetails document={document} commit={commit} nodes={selected} />
      ) : selected.length === 1 ? (
        <MaterialNodeDetails
          document={document}
          commit={commit}
          selectedNodeId={selected[0]!.id}
        />
      ) : (
        <div data-testid="material-function-settings">
          <PropertyGrid
            rows={[
              {
                id: "description",
                kind: "text",
                label: "Description",
                value: document.description,
                onChange: (value) => commit({ ...document, description: value }),
              },
            ]}
          />
        </div>
      )}
    </PanelFrame>
  );
}

const MATERIAL_FUNCTION_PIN_TYPES = [
  "float",
  "vec2",
  "vec3",
  "vec4",
] as const;

function toPinRows(pins: readonly MaterialFunctionPin[]): PinListRow[] {
  return pins.map((pin) => ({ id: pin.id, name: pin.name, type: pin.type }));
}

/** Pin ids stay stable across renames so existing call sites keep working. */
function fromPinRows(
  rows: readonly PinListRow[],
  prefix: "in" | "out",
  previous: readonly MaterialFunctionPin[],
): MaterialFunctionPin[] {
  return rows.map((row, index) => ({
    ...previous.find((pin) => pin.id === row.id),
    id: row.id || `${prefix}_${index}`,
    name: row.name,
    type: row.type === "texture" ? "texture" : (MATERIAL_FUNCTION_PIN_TYPES as readonly string[]).includes(
      String(row.type),
    )
      ? (row.type as MaterialFunctionPin["type"])
      : "float",
  }));
}

/** Typed inputs and outputs of a Material Function. */
export function MaterialFunctionInterfacePanel(_props: IDockviewPanelProps) {
  void _props;
  const { document, commit } = useMaterialFunctionDocument();
  const [selectedInput, selectInput] = useState<string | null>(null);
  const [selectedOutput, selectOutput] = useState<string | null>(null);
  const input = document.inputs.find((pin) => pin.id === selectedInput);
  const setDefault = (defaultValue: number[]) => commit({ ...document, inputs: document.inputs.map((pin) => pin.id === selectedInput ? { ...pin, defaultValue } : pin) }, `material-function:input:${selectedInput}:defaultValue`);
  return (
    <PanelFrame
      className="flex-1"
      title="Interface"
      data-testid="material-function-interface-panel"
    >
      <div className="flex flex-col gap-3 p-2">
        <PinListEditor
          title="Inputs"
          rows={toPinRows(document.inputs)}
          selectedId={selectedInput}
          onSelect={selectInput}
          showDefault={false}
          showOptional={false}
          types={MATERIAL_FUNCTION_PIN_TYPES}
          onChange={(rows) =>
            commit({ ...document, inputs: fromPinRows(rows, "in", document.inputs) })
          }
          itemLabel="Input"
          testIdPrefix="material-function-input"
          data-testid="material-function-inputs"
        />
        {input && input.type !== "texture" ? <PropertyGrid rows={input.type === "float" ? [
          { id: "default", kind: "number", label: "Default Value", value: input.defaultValue?.[0] ?? 0, onChange: (value) => setDefault([value]) },
        ] : [
          { id: "default", kind: "vector3", label: "Default Value", axes: ["X", "Y", "Z", "W"].slice(0, Number(input.type.slice(-1))), value: input.type === "vec4" ? [input.defaultValue?.[0] ?? 0, input.defaultValue?.[1] ?? 0, input.defaultValue?.[2] ?? 0, input.defaultValue?.[3] ?? 0] : [input.defaultValue?.[0] ?? 0, input.defaultValue?.[1] ?? 0, input.defaultValue?.[2] ?? 0], onChange: (value) => setDefault(value.slice(0, Number(input.type.slice(-1)))) },
        ]} /> : null}
        <PinListEditor
          title="Outputs"
          rows={toPinRows(document.outputs)}
          selectedId={selectedOutput}
          onSelect={selectOutput}
          showDefault={false}
          showOptional={false}
          types={MATERIAL_FUNCTION_PIN_TYPES}
          onChange={(rows) =>
            commit({ ...document, outputs: fromPinRows(rows, "out", document.outputs) })
          }
          itemLabel="Output"
          testIdPrefix="material-function-output"
          data-testid="material-function-outputs"
        />
      </div>
    </PanelFrame>
  );
}

/**
 * Validation and compile diagnostics. Tapping a row focuses its node; a
 * double-tap or **Open** also brings the graph window forward.
 */
export function MaterialCompilerResultsPanel(props: IDockviewPanelProps) {
  const { documentId } = useDocumentWorkspace();
  const editing = useMaterialEditing();
  const textureExists = useTextureExists();
  const doc = useOpenDocument(documentId);
  const isFunction = doc?.ref.kind === "material-function";
  const revealGraph = useRevealResultWindow(props, primaryDockPanel(isFunction ? "material-function" : "material"));
  const globalParameters = useGlobalParameterCatalog();

  const diagnostics = useMemo(() => {
    const payload = (doc?.content ?? {}) as Record<string, unknown>;
    if (isFunction) {
      return validateMaterialFunctionDocument(
        normalizeMaterialFunctionDocument(payload),
        { functions: editing.functions, textureExists, globalParameters },
      );
    }
    return validateMaterialDocument(normalizeMaterialDocument(payload), {
      functions: editing.functions,
      textureExists,
      warnPostProcessCost: true,
      globalParameters,
    });
  }, [doc?.content, editing.functions, isFunction, textureExists, globalParameters]);

  const rows = [...diagnostics, ...editing.compileDiagnostics];
  const [selectedDiagnostic, setSelectedDiagnostic] = useState<(typeof rows)[number] | null>(null);
  const selected = selectedDiagnostic && rows.some((row) => row.code === selectedDiagnostic.code && row.message === selectedDiagnostic.message && row.nodeId === selectedDiagnostic.nodeId) ? selectedDiagnostic : null;
  const choose = (row: (typeof rows)[number], open: boolean) => {
    setSelectedDiagnostic(row);
    if (row.nodeId) editing.focusNode(row.nodeId);
    revealGraph(open);
  };

  return (
    <PanelFrame className="flex-1" data-testid="material-compiler-results">
      {rows.length === 0 ? (
        <Empty>
          <EmptyTitle>No Issues</EmptyTitle>
          <EmptyDescription>This material compiles cleanly.</EmptyDescription>
        </Empty>
      ) : (
        <ScrollArea className="min-h-0 flex-1 py-1">
          <WindowedList
            itemCount={rows.length}
            rowHeight={WINDOWED_LIST_TOUCH_ROW_HEIGHT}
          >
            {(index) => {
              const row = rows[index]!;
              return (
                <DiagnosticResultRow
                  severity={row.severity}
                  message={row.message}
                  code={row.code}
                  selected={selected !== null && row.code === selected.code && row.message === selected.message && row.nodeId === selected.nodeId}
                  onSelect={() => choose(row, false)}
                  onOpen={() => choose(row, true)}
                  details={nodeDiagnosticDetails(row)}
                  testId={`material-diagnostic-${row.code}`}
                />
              );
            }}
          </WindowedList>
        </ScrollArea>
      )}
      {selected ? <MessageDetails title="Diagnostic Details" message={nodeDiagnosticDetails(selected)} onClose={() => setSelectedDiagnostic(null)} /> : null}
    </PanelFrame>
  );
}

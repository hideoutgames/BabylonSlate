import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { isEditorGraphClass } from "@babylonslate/core";
import {
  AssetPicker, ClassPicker, PropertyGrid, humanizePropertyLabel,
  type AssetPickerEntry, type ClassPickerEntry,
} from "@babylonslate/editor-kit";
import {
  PinDefaultEditorContext, type PinDefaultEditorRenderer, type PinDefaultEditorRequest,
} from "@babylonslate/graph-ui";
import { pinDefaultPropertyKey, type PinType } from "@babylonslate/scripting";
import { useDocuments } from "./document-context";
import { subclassClassEntries } from "../lib/component-property-rows";
import { classParentLookup, filterInspectorPinPickerAssets } from "../lib/content-browser-helpers";
import { assetPickerAllowedTypes, collectEnumMemberNames, pinDefaultPropertyRows } from "../lib/graph-inspector";
import { MATERIAL_DOCUMENT_KINDS, useOpenDocumentsOfKinds } from "../lib/use-open-documents-of-kinds";
import { dataGraphAssetCreateOptions } from "../lib/data-graph";

const ENUM_KINDS = ["enum"] as const;

type IndexedAssets = Parameters<typeof filterInspectorPinPickerAssets>[1];
type MaterialDocuments = Parameters<typeof filterInspectorPinPickerAssets>[2];

export interface GraphPinDefaultCatalogs {
  assets: ReadonlyArray<IndexedAssets[number] & Parameters<typeof subclassClassEntries>[1][number]>;
  pickerAssets: AssetPickerEntry[];
  assetEntries: Array<{ id: string; name: string; type: string }>;
  classEntries: ClassPickerEntry[];
  parentOf: (classId: string) => string | null;
  enumMembers: Record<string, readonly string[]>;
  materialDocuments: MaterialDocuments;
}

const CatalogContext = createContext<GraphPinDefaultCatalogs | null>(null);
/** The owning canvas supplies editor-class access independently of active tabs. */
export const GraphPinDefaultHostContext = createContext(false);

type PickerTarget =
  | { kind: "class"; rowId: string; classId: string; source: string }
  | { kind: "asset"; rowId: string; assetType: string; source: string };

/** Project-backed pin controls share the same rows and pickers as Inspector. */
export function GraphPinDefaultEditor({ request, catalogs, editorGraph: hostEditorGraph = false }: {
  request: PinDefaultEditorRequest;
  catalogs: GraphPinDefaultCatalogs;
  editorGraph?: boolean;
}) {
  const { pin, value, disabled, onChange } = request;
  const [pick, setPick] = useState<PickerTarget | null>(null);
  const type = pin.type as PinType;
  const valueSignature = JSON.stringify([type, value]);
  const activePick = !disabled && pick?.source === valueSignature ? pick : null;
  useEffect(() => {
    if (disabled || (pick && pick.source !== valueSignature)) setPick(null);
  }, [disabled, pick, valueSignature]);
  const rootId = `${request.nodeId}:${pin.id}`;
  const propertyKey = pinDefaultPropertyKey(rootId);
  const rows = pinDefaultPropertyRows(
    [{ pinId: rootId, name: humanizePropertyLabel(pin.name), type, value }],
    (patch) => {
      if (!disabled && Object.hasOwn(patch, propertyKey)) onChange(patch[propertyKey]);
    },
    {
      enumMembers: catalogs.enumMembers,
      classEntries: catalogs.classEntries,
      assetEntries: catalogs.assetEntries,
      onPickClass: (rowId, classId) => { if (!disabled) setPick({ kind: "class", rowId, classId, source: valueSignature }); },
      onPickAsset: (rowId, assetType) => { if (!disabled) setPick({ kind: "asset", rowId, assetType, source: valueSignature }); },
    },
  );
  const controls = rows.map((row) => ({ ...row, id: `${rootId}:${row.id}` }));
  const commitPick = (selected: string | null) => {
    const row = rows.find((entry) => entry.id === activePick?.rowId);
    if (activePick && row?.kind === "asset") row.onChange(selected ?? "");
    setPick(null);
  };
  const parentOf = catalogs.parentOf;
  const classConstraint = activePick?.kind === "class" ? activePick.classId : "BObject";
  const editorGraph = hostEditorGraph || request.nodeData.__editorOnly === true ||
    isEditorGraphClass(classConstraint, parentOf) ||
    isEditorGraphClass(String(request.nodeData.classId ?? ""), parentOf);
  const classes = useMemo(() => activePick?.kind === "class"
    ? subclassClassEntries(activePick.classId, catalogs.assets, { editorGraph }) : [],
  [activePick, catalogs.assets, editorGraph]);
  const assets = useMemo(() => activePick?.kind === "asset"
    ? filterInspectorPinPickerAssets(catalogs.pickerAssets, catalogs.assets, catalogs.materialDocuments, { nodeType: request.nodeType ?? "" }) : [],
  [activePick, catalogs.pickerAssets, catalogs.assets, catalogs.materialDocuments, request.nodeType]);
  const postProcess = request.nodeType === "scene-layer.registerPostProcess" || request.nodeType === "scene-layer.unregisterPostProcess";

  if (type.kind !== "enumRef" && type.kind !== "classRef" && type.kind !== "assetRef") return null;
  return (
    <div className="min-w-24 max-w-(--graph-pin-default-max-width)" data-pin-default={type.kind}>
      <PropertyGrid rows={controls} hideLabels density="compact" orientation="horizontal" readOnly={disabled} />
      <ClassPicker open={activePick?.kind === "class"} onOpenChange={(open) => { if (!open) setPick(null); }}
        classes={classes} createBaseClass={classConstraint} allowNone={false} onPick={commitPick}
        data-testid="graph-pin-class-picker" />
      <AssetPicker open={activePick?.kind === "asset"} onOpenChange={(open) => { if (!open) setPick(null); }}
        assets={assets} allowedTypes={activePick?.kind === "asset"
          ? assetPickerAllowedTypes(activePick.assetType, request.nodeData.typeClassIds) : undefined}
        createOptions={postProcess ? { materialDomain: "postProcess" }
          : dataGraphAssetCreateOptions(request.nodeType ?? "", request.pin.id, request.nodeData)}
        allowNone onPick={commitPick} data-testid="graph-pin-asset-picker" />
    </div>
  );
}

function ProjectPinEditor({ request }: { request: PinDefaultEditorRequest }) {
  const catalogs = useContext(CatalogContext);
  const editorGraph = useContext(GraphPinDefaultHostContext);
  if (!catalogs) return null;
  return <GraphPinDefaultEditor request={request} catalogs={catalogs} editorGraph={editorGraph} />;
}

/** One catalog snapshot serves every graph canvas in the open project. */
export function GraphPinDefaultsProvider({ children }: { children: ReactNode }) {
  const { assetRegistry, registryEpoch } = useDocuments();
  const enumDocuments = useOpenDocumentsOfKinds(ENUM_KINDS);
  const materialDocuments = useOpenDocumentsOfKinds(MATERIAL_DOCUMENT_KINDS);
  const assets = useMemo(() => {
    void registryEpoch;
    return assetRegistry?.list() ?? [];
  }, [assetRegistry, registryEpoch]);
  const catalogs = useMemo<GraphPinDefaultCatalogs>(() => ({
    assets, materialDocuments,
    pickerAssets: assets.map((asset) => ({ guid: asset.header.guid, name: asset.header.name, type: asset.header.type, path: asset.path })),
    assetEntries: assets.map((asset) => ({ id: asset.header.guid, name: asset.header.name, type: asset.header.type })),
    classEntries: subclassClassEntries("BObject", assets, { editorGraph: true }),
    parentOf: classParentLookup(assets),
    enumMembers: collectEnumMemberNames(enumDocuments, assets),
  }), [assets, enumDocuments, materialDocuments]);
  const render = useCallback<PinDefaultEditorRenderer>((request) => {
    const kind = request.pin.type.kind;
    if (kind !== "enumRef" && kind !== "classRef" && kind !== "assetRef") return null;
    return <ProjectPinEditor key={`${request.nodeId}:${request.pin.id}`} request={request} />;
  }, []);
  return <CatalogContext.Provider value={catalogs}>
    <PinDefaultEditorContext.Provider value={render}>{children}</PinDefaultEditorContext.Provider>
  </CatalogContext.Provider>;
}

import { useGlobalParameterCatalog } from "../lib/global-parameter-catalog";
import { useNodeFocus } from "../lib/use-node-focus";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { isParticleEmitterAssetType, particleLibraryEmitterKey } from "@haptic/assets";
import {
  normalizeParticleGraphDocument,
  validateParticleGraphDocument,
  type ParticleGraphDiagnostic,
  type ParticleGraphDocument,
  type ParticleGraphValidationContext,
} from "@haptic/particle-graph";
import {
  useDocumentActions,
  useRegistryState,
  useOpenDocument,
} from "./document-context";
import { isMaterialAssetType, materialDomainsFromAssets } from "../lib/content-browser-helpers";
import {
  MATERIAL_DOCUMENT_KINDS,
  useOpenDocumentsOfKinds,
} from "../lib/use-open-documents-of-kinds";
import { useNodeSelection } from "../lib/node-selection";

/** A preview build problem as `ParticleService` reports it (node-anchored when known). */
export interface ParticleGraphBuildDiagnostic {
  code: string;
  message: string;
  nodeId?: string;
  pinId?: string;
}

export interface ParticleGraphEditingValue {
  documentId: string;
  /** The open document, normalized. */
  document: ParticleGraphDocument;
  commit: (next: ParticleGraphDocument, mergeKey?: string) => void;
  /** Validation of `document`; errors keep the Preview on its last valid build. */
  diagnostics: ParticleGraphDiagnostic[];
  /** Build problems of the Preview's current build; stale reports never appear. */
  buildDiagnostics: ParticleGraphDiagnostic[];
  errorCount: number;
  /**
   * What the Preview builds: `document` while it validates, else the last
   * valid graph this tab rendered, with the current Material; null before
   * any valid graph. Identity only changes with its position-free key
   * (compile key plus Material, `particleLibraryEmitterKey`).
   */
  previewDocument: ParticleGraphDocument | null;
  /** Accepts a Preview build report only when `key` is the current `previewDocument`'s key. */
  reportBuildDiagnostics: (
    key: string,
    diagnostics: readonly ParticleGraphBuildDiagnostic[],
  ) => void;
  /** Every selected node; Details shows the properties they share. */
  selectedNodeIds: readonly string[];
  /** The first selected node. */
  selectedNodeId: string | null;
  setSelectedNodeIds: (nodeIds: readonly string[]) => void;
  setSelectedNodeId: (nodeId: string | null) => void;
  focusedNodeId: string | null;
  /** Changes on every `focusNode`, so the canvas frames the node again. */
  focusRequest: number;
  /** Frames a node on the canvas and shows it in Details. */
  focusNode: (nodeId: string) => void;
}

const ParticleGraphEditingContext =
  createContext<ParticleGraphEditingValue | null>(null);

/* eslint-disable react-refresh/only-export-components -- context module */
export function useParticleGraphEditing(): ParticleGraphEditingValue {
  const value = useContext(ParticleGraphEditingContext);
  if (!value) {
    throw new Error(
      "useParticleGraphEditing must be used inside ParticleGraphEditingProvider",
    );
  }
  return value;
}
/* eslint-enable react-refresh/only-export-components */

/** Validation already explains these, so the build report does not repeat them. */
function buildRows(
  report: readonly ParticleGraphBuildDiagnostic[],
  validation: readonly ParticleGraphDiagnostic[],
): ParticleGraphDiagnostic[] {
  const materialReported = validation.some(
    (row) =>
      row.code === "particle.missingMaterial" ||
      row.code === "particle.materialDomain",
  );
  return report
    .filter(
      (row) =>
        row.code !== "particle.graph_invalid" &&
        !(materialReported && row.code === "particle.missing_material"),
    )
    .map((row) => ({
      code: row.code,
      message: row.message,
      severity: "error" as const,
      ...(row.nodeId ? { nodeId: row.nodeId } : {}),
      ...(row.pinId ? { pinId: row.pinId } : {}),
    }));
}

/**
 * Selection, focus, diagnostics and the Preview's build input for one
 * Particle Graph tab. The Preview only sees a new document when the
 * position-free compile key or the Material changes, so dragging a node
 * never rebuilds it, and a graph with errors keeps showing its last valid
 * build instead of failing.
 */
export function ParticleGraphEditingProvider({
  documentId,
  children,
}: {
  documentId: string;
  children: ReactNode;
}) {
  const { applyAssetDocumentChange } = useDocumentActions();
  const { assetRegistry, registryEpoch } = useRegistryState();
  const open = useOpenDocument(documentId);
  const content = open?.content;
  const documentPath = open?.ref.path;
  const document = useMemo(
    () => normalizeParticleGraphDocument(content ?? {}),
    [content],
  );

  const commit = useCallback(
    (next: ParticleGraphDocument, mergeKey?: string) => {
      void applyAssetDocumentChange(
        documentId,
        next as unknown as Record<string, unknown>,
        mergeKey,
      );
    },
    [applyAssetDocumentChange, documentId],
  );

  // Material domains by guid; an open Material tab's domain wins over its header.
  const materialDocuments = useOpenDocumentsOfKinds(MATERIAL_DOCUMENT_KINDS);
  const validationContext = useMemo<ParticleGraphValidationContext>(() => {
    void registryEpoch; // Registry contents mutate without replacing its instance.
    if (!assetRegistry) return {};
    const assets = assetRegistry.list();
    const materials = new Set(
      assets
        .filter((asset) => isMaterialAssetType(asset.header.type))
        .map((asset) => asset.header.guid),
    );
    const domains = materialDomainsFromAssets(assets, materialDocuments);
    // A Particle Graph's header dependencies on emitter assets are its Spawn Emitters' emitters.
    const emitters = new Map(
      assets
        .filter((asset) => isParticleEmitterAssetType(asset.header.type))
        .map((asset) => [asset.header.guid, asset.header] as const),
    );
    return {
      materialDomain: (guid) =>
        materials.has(guid) ? (domains[guid] ?? "surface") : null,
      spawnEmitter: (guid) => {
        const header = emitters.get(guid);
        if (!header) return null;
        if (header.type !== "ParticleGraph") return { kind: "basic" };
        return { kind: "graph", spawns: (header.dependencies ?? []).filter((dependency) => emitters.has(dependency)) };
      },
      documentGuid: assets.find((asset) => asset.path === documentPath)?.header.guid,
    };
  }, [assetRegistry, materialDocuments, registryEpoch, documentPath]);

  const globalParameters = useGlobalParameterCatalog();
  const diagnostics = useMemo(
    () => validateParticleGraphDocument(document, { ...validationContext, globalParameters }),
    [document, validationContext, globalParameters],
  );
  const errorCount = diagnostics.filter((row) => row.severity === "error").length;
  const valid = errorCount === 0;

  // Committed after render, so an edit that breaks the graph still sees the
  // graph as it was before that edit.
  const lastValidRef = useRef<ParticleGraphDocument | null>(null);
  useEffect(() => {
    if (valid) lastValidRef.current = document;
  }, [document, valid]);

  const previewSource = valid ? document : lastValidRef.current;
  const materialGuid = document.materialGuid;
  const previewCandidate = useMemo(
    () => (previewSource ? { ...previewSource, materialGuid } : null),
    [materialGuid, previewSource],
  );
  // Keying the candidate lowers it; the Preview, its compile key and the service
  // reuse that lowering because they receive this same object.
  const previewKey = useMemo(
    () =>
      previewCandidate
        ? particleLibraryEmitterKey({ kind: "graph", document: previewCandidate })
        : null,
    [previewCandidate],
  );
  const previewDocument = useMemo(
    () => previewCandidate,
    // Keyed on the position-free key: drags and renames keep the same object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [previewKey],
  );

  const previewKeyRef = useRef(previewKey);
  previewKeyRef.current = previewKey;
  const [report, setReport] = useState<{
    key: string;
    diagnostics: readonly ParticleGraphBuildDiagnostic[];
  } | null>(null);
  const reportBuildDiagnostics = useCallback(
    (key: string, reported: readonly ParticleGraphBuildDiagnostic[]) => {
      if (key !== previewKeyRef.current) return;
      setReport({ key, diagnostics: [...reported] });
    },
    [],
  );
  const buildDiagnostics = useMemo(
    () =>
      report && report.key === previewKey
        ? buildRows(report.diagnostics, diagnostics)
        : [],
    [diagnostics, previewKey, report],
  );

  const { selectedNodeIds, selectedNodeId, setSelectedNodeIds, setSelectedNodeId } = useNodeSelection();
  const { focusedNodeId, focusRequest, requestFocus } = useNodeFocus();
  const focusNode = useCallback((nodeId: string) => {
    requestFocus(nodeId);
    setSelectedNodeId(nodeId);
  }, [requestFocus, setSelectedNodeId]);

  const value = useMemo<ParticleGraphEditingValue>(
    () => ({
      documentId,
      document,
      commit,
      diagnostics,
      buildDiagnostics,
      errorCount,
      previewDocument,
      reportBuildDiagnostics,
      selectedNodeIds,
      selectedNodeId,
      setSelectedNodeIds,
      setSelectedNodeId,
      focusedNodeId,
      focusRequest,
      focusNode,
    }),
    [
      buildDiagnostics,
      commit,
      diagnostics,
      document,
      documentId,
      errorCount,
      focusNode,
      focusRequest,
      focusedNodeId,
      previewDocument,
      reportBuildDiagnostics,
      selectedNodeId,
      selectedNodeIds,
      setSelectedNodeId,
      setSelectedNodeIds,
    ],
  );

  return (
    <ParticleGraphEditingContext.Provider value={value}>
      {children}
    </ParticleGraphEditingContext.Provider>
  );
}

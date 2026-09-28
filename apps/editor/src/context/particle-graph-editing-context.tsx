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
import { particleLibraryEmitterKey } from "@babylonslate/assets";
import {
  normalizeParticleGraphDocument,
  validateParticleGraphDocument,
  type ParticleGraphDiagnostic,
  type ParticleGraphDocument,
  type ParticleGraphValidationContext,
} from "@babylonslate/particle-graph";
import { useDocuments } from "./document-context";
import { materialDomainsFromAssets } from "../lib/content-browser-helpers";

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
   * any valid graph. Identity only changes with `previewKey`.
   */
  previewDocument: ParticleGraphDocument | null;
  /** Position-free key of `previewDocument` (compile key plus Material). */
  previewKey: string | null;
  /** Accepts a Preview build report only for the current `previewKey`. */
  reportBuildDiagnostics: (
    key: string,
    diagnostics: readonly ParticleGraphBuildDiagnostic[],
  ) => void;
  selectedNodeId: string | null;
  setSelectedNodeId: (nodeId: string | null) => void;
  focusedNodeId: string | null;
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
  const { openDocuments, assetRegistry, registryVersion, applyAssetDocumentChange } =
    useDocuments();
  const content = openDocuments.find((entry) => entry.id === documentId)?.content;
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
  const validationContext = useMemo<ParticleGraphValidationContext>(() => {
    void registryVersion; // Registry contents mutate without replacing its instance.
    if (!assetRegistry) return {};
    const assets = assetRegistry.list();
    const materials = new Set(
      assets
        .filter((asset) => asset.header.type === "Material")
        .map((asset) => asset.header.guid),
    );
    const domains = materialDomainsFromAssets(assets, openDocuments);
    return {
      materialDomain: (guid) =>
        materials.has(guid) ? (domains[guid] ?? "surface") : null,
    };
  }, [assetRegistry, openDocuments, registryVersion]);

  const diagnostics = useMemo(
    () => validateParticleGraphDocument(document, validationContext),
    [document, validationContext],
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
  const previewKey = useMemo(
    () =>
      previewSource
        ? particleLibraryEmitterKey({
            kind: "graph",
            document: { ...previewSource, materialGuid },
          })
        : null,
    [materialGuid, previewSource],
  );
  const previewDocument = useMemo(
    () => (previewSource ? { ...previewSource, materialGuid } : null),
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

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const focusNode = useCallback((nodeId: string) => {
    setFocusedNodeId(nodeId);
    setSelectedNodeId(nodeId);
  }, []);

  const value = useMemo<ParticleGraphEditingValue>(
    () => ({
      documentId,
      document,
      commit,
      diagnostics,
      buildDiagnostics,
      errorCount,
      previewDocument,
      previewKey,
      reportBuildDiagnostics,
      selectedNodeId,
      setSelectedNodeId,
      focusedNodeId,
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
      focusedNodeId,
      previewDocument,
      previewKey,
      reportBuildDiagnostics,
      selectedNodeId,
    ],
  );

  return (
    <ParticleGraphEditingContext.Provider value={value}>
      {children}
    </ParticleGraphEditingContext.Provider>
  );
}

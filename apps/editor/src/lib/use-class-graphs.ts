import { useMemo } from "react";
import type { SerializedGraph } from "@haptic/core";
import { useRegistryState } from "../context/document-context";
import { classIdForGraphPath } from "../services/script-compiler";
import { collectClassHeaderGraphs, withOpenClassGraphs } from "./logic-graph-document";
import { useOpenDocumentsOfKinds } from "./use-open-documents-of-kinds";

const CLASS_KINDS = ["graph"] as const;

/** Closed Class header graphs by class id, parsed again only when the registry changes. */
export function useClassHeaderGraphs(): Readonly<Record<string, SerializedGraph>> {
  const { assetRegistry, registryEpoch } = useRegistryState();
  return useMemo(() => {
    void registryEpoch;
    return collectClassHeaderGraphs({ assets: assetRegistry?.list() ?? [], classIdForPath: classIdForGraphPath });
  }, [assetRegistry, registryEpoch]);
}

/**
 * Every Class graph by class id (`collectClassGraphsForPalette`): the header
 * graphs with the open Class documents over them. A Class edit lays the open
 * documents over again without parsing any header. Each change is a fresh
 * record, but it is shared by the caller's renders: copy it before adding to it.
 */
export function useClassGraphs(): Readonly<Record<string, SerializedGraph>> {
  const headerGraphs = useClassHeaderGraphs();
  const classDocuments = useOpenDocumentsOfKinds(CLASS_KINDS);
  return useMemo(
    () => withOpenClassGraphs(headerGraphs, classDocuments, classIdForGraphPath),
    [classDocuments, headerGraphs],
  );
}

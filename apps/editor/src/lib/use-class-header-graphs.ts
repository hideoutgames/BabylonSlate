import { useMemo } from "react";
import type { SerializedGraph } from "@haptic/core";
import { useRegistryState } from "../context/document-context";
import { classIdForGraphPath } from "../services/script-compiler";
import { classGraphsFromHeaders } from "./logic-graph-document";

/**
 * Closed Class graphs rebuilt from the registry headers, by class id. They
 * are parsed once per registry change, so a Class edit only overlays the open
 * tabs (`withOpenClassGraphs`) instead of re-reading every header.
 */
export function useClassHeaderGraphs(): Readonly<Record<string, SerializedGraph>> {
  const { assetRegistry, registryEpoch } = useRegistryState();
  return useMemo(() => {
    void registryEpoch; // Registry headers mutate without replacing the registry.
    return classGraphsFromHeaders({ assets: assetRegistry?.list() ?? [], classIdForPath: classIdForGraphPath });
  }, [assetRegistry, registryEpoch]);
}

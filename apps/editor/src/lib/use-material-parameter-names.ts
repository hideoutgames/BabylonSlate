import { useEffect, useMemo, useState } from "react";
import type { SerializedComponent } from "@haptic/core";
import {
  isMaterialParameterNode,
  materialParameterName,
  materialParameterValueType,
  type MaterialParameterValueType,
} from "@haptic/shader-graph";
import { useDocumentActions, useRegistryState } from "../context/document-context";
import { useOpenDocumentsOfKinds } from "./use-open-documents-of-kinds";

const MATERIAL_KINDS = ["material", "material-instance"] as const;
/** How many Material Instance parents to follow to the root Material. */
const MAX_DEPTH = 16;

export type MaterialParameterName = { name: string; type: MaterialParameterValueType };

/** The sorted, unique Materials a Class's (or Prefab's) mesh components draw with. */
export function meshMaterialGuidsOf(owner: { components: readonly SerializedComponent[] } | null | undefined): string[] {
  const guids = new Set<string>();
  for (const component of owner?.components ?? []) {
    if (component.classId !== "MeshComponent" && component.classId !== "DynamicRuntimeMeshComponent") continue;
    const guid = component.properties.materialGuid;
    if (typeof guid === "string" && guid) guids.add(guid);
  }
  return [...guids].sort();
}

/** A Material document's own parameters, with names and value types. */
export function materialParameterNames(document: unknown): MaterialParameterName[] {
  const nodes = document && typeof document === "object" && Array.isArray((document as { nodes?: unknown }).nodes)
    ? (document as { nodes: { type?: unknown; properties?: unknown }[] }).nodes : [];
  return nodes.flatMap((node): MaterialParameterName[] => {
    const type = typeof node.type === "string" && isMaterialParameterNode(node.type) ? materialParameterValueType(node.type) : null;
    const name = type ? materialParameterName({ id: "", type: String(node.type), position: { x: 0, y: 0 },
      properties: (node.properties ?? {}) as Record<string, unknown> }) : "";
    return type && name ? [{ name, type }] : [];
  });
}

/**
 * Each listed Material's parameters, from open tabs first, else loaded from the project. A
 * Material Instance lists its root Material's. A guid is missing until it has loaded.
 */
export function useMaterialParameterNames(materialGuids: readonly string[]): ReadonlyMap<string, readonly MaterialParameterName[]> {
  const { loadAssetDocument } = useDocumentActions();
  const { assetRegistry, registryEpoch } = useRegistryState();
  const openDocuments = useOpenDocumentsOfKinds(MATERIAL_KINDS);
  const [names, setNames] = useState<ReadonlyMap<string, readonly MaterialParameterName[]>>(new Map());
  const key = materialGuids.join(",");
  const guids = useMemo(() => (key ? key.split(",") : []), [key]);

  useEffect(() => {
    void registryEpoch; // Registry contents mutate without replacing its instance.
    let cancelled = false;
    const assets = assetRegistry?.list() ?? [];
    const read = async (guid: string): Promise<unknown> => {
      const asset = assets.find((entry) => entry.header.guid === guid);
      if (!asset) return null;
      const open = openDocuments.find((doc) => doc.ref.path === asset.path)?.content;
      if (open) return open;
      const kind = asset.header.type === "MaterialInstance" ? "material-instance" : "material";
      return (await loadAssetDocument?.(kind, asset.path)) ?? null;
    };
    void Promise.all(guids.map(async (guid): Promise<[string, MaterialParameterName[]]> => {
      let document = await read(guid);
      // A Material Instance takes its parameters from the root Material it derives from.
      for (let depth = 0; depth < MAX_DEPTH && document && typeof document === "object" && "parentGuid" in document; depth += 1) {
        const parent = (document as { parentGuid?: unknown }).parentGuid;
        document = typeof parent === "string" && parent ? await read(parent) : null;
      }
      return [guid, materialParameterNames(document)];
    })).then((entries) => {
      if (!cancelled) setNames(new Map(entries));
    }, () => {
      if (!cancelled) setNames(new Map(guids.map((guid) => [guid, []])));
    });
    return () => { cancelled = true; };
  }, [guids, openDocuments, loadAssetDocument, assetRegistry, registryEpoch]);
  return names;
}

import type { IndexedAsset } from "@babylonslate/assets";
import type { GraphDocument } from "@babylonslate/graph-ui";
import {
  assetDependenciesIncludingOpenDocuments,
  displayAssetTitle,
} from "./content-browser-helpers";

/** Walk the entire connected component, including other users of shared dependencies. */
export function buildAssetReferenceGraph(
  rootGuid: string,
  assets: readonly IndexedAsset[],
  openDocuments: ReadonlyArray<{ ref: { path: string }; content: unknown }>,
): GraphDocument {
  const assetsByGuid = new Map(
    assets.map((asset) => [asset.header.guid, asset]),
  );
  const outbound = assetDependenciesIncludingOpenDocuments(
    assets,
    openDocuments,
  );
  const inbound = new Map<string, string[]>();
  for (const [source, targets] of outbound) {
    for (const target of targets) {
      const sources = inbound.get(target) ?? [];
      sources.push(source);
      inbound.set(target, sources);
    }
  }
  for (const sources of inbound.values()) sources.sort();

  // Signed breadth-first columns put users to the left and dependencies to the
  // right. First visits fix placement, so cycles cannot recurse or move nodes.
  const columns = new Map([[rootGuid, 0]]);
  const queue = [rootGuid];
  for (let index = 0; index < queue.length; index++) {
    const guid = queue[index]!;
    const column = columns.get(guid)!;
    for (const [neighbors, offset] of [
      [outbound.get(guid) ?? [], 1],
      [inbound.get(guid) ?? [], -1],
    ] as const) {
      for (const neighbor of neighbors) {
        if (columns.has(neighbor)) continue;
        columns.set(neighbor, column + offset);
        queue.push(neighbor);
      }
    }
  }
  const rows = new Map<number, string[]>();
  for (const guid of queue) {
    const column = columns.get(guid)!;
    const entries = rows.get(column) ?? [];
    entries.push(guid);
    rows.set(column, entries);
  }
  const nodes: GraphDocument["nodes"] = [];
  for (const [column, guids] of rows) {
    const rootRow =
      column === 0 ? guids.indexOf(rootGuid) : (guids.length - 1) / 2;
    guids.forEach((guid, row) => {
      const asset = assetsByGuid.get(guid);
      const missing = !asset || asset.placeholder === true;
      nodes.push({
        id: guid,
        type: "asset-reference",
        position: { x: column * 280, y: (row - rootRow) * 180 },
        data: {
          title: missing ? guid : displayAssetTitle(asset.header.name),
          assetType: asset?.header.type ?? "Unresolved",
          parentClass: asset?.header.parentClass,
          path: asset?.path ?? guid,
          missing,
        },
      });
    });
  }
  const edges: GraphDocument["edges"] = [];
  for (const source of [...columns.keys()].sort()) {
    for (const target of outbound.get(source) ?? []) {
      edges.push({
        id: JSON.stringify([source, target]),
        source,
        target,
        sourceHandle: "uses",
        targetHandle: "used-by",
      });
    }
  }
  return { nodes, edges };
}

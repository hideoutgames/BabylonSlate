import type { IndexedAsset } from "@babylonslate/assets";
import type { GraphDocument } from "@babylonslate/graph-ui";
import {
  assetDependenciesIncludingOpenDocuments,
  displayAssetTitle,
} from "./content-browser-helpers";

/** Node footprint is 224x48 (`AssetReferenceNode`); gaps leave room for wire fans. */
const COLUMN_GAP = 464;
const ROW_GAP = 64;
const ORDER_SWEEPS = 4;

/**
 * Longest-path layers over the dependency DAG (back edges found by DFS are
 * ignored), shifted so the root sits in column 0. Every non-cyclic wire runs
 * left to right and cycles cannot grow the layout.
 */
function layerColumns(
  component: readonly string[],
  outbound: ReadonlyMap<string, readonly string[]>,
  rootGuid: string,
): Map<string, number> {
  const members = new Set(component);
  const state = new Map<string, "open" | "done">();
  const backEdges = new Set<string>();
  const postorder: string[] = [];
  for (const start of component) {
    if (state.has(start)) continue;
    const stack: Array<{ guid: string; next: number }> = [{ guid: start, next: 0 }];
    state.set(start, "open");
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const targets = (outbound.get(frame.guid) ?? []).filter((target) => members.has(target));
      if (frame.next < targets.length) {
        const target = targets[frame.next++]!;
        const seen = state.get(target);
        if (seen === "open") backEdges.add(JSON.stringify([frame.guid, target]));
        else if (!seen) {
          state.set(target, "open");
          stack.push({ guid: target, next: 0 });
        }
        continue;
      }
      state.set(frame.guid, "done");
      postorder.push(frame.guid);
      stack.pop();
    }
  }
  const layer = new Map(component.map((guid) => [guid, 0]));
  for (const source of postorder.reverse()) {
    for (const target of outbound.get(source) ?? []) {
      if (!members.has(target) || backEdges.has(JSON.stringify([source, target]))) continue;
      layer.set(target, Math.max(layer.get(target)!, layer.get(source)! + 1));
    }
  }
  const offset = layer.get(rootGuid) ?? 0;
  for (const [guid, value] of layer) layer.set(guid, value - offset);
  return layer;
}

/** Barycenter sweeps: each row follows the mean row of its linked neighbours. */
function orderRows(
  columns: ReadonlyMap<string, number>,
  outbound: ReadonlyMap<string, readonly string[]>,
  inbound: ReadonlyMap<string, readonly string[]>,
  visitOrder: readonly string[],
): Map<number, string[]> {
  const byColumn = new Map<number, string[]>();
  for (const guid of visitOrder) {
    const column = columns.get(guid)!;
    const list = byColumn.get(column) ?? [];
    list.push(guid);
    byColumn.set(column, list);
  }
  const sorted = [...byColumn.keys()].sort((a, b) => a - b);
  const rowOf = new Map<string, number>();
  const index = () => {
    for (const column of sorted) {
      byColumn.get(column)!.forEach((guid, row) => {
        const size = byColumn.get(column)!.length;
        rowOf.set(guid, row - (size - 1) / 2);
      });
    }
  };
  index();
  const neighbours = (guid: string) => [
    ...(outbound.get(guid) ?? []),
    ...(inbound.get(guid) ?? []),
  ];
  for (let sweep = 0; sweep < ORDER_SWEEPS; sweep++) {
    const forward = sweep % 2 === 0;
    const pass = forward ? sorted.slice(1) : sorted.slice(0, -1).reverse();
    for (const column of pass) {
      const guids = byColumn.get(column)!;
      const weight = new Map<string, number>();
      guids.forEach((guid, row) => {
        const linked = neighbours(guid).filter((other) => {
          const otherColumn = columns.get(other);
          return otherColumn !== undefined &&
            (forward ? otherColumn < column : otherColumn > column);
        });
        weight.set(
          guid,
          linked.length > 0
            ? linked.reduce((sum, other) => sum + rowOf.get(other)!, 0) / linked.length
            : row - (guids.length - 1) / 2,
        );
      });
      guids.sort((a, b) => weight.get(a)! - weight.get(b)! || rowOf.get(a)! - rowOf.get(b)!);
      index();
    }
  }
  return new Map(sorted.map((column) => [column, byColumn.get(column)!]));
}

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

  // Breadth-first over both directions collects the connected component.
  const visited = new Set([rootGuid]);
  const queue = [rootGuid];
  for (let index = 0; index < queue.length; index++) {
    const guid = queue[index]!;
    for (const neighbors of [outbound.get(guid) ?? [], inbound.get(guid) ?? []]) {
      for (const neighbor of neighbors) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }
  const columns = layerColumns(queue, outbound, rootGuid);
  const order = orderRows(columns, outbound, inbound, queue);
  const nodes: GraphDocument["nodes"] = [];
  for (const [column, guids] of order) {
    guids.forEach((guid, row) => {
      const asset = assetsByGuid.get(guid);
      const missing = !asset || asset.placeholder === true;
      nodes.push({
        id: guid,
        type: "asset-reference",
        position: {
          x: column * COLUMN_GAP,
          y: (row - (guids.length - 1) / 2) * ROW_GAP,
        },
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
      const mutual = source !== target && (outbound.get(target) ?? []).includes(source);
      // A mutual pair is drawn once, along the direction that runs left to right.
      if (mutual) {
        const sourceColumn = columns.get(source)!;
        const targetColumn = columns.get(target)!;
        if (sourceColumn > targetColumn || (sourceColumn === targetColumn && source > target)) continue;
      }
      edges.push({
        id: JSON.stringify([source, target]),
        source,
        target,
        sourceHandle: "uses",
        targetHandle: "used-by",
        ...(source === target
          ? { type: "asset-reference-self" }
          : mutual
            ? { type: "asset-reference-mutual" }
            : {}),
      });
    }
  }
  return { nodes, edges };
}

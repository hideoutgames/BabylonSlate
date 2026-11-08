import { useCallback, useRef } from "react";
import {
  isSceneWorkspaceKind,
  type SerializedActor,
  type SerializedGraph,
  type SerializedScene,
} from "@haptic/core";
import type { IndexedAsset } from "@haptic/assets";
import { useDocumentActions, useRegistryState } from "../context/document-context";
import { FALLBACK_PLACE_POSITION, useSceneEditing } from "../context/scene-editing-context";
import {
  addNewSceneActors,
  nextActorId,
  placementMergeKey,
  prefabComponentsForGuid,
  spawnPlacedActor,
  type PlaceActorItem,
} from "./place-actors";
import { authoredPrefabComponents } from "./prefab-preview";

type Position = readonly [number, number, number];

/** The Class asset whose graph `item` still needs before it can be placed. */
function pendingClassAsset(
  item: PlaceActorItem,
  assets: readonly IndexedAsset[],
): IndexedAsset | undefined {
  const kind = item.kind;
  if (kind.type !== "asset" || kind.assetType !== "Class" || kind.components) return undefined;
  const asset = assets.find((entry) => entry.header.guid === kind.guid);
  return asset?.path ? asset : undefined;
}

/**
 * Places catalog items (Place Actors, the Assets panel) into the open Scene or
 * Scene Layer: one scene change, one undo entry, and the placed actors become
 * the selection. `positions[i]` places `items[i]`. A Class whose Prefab
 * components are not resolved yet waits for its graph and then places into
 * the scene as it is when the load finishes, keeping edits made meanwhile; a
 * second placement during that wait is ignored, since both would claim the
 * same actor ids. `onPlaced` runs after the change with the new actor ids.
 * With the `surfaceNormal` of a placement trace hit, the viewport then rests
 * each actor against that surface through its own position, in the same
 * undo entry.
 */
export function usePlaceActorItems(options: {
  documentId: string;
  scene: SerializedScene | null;
  overlay: boolean;
  graphForPath: (path: string) => SerializedGraph | undefined;
}): (
  items: readonly PlaceActorItem[],
  positions: readonly Position[],
  onPlaced?: (actorIds: string[]) => void,
  surfaceNormal?: readonly [number, number, number] | null,
) => void {
  const { documentId, scene, overlay, graphForPath } = options;
  const { applySceneChange, getOpenDocuments, loadGraphDocument } = useDocumentActions();
  const { assetRegistry } = useRegistryState();
  const { setSelectedActorIds, viewportDropApi } = useSceneEditing();
  const waitingRef = useRef(false);

  return useCallback(
    (items, positions, onPlaced, surfaceNormal) => {
      if (!scene || waitingRef.current || items.length === 0) return;
      const assets = assetRegistry?.list() ?? [];
      // `loaded` is null when no Class waited for its graph.
      const commit = (base: SerializedScene, loaded: ReadonlyMap<string, SerializedGraph> | null) => {
        // Names and ids are unique against the actors placed before each one.
        let next = base;
        const spawned: SerializedActor[] = [];
        const ids: string[] = [];
        const placed: Array<[number, number, number]> = [];
        items.forEach((item, index) => {
          const asset = loaded ? pendingClassAsset(item, assets) : undefined;
          let resolved = item;
          if (loaded && asset && item.kind.type === "asset") {
            const graph = loaded.get(asset.path);
            const components =
              prefabComponentsForGuid(item.kind.guid, {
                assets,
                graphForPath: (path) => {
                  if (path === asset.path && graph) return graph;
                  // Read when the load finishes, not at the pick.
                  const open = getOpenDocuments().find(
                    (entry) => entry.ref.kind === "graph" && entry.ref.path === path,
                  );
                  if (open?.content) return open.content as SerializedGraph;
                  return loaded.get(path) ?? graphForPath(path);
                },
              }) ?? (graph ? authoredPrefabComponents(graph) : item.kind.components);
            resolved = { ...item, kind: { ...item.kind, components } };
          }
          const id = nextActorId(next);
          const position = positions[index] ?? positions[0] ?? FALLBACK_PLACE_POSITION;
          placed.push([position[0], position[1], position[2]]);
          const actor = spawnPlacedActor(next, resolved, id, [position[0], position[1], position[2]], { overlay });
          next = { ...next, actors: [...next.actors, actor] };
          spawned.push(actor);
          ids.push(id);
        });
        const mergeKey = placementMergeKey(ids[0]!);
        void applySceneChange(documentId, addNewSceneActors(base, spawned), { mergeKey });
        if (surfaceNormal) {
          const normal: [number, number, number] = [surfaceNormal[0], surfaceNormal[1], surfaceNormal[2]];
          viewportDropApi.restOnSurface(
            ids.map((actorId, index) => ({ actorId, point: placed[index]!, normal })),
            mergeKey,
          );
        }
        setSelectedActorIds(ids);
        onPlaced?.(ids);
      };
      const paths = [
        ...new Set(items.flatMap((item) => pendingClassAsset(item, assets)?.path ?? [])),
      ];
      if (paths.length === 0) {
        commit(scene, null);
        return;
      }
      waitingRef.current = true;
      void Promise.all(paths.map(async (path) => [path, await loadGraphDocument(path)] as const))
        .then((entries) => {
          // Place into the Scene as it is when the load finishes.
          const live = getOpenDocuments().find((entry) => entry.id === documentId);
          if (!live || !isSceneWorkspaceKind(live.ref.kind)) return;
          const loaded = new Map<string, SerializedGraph>();
          for (const [path, graph] of entries) if (graph) loaded.set(path, graph);
          commit(live.content as SerializedScene, loaded);
        })
        .finally(() => {
          waitingRef.current = false;
        });
    },
    [
      applySceneChange,
      assetRegistry,
      documentId,
      getOpenDocuments,
      graphForPath,
      loadGraphDocument,
      overlay,
      scene,
      setSelectedActorIds,
      viewportDropApi,
    ],
  );
}

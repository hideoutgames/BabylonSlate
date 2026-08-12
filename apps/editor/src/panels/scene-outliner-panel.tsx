import type { IDockviewPanelProps } from "dockview-react";
import { useCallback, useMemo, useState } from "react";
import {
  ContextMenuOverlay,
  PanelFrame,
  SearchInput,
  TreeView,
  useContextMenu,
  type TreeViewNode,
} from "@babylonslate/editor-kit";
import {
  actorSubtree,
  wouldCreateCycle,
  type SerializedActor,
  type SerializedScene,
} from "@babylonslate/core";
import { Toggle } from "@babylonslate/ui/components/toggle";
import { EyeIcon, EyeOffIcon, LockIcon, PlusIcon, BoxIcon } from "lucide-react";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useSceneEditing } from "../context/scene-editing-context";
import { IconActionButton } from "../components/icon-action-button";
import { PlaceActorsDialog } from "../components/place-actors-dialog";
import {
  nextActorId,
  projectPlaceActors,
  spawnPlacedActor,
  type PlaceActorItem,
} from "../lib/place-actors";

/** Depth-first walk so children follow their parent in the flattened list. */
export function flattenActors(
  scene: SerializedScene,
  options: {
    collapsed: ReadonlySet<string>;
    search: string;
  },
): TreeViewNode[] {
  const needle = options.search.trim().toLowerCase();
  const childrenOf = new Map<string | null, SerializedActor[]>();
  for (const actor of scene.actors) {
    const bucket = childrenOf.get(actor.parentId) ?? [];
    bucket.push(actor);
    childrenOf.set(actor.parentId, bucket);
  }

  if (needle) {
    // Search flattens the hierarchy: matches are what the user is looking for.
    return scene.actors
      .filter((actor) => actor.name.toLowerCase().includes(needle))
      .map((actor) => ({
        id: actor.id,
        label: actor.name,
        depth: 0,
        hasChildren: false,
        expanded: false,
        muted: !actor.visible,
        icon: <BoxIcon />,
      }));
  }

  const rows: TreeViewNode[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const actor of childrenOf.get(parentId) ?? []) {
      const children = childrenOf.get(actor.id) ?? [];
      const expanded = !options.collapsed.has(actor.id);
      rows.push({
        id: actor.id,
        label: actor.name,
        depth,
        hasChildren: children.length > 0,
        expanded,
        muted: !actor.visible,
        icon: <BoxIcon />,
      });
      if (expanded) {
        walk(actor.id, depth + 1);
      }
    }
  };
  walk(null, 0);
  return rows;
}

export function SceneOutlinerPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applySceneChange, assetRegistry } = useDocuments();
  const { selectedActorIds, selectActor, frameActor } = useSceneEditing();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [search, setSearch] = useState("");
  const [menuActorId, setMenuActorId] = useState<string | null>(null);
  const [placeOpen, setPlaceOpen] = useState(false);

  const doc = openDocuments.find((entry) => entry.id === documentId);
  const scene =
    doc?.ref.kind === "scene" ? (doc.content as SerializedScene) : null;

  const nodes = useMemo(
    () => (scene ? flattenActors(scene, { collapsed, search }) : []),
    [collapsed, scene, search],
  );
  const lockedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const actor of scene?.actors ?? []) {
      if (actor.locked) ids.add(actor.id);
    }
    return ids;
  }, [scene]);

  const mutate = useCallback(
    (next: SerializedScene) => {
      void applySceneChange(documentId, next);
    },
    [applySceneChange, documentId],
  );

  const projectItems = useMemo(
    () => projectPlaceActors(assetRegistry?.list() ?? []),
    [assetRegistry],
  );

  const addActor = useCallback(
    (item: PlaceActorItem) => {
      if (!scene) return;
      const id = nextActorId(scene);
      mutate({
        ...scene,
        actors: [...scene.actors, spawnPlacedActor(scene, item, id)],
      });
      selectActor(id);
      setPlaceOpen(false);
    },
    [mutate, scene, selectActor],
  );

  const removeActor = useCallback(
    (actorId: string) => {
      if (!scene) return;
      const doomed = new Set(
        actorSubtree(scene, actorId).map((actor) => actor.id),
      );
      mutate({
        ...scene,
        actors: scene.actors.filter((actor) => !doomed.has(actor.id)),
      });
      selectActor(null);
    },
    [mutate, scene, selectActor],
  );

  const toggleFlag = useCallback(
    (actorId: string, flag: "visible" | "locked") => {
      if (!scene) return;
      mutate({
        ...scene,
        actors: scene.actors.map((actor) =>
          actor.id === actorId ? { ...actor, [flag]: !actor[flag] } : actor,
        ),
      });
    },
    [mutate, scene],
  );

  const reparent = useCallback(
    (dragId: string, targetId: string | null) => {
      if (!scene) return;
      if (targetId && wouldCreateCycle(scene, dragId, targetId)) return;
      mutate({
        ...scene,
        actors: scene.actors.map((actor) =>
          actor.id === dragId ? { ...actor, parentId: targetId } : actor,
        ),
      });
    },
    [mutate, scene],
  );

  const { menu, closeMenu, openMenuAt } = useContextMenu({
    items: [
      {
        id: "duplicate-actor",
        label: "Duplicate",
        onSelect: () => {
          if (!scene || !menuActorId) return;
          const source = scene.actors.find((a) => a.id === menuActorId);
          if (!source) return;
          const id = nextActorId(scene);
          mutate({
            ...scene,
            actors: [
              ...scene.actors,
              { ...structuredClone(source), id, name: `${source.name} Copy` },
            ],
          });
          selectActor(id);
        },
      },
      {
        id: "delete-actor",
        label: "Delete",
        onSelect: () => {
          if (menuActorId) removeActor(menuActorId);
        },
      },
    ],
  });

  return (
    <PanelFrame data-testid="scene-outliner-panel">
      <div className="flex h-full min-h-0 flex-col gap-2 p-2">
        <div className="flex shrink-0 items-center gap-1">
          <SearchInput
            className="min-h-[var(--chrome-row,28px)]"
            placeholder="Search actors"
            aria-label="Search actors"
            value={search}
            onChange={setSearch}
            data-testid="outliner-search"
          />
          <IconActionButton
            label="Add actor"
            onClick={() => setPlaceOpen(true)}
            disabled={!scene}
            data-testid="outliner-add-actor"
          >
            <PlusIcon />
          </IconActionButton>
        </div>
        <div className="min-h-0 flex-1">
          <TreeView
            nodes={nodes.map((node) => ({
              ...node,
              trailing: (
                <>
                  <Toggle
                    variant="default"
                    size="sm"
                    aria-label={`Toggle visibility of ${node.label}`}
                    pressed={!node.muted}
                    onPressedChange={() => toggleFlag(node.id, "visible")}
                    data-testid={`outliner-visibility-${node.id}`}
                  >
                    {node.muted ? <EyeOffIcon /> : <EyeIcon />}
                  </Toggle>
                  <Toggle
                    variant="default"
                    size="sm"
                    aria-label={`Toggle lock of ${node.label}`}
                    pressed={lockedIds.has(node.id)}
                    onPressedChange={() => toggleFlag(node.id, "locked")}
                    data-testid={`outliner-lock-${node.id}`}
                  >
                    <LockIcon />
                  </Toggle>
                </>
              ),
            }))}
            selectedId={selectedActorIds[0] ?? null}
            onSelect={(id) => selectActor(id)}
            onActivate={(id) => frameActor(id)}
            onToggleExpanded={(id) =>
              setCollapsed((current) => {
                const next = new Set(current);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
            onReparent={reparent}
            onContextMenu={(id, x, y) => {
              setMenuActorId(id);
              selectActor(id);
              openMenuAt(x, y);
            }}
            emptyLabel={scene ? "No actors yet" : "Open a scene"}
            data-testid="outliner-tree"
          />
        </div>
      </div>
      <ContextMenuOverlay menu={menu} onClose={closeMenu} />
      <PlaceActorsDialog
        open={placeOpen}
        onOpenChange={setPlaceOpen}
        onSelect={addActor}
        projectItems={projectItems}
      />
    </PanelFrame>
  );
}

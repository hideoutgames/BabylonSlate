import type { IDockviewPanelProps } from "dockview-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { PanelFrame } from "@babylonslate/editor-kit";
import {
  createActor,
  createMeshComponent,
  type SerializedScene,
} from "@babylonslate/core";
import { Badge } from "@babylonslate/ui/components/badge";
import { Button } from "@babylonslate/ui/components/button";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@babylonslate/ui/components/toggle-group";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useSceneEditing } from "../context/scene-editing-context";
import { uniqueAssetTypes } from "../lib/content-browser-helpers";

/** Primitives are always spawnable, even in a project with no imported assets. */
const PRIMITIVES = ["box", "sphere", "cylinder", "plane", "ground"];

function nextActorId(scene: SerializedScene): string {
  let index = scene.actors.length + 1;
  while (scene.actors.some((actor) => actor.id === `actor-${index}`)) {
    index += 1;
  }
  return `actor-${index}`;
}

export function MiniAssetBrowserPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applySceneChange, assetRegistry } = useDocuments();
  const { selectActor } = useSceneEditing();
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const dragRef = useRef<{ pointerId: number; payload: string } | null>(null);

  const doc = openDocuments.find((entry) => entry.id === documentId);
  const scene =
    doc?.ref.kind === "scene" ? (doc.content as SerializedScene) : null;

  const assets = useMemo(() => assetRegistry?.list() ?? [], [assetRegistry]);
  const types = useMemo(() => uniqueAssetTypes(assets), [assets]);
  const visibleAssets = useMemo(
    () =>
      typeFilter
        ? assets.filter((asset) => asset.header.type === typeFilter)
        : assets,
    [assets, typeFilter],
  );

  const spawn = useCallback(
    (meshKind: string, name: string, assetGuid: string | null) => {
      if (!scene) return;
      const id = nextActorId(scene);
      const component = createMeshComponent(`${id}-mesh`, meshKind);
      component.properties.assetGuid = assetGuid;
      applySceneChange(documentId, {
        ...scene,
        actors: [
          ...scene.actors,
          createActor(id, name, { components: [component] }),
        ],
      }).then(
        () => selectActor(id),
        () => {},
      );
    },
    [applySceneChange, documentId, scene, selectActor],
  );

  /** Drag ends inside the viewport panel spawn the actor there. */
  const endDrag = useCallback(
    (event: React.PointerEvent, meshKind: string, name: string, guid: string | null) => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const dropTarget = document.elementFromPoint(
        event.clientX,
        event.clientY,
      );
      if (dropTarget?.closest('[data-testid="viewport-panel"]')) {
        spawn(meshKind, name, guid);
      }
    },
    [spawn],
  );

  return (
    <PanelFrame data-testid="mini-asset-browser-panel">
      <div className="flex flex-col gap-3 p-2">
        <ToggleGroup
          variant="outline"
          size="touch"
          spacing={1}
          className="flex-wrap"
          value={[typeFilter ?? "all"]}
          onValueChange={(value) => {
            const next = value[0];
            setTypeFilter(!next || next === "all" ? null : next);
          }}
          aria-label="Asset type filter"
        >
          <ToggleGroupItem value="all" data-testid="mini-asset-filter-all">
            All
          </ToggleGroupItem>
          {types.map((type) => (
            <ToggleGroupItem
              key={type}
              value={type}
              data-testid={`mini-asset-filter-${type}`}
            >
              {type}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>

        <div className="flex flex-col gap-1">
          <span className="px-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Primitives
          </span>
          <div className="flex flex-wrap gap-1">
            {PRIMITIVES.map((kind) => (
              <Button
                key={kind}
                size="touch"
                variant="outline"
                className="touch-none"
                onPointerDown={(event) => {
                  dragRef.current = {
                    pointerId: event.pointerId,
                    payload: kind,
                  };
                }}
                onPointerUp={(event) => endDrag(event, kind, kind, null)}
                onClick={() => spawn(kind, kind, null)}
                disabled={!scene}
                data-testid={`mini-asset-primitive-${kind}`}
              >
                {kind}
              </Button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <span className="px-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Project assets
          </span>
          {visibleAssets.length === 0 ? (
            <p className="p-2 text-sm text-muted-foreground">
              No assets of this type.
            </p>
          ) : null}
          {visibleAssets.map((asset) => (
            <Button
              key={asset.header.guid}
              size="touch"
              variant="outline"
              className="touch-none justify-between"
              onPointerDown={(event) => {
                dragRef.current = {
                  pointerId: event.pointerId,
                  payload: asset.header.guid,
                };
              }}
              onPointerUp={(event) =>
                endDrag(event, "box", asset.header.name, asset.header.guid)
              }
              onClick={() => spawn("box", asset.header.name, asset.header.guid)}
              disabled={!scene}
              data-testid={`mini-asset-${asset.header.guid}`}
            >
              <span className="truncate">{asset.header.name}</span>
              <Badge variant="secondary">{asset.header.type}</Badge>
            </Button>
          ))}
        </div>
      </div>
    </PanelFrame>
  );
}

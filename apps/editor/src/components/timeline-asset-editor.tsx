import { useMemo, useSyncExternalStore } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { documentId, labelFromPath, normalizeTimelineAsset } from "@haptic/core";
import { TIMELINE_CLIP_BUILT_IN_DISPATCHERS } from "@haptic/object-model";
import { PanelFrame, PropertyGrid, TreeView, pinPickerLabel, useTouchUi, type PropertyRow, type TreeViewNode } from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@haptic/ui/components/empty";
import { FieldDescription } from "@haptic/ui/components/field";
import { FilmIcon, LayersIcon, MapIcon, ZapIcon } from "lucide-react";
import { useDocumentActions, useOpenDocument, useRegistryState } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { projectTimelineClips, timelineAssetClips, type ProjectTimelineClip } from "../lib/timeline-asset-index";
import { requestTimelineClipFocus } from "../lib/timeline-clip-focus";
import { useOpenDocumentsOfKinds } from "../lib/use-open-documents-of-kinds";

const SCENE_KINDS = ["scene", "scene-layer"] as const;

/** The clip each Timeline Asset document shows in Events, by document id. */
const selectedClips = new Map<string, string>();
const selectionListeners = new Set<() => void>();
function selectClip(document: string, key: string): void {
  selectedClips.set(document, key);
  for (const listener of selectionListeners) listener();
}
function useSelectedClip(document: string): string | undefined {
  return useSyncExternalStore(
    (listener) => {
      selectionListeners.add(listener);
      return () => selectionListeners.delete(listener);
    },
    () => selectedClips.get(document),
    () => undefined,
  );
}
const clipKey = (entry: ProjectTimelineClip) => `${entry.documentPath}\u0000${entry.clip.id}`;

/** The open Timeline Asset, its description commit and the clips bound to it, saved or open. */
function useTimelineAsset() {
  const { documentId: id } = useDocumentWorkspace();
  const { applyAssetDocumentChange } = useDocumentActions();
  const doc = useOpenDocument(id);
  const { assetRegistry, registryEpoch } = useRegistryState();
  const sceneDocuments = useOpenDocumentsOfKinds(SCENE_KINDS);
  const asset = normalizeTimelineAsset(doc?.content);
  const guid = doc ? assetRegistry?.getByPath(doc.ref.path)?.header.guid : undefined;
  const clips = useMemo(() => {
    void registryEpoch;
    return guid ? timelineAssetClips(projectTimelineClips(assetRegistry?.list() ?? [], sceneDocuments), guid) : [];
  }, [assetRegistry, guid, registryEpoch, sceneDocuments]);
  const commitDescription = (description: string) => {
    if (description !== asset.description) {
      void applyAssetDocumentChange(id, { ...asset, description }, "timeline-asset:description");
    }
  };
  return { id, asset, clips, commitDescription };
}

/** Timeline Clips window: the Description, and the clips bound to this asset with where each lives. */
export function TimelineAssetClipsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { id, asset, clips, commitDescription } = useTimelineAsset();
  const { openDocument, setActiveDocument, setSceneMode, getOpenDocuments } = useDocumentActions();
  const touch = useTouchUi();
  const selected = useSelectedClip(id) ?? (clips[0] ? clipKey(clips[0]) : undefined);
  const open = async (entry: ProjectTimelineClip) => {
    const target = documentId({ kind: entry.documentKind, path: entry.documentPath });
    requestTimelineClipFocus(target, entry.clip.id);
    if (getOpenDocuments().some((doc) => doc.id === target)) setActiveDocument(target);
    else await openDocument({ kind: entry.documentKind, path: entry.documentPath, label: labelFromPath(entry.documentPath) });
    setSceneMode(target, "timeline");
  };
  const rows: PropertyRow[] = [{
    id: "timeline-asset-description", kind: "text", label: "Description", value: asset.description,
    onChange: () => {}, onCommit: commitDescription,
  }];
  const nodes: TreeViewNode[] = clips.map((entry) => ({
    id: clipKey(entry),
    label: entry.clip.name,
    depth: 0,
    hasChildren: false,
    expanded: false,
    renamable: false,
    draggable: false,
    icon: <FilmIcon className="size-3.5 text-muted-foreground" />,
    trailing: <span className="flex items-center gap-2 text-xs text-muted-foreground">
      {entry.documentKind === "scene" ? <MapIcon className="size-3.5" aria-hidden /> : <LayersIcon className="size-3.5" aria-hidden />}
      <span className="max-w-32 truncate">{entry.documentName}</span>
      <span className="tabular-nums">{entry.clip.length.toFixed(2)} s</span>
      <Button size={touch ? "sm" : "xs"} variant="ghost" onClick={(event) => { event.stopPropagation(); void open(entry); }}
        data-testid={`timeline-asset-open-${entry.clip.id}`}>Open</Button>
    </span>,
  }));
  return <PanelFrame data-testid="timeline-asset-clips-panel">
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
      <PropertyGrid rows={rows} />
      <FieldDescription className="px-2 text-xs">
        Clips bound to this asset. Bind a Scene's or Scene Layer's clip from its Clips window; this list is read from those documents.
      </FieldDescription>
      <div className="min-h-0 flex-1">
        {clips.length ? <TreeView
          aria-label="Timeline Clips"
          data-testid="timeline-asset-clips"
          rowHeight={touch ? 44 : undefined}
          nodes={nodes}
          selectedId={selected ?? null}
          onSelect={(key) => selectClip(id, key)}
        /> : <Empty className="h-full gap-3 p-4" data-testid="timeline-asset-empty">
          <EmptyHeader>
            <EmptyMedia variant="icon"><FilmIcon /></EmptyMedia>
            <EmptyTitle>No Clips</EmptyTitle>
            <EmptyDescription>In a Scene's Timeline mode, right-click a clip in Clips and choose Bind to Timeline Asset.</EmptyDescription>
          </EmptyHeader>
        </Empty>}
      </div>
    </div>
  </PanelFrame>;
}

/** Events window: the Event Dispatchers of the selected clip, its Custom Event Tracks and the built-in ones. */
export function TimelineAssetEventsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { id, clips } = useTimelineAsset();
  const key = useSelectedClip(id);
  const clip = clips.find((entry) => clipKey(entry) === key) ?? clips[0];
  const rows: PropertyRow[] = clip ? [
    ...clip.clip.events.map((event, index): PropertyRow => ({
      id: `timeline-asset-event-${index}`, kind: "text", label: event.name, readOnly: true, onChange: () => {},
      value: event.inputs.length ? event.inputs.map((input) => `${input.name}: ${pinPickerLabel(input.typeId)}`).join(", ") : "No inputs",
    })),
    ...TIMELINE_CLIP_BUILT_IN_DISPATCHERS.map((name): PropertyRow => ({
      id: `timeline-asset-event-${name}`, kind: "text", label: name, value: "Built in", readOnly: true, onChange: () => {},
    })),
  ] : [];
  return <PanelFrame data-testid="timeline-asset-events-panel">
    {clip ? <div className="flex flex-col gap-2 p-2">
      <div className="flex items-center gap-1.5 px-2 text-sm font-medium [&_svg]:size-4"><ZapIcon />{clip.clip.name}</div>
      <PropertyGrid rows={rows} data-testid="timeline-asset-events" />
      <FieldDescription className="px-2 text-xs">Event Dispatchers of the selected clip, from its Custom Event Tracks.</FieldDescription>
    </div> : <Empty className="h-full gap-3 p-4">
      <EmptyHeader>
        <EmptyMedia variant="icon"><ZapIcon /></EmptyMedia>
        <EmptyTitle>No Clip Selected</EmptyTitle>
        <EmptyDescription>Select a clip in Timeline Clips to see its events.</EmptyDescription>
      </EmptyHeader>
    </Empty>}
  </PanelFrame>;
}

import { useEffect, useMemo, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import type { SerializedScene, SerializedTimelineClip } from "@haptic/core";
import {
  ChecklistDialog,
  ContextMenuOverlay,
  NamePromptDialog,
  PanelFrame,
  ToolbarStrip,
  TreeView,
  useContextMenu,
  useTouchUi,
  type ContextMenuItem,
  type TreeViewNode,
  useAssetCreate,
} from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@haptic/ui/components/empty";
import {
  ClipboardPasteIcon,
  CopyIcon,
  CopyPlusIcon,
  FilmIcon,
  FolderSearchIcon,
  Link2Icon,
  Link2OffIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { IconActionButton } from "../components/icon-action-button";
import { useDocumentActions, useOpenDocument, useRegistryState } from "../context/document-context";
import { useProjectSearch } from "../context/project-search-context";
import { bindTimelineClip, projectTimelineClips, timelineAssetClips, timelineBindBlocker } from "../lib/timeline-asset-index";
import { useOpenDocumentsOfKinds } from "../lib/use-open-documents-of-kinds";
import { takeTimelineClipFocus, usePendingTimelineClipFocus } from "../lib/timeline-clip-focus";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useEditorSessionState } from "../context/editor-session-state-context";
import { useKeybindCommand, useKeybindings } from "../context/keybind-context";
import { useSceneTools } from "../context/scene-tools-context";
import { createClip, deleteClip, duplicateClip, pasteClips, renameClip } from "../lib/timeline-clip-edits";

/** The open Scene, or a Scene Layer tab's scene, with the clip the Timeline windows show. */
function useTimelineScene() {
  const { documentId } = useDocumentWorkspace();
  const { applySceneChange } = useDocumentActions();
  const doc = useOpenDocument(documentId);
  const tools = useSceneTools();
  const scene = doc && (doc.ref.kind === "scene" || doc.ref.kind === "scene-layer") ? doc.content as SerializedScene : null;
  const clips = scene?.timelineClips ?? [];
  const clip = clips.find((entry) => entry.id === tools.timelineClipId) ?? null;
  const commit = (next: SerializedScene | null) => {
    if (next) void applySceneChange(documentId, next);
  };
  return { scene, clips, clip, commit, setClipId: tools.setTimelineClipId, documentPath: doc?.ref.path ?? "", documentId };
}

const SCENE_KINDS = ["scene", "scene-layer"] as const;

/** The project's Timeline Assets and the clips each holds, with this document's unsaved clips. */
function useTimelineAssets() {
  const { assetRegistry, registryEpoch } = useRegistryState();
  const sceneDocuments = useOpenDocumentsOfKinds(SCENE_KINDS);
  return useMemo(() => {
    void registryEpoch;
    const assets = assetRegistry?.list() ?? [];
    return {
      timelines: assets.filter((asset) => asset.header.type === "Timeline")
        .map((asset) => ({ guid: asset.header.guid, name: asset.header.name, path: asset.path }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      clips: projectTimelineClips(assets, sceneDocuments),
    };
  }, [assetRegistry, registryEpoch, sceneDocuments]);
}

function clipBadges(clip: SerializedTimelineClip) {
  if (!clip.autoPlay && !clip.timelineAsset) return undefined;
  return <span className="flex items-center gap-1 text-muted-foreground">
    {clip.timelineAsset ? <Link2Icon className="size-3.5" aria-label="Bound to a Timeline Asset" /> : null}
    {clip.autoPlay ? <PlayIcon className="size-3.5 text-green-500" aria-label="Auto Play" /> : null}
  </span>;
}

/** Timeline mode: the document's Timeline Clips. Create, rename, duplicate, copy, paste and delete them here. */
export function TimelineClipsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { scene, clips, clip: selected, commit, setClipId, documentPath, documentId } = useTimelineScene();
  // Timeline Asset › Open asks this document to show one of its clips.
  const focusRequest = usePendingTimelineClipFocus(documentId);
  useEffect(() => {
    if (!focusRequest || !clips.some((entry) => entry.id === focusRequest)) return;
    takeTimelineClipFocus(documentId);
    setClipId(focusRequest);
  }, [clips, documentId, focusRequest, setClipId]);
  const timelineAssets = useTimelineAssets();
  const assetCreate = useAssetCreate();
  const { revealAsset } = useProjectSearch();
  const [bindClipId, setBindClipId] = useState<string | null>(null);
  const [newAssetClipId, setNewAssetClipId] = useState<string | null>(null);
  const [bindError, setBindError] = useState<string | null>(null);
  const session = useEditorSessionState();
  const keybinds = useKeybindings();
  const touch = useTouchUi();
  const listRef = useRef<HTMLDivElement>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  // The clipboard is not reactive; a copy re-renders so Paste enables.
  const [, setClipboardRevision] = useState(0);

  const create = () => {
    if (!scene) return;
    const id = crypto.randomUUID();
    commit(createClip(scene, id));
    setClipId(id);
    setRenamingId(id);
  };
  const duplicate = (id: string) => {
    if (!scene) return;
    const newId = crypto.randomUUID();
    const next = duplicateClip(scene, id, newId);
    commit(next);
    if (next) setClipId(newId);
  };
  const copy = (id: string) => {
    const clip = clips.find((entry) => entry.id === id);
    if (!clip) return;
    session.copyTimelineClips([clip]);
    setClipboardRevision((revision) => revision + 1);
  };
  const canPaste = Boolean(scene) && session.hasCopiedTimelineClips();
  const paste = () => {
    const copied = session.readCopiedTimelineClips();
    if (!scene || copied.length === 0) return;
    const ids = copied.map(() => crypto.randomUUID());
    commit(pasteClips(scene, copied, ids));
    setClipId(ids[ids.length - 1]!);
  };
  const remove = (id: string) => {
    if (!scene) return;
    commit(deleteClip(scene, id));
    if (selected?.id === id) setClipId(null);
  };
  const finishRename = (id: string, name: string | null) => {
    setRenamingId(null);
    if (scene && name !== null) commit(renameClip(scene, id, name));
  };
  const bind = (clipId: string, assetGuid: string | undefined) => {
    if (scene) commit(bindTimelineClip(scene, clipId, assetGuid));
  };
  const createAndBind = async (clipId: string, name: string) => {
    if (!assetCreate) return;
    setBindError(null);
    try {
      // Beside this document, like assets a picker creates for it.
      const guid = await assetCreate.createAsset({ type: "Timeline", name, ownerPath: documentPath });
      bind(clipId, guid);
    } catch (error) {
      setBindError(error instanceof Error ? error.message : String(error));
    }
  };
  const bindClip = clips.find((entry) => entry.id === bindClipId);
  const bindGroups = bindClip ? [{
    id: "timelines",
    label: "Timeline Assets",
    items: timelineAssets.timelines.map((timeline) => {
      const held = timelineAssetClips(timelineAssets.clips, timeline.guid).map((entry) => entry.clip.name);
      return {
        id: timeline.guid,
        label: timeline.name,
        description: held.length ? held.join(", ") : "No clips",
        included: bindClip.timelineAsset === timeline.guid,
        disabledReason: timelineBindBlocker(timelineAssets.clips, timeline.guid, {
          documentPath, clipId: bindClip.id, clipName: bindClip.name,
        }),
        keywords: held.join(" "),
        testId: `timeline-bind-asset-${timeline.guid}`,
      };
    }),
  }] : [];

  const pasteItem = (): ContextMenuItem => ({
    id: "paste-clip", label: "Paste", icon: <ClipboardPasteIcon />, shortcut: keybinds.get("edit.paste")?.[0],
    disabled: !canPaste, testId: "timeline-clip-menu-paste", onSelect: paste,
  });
  const bindingItems = (id: string): ContextMenuItem[] => {
    const bound = clips.find((entry) => entry.id === id)?.timelineAsset;
    const timeline = bound ? timelineAssets.timelines.find((entry) => entry.guid === bound) : undefined;
    return [
      { type: "separator", id: "bind-separator" },
      { id: "bind-clip", label: "Bind to Timeline Asset…", icon: <Link2Icon />, testId: "timeline-clip-menu-bind",
        onSelect: () => setBindClipId(id) },
      { id: "new-and-bind-clip", label: "New Timeline Asset and Bind…", icon: <PlusIcon />, disabled: !assetCreate,
        testId: "timeline-clip-menu-new-bind", onSelect: () => setNewAssetClipId(id) },
      ...(bound ? [
        { id: "unbind-clip", label: "Unbind Timeline Asset", icon: <Link2OffIcon />, testId: "timeline-clip-menu-unbind",
          onSelect: () => bind(id, undefined) },
        { id: "show-timeline", label: "Show Timeline Asset in Content Browser", icon: <FolderSearchIcon />, disabled: !timeline,
          testId: "timeline-clip-menu-show-asset", onSelect: () => { if (timeline) revealAsset(timeline.guid, timeline.path); } },
      ] satisfies ContextMenuItem[] : []),
    ];
  };
  const rowItems = (id: string): ContextMenuItem[] => [
    { id: "rename-clip", label: "Rename", icon: <PencilIcon />, shortcut: keybinds.get("edit.rename")?.[0],
      testId: "timeline-clip-menu-rename", onSelect: () => setRenamingId(id) },
    { id: "duplicate-clip", label: "Duplicate", icon: <CopyPlusIcon />, shortcut: keybinds.get("edit.duplicate")?.[0],
      testId: "timeline-clip-menu-duplicate", onSelect: () => duplicate(id) },
    { id: "copy-clip", label: "Copy", icon: <CopyIcon />, shortcut: keybinds.get("edit.copy")?.[0],
      testId: "timeline-clip-menu-copy", onSelect: () => copy(id) },
    pasteItem(),
    ...bindingItems(id),
    { type: "separator", id: "delete-separator" },
    { id: "delete-clip", label: "Delete", icon: <Trash2Icon />, variant: "destructive", shortcut: keybinds.get("edit.delete")?.[0],
      testId: "timeline-clip-menu-delete", onSelect: () => remove(id) },
  ];
  const { menu, closeMenu, openMenuAt, bind: backgroundMenu } = useContextMenu({ items: () => [pasteItem()] });
  const onBackground = (event: { target: EventTarget | null }) =>
    !(event.target instanceof Element && event.target.closest('[role="treeitem"]'));

  const listKeys = { focusWithinRef: listRef };
  useKeybindCommand("edit.copy", () => { if (selected) copy(selected.id); }, { ...listKeys, enabled: () => Boolean(selected) });
  useKeybindCommand("edit.paste", paste, { ...listKeys, enabled: () => canPaste });
  useKeybindCommand("edit.duplicate", () => { if (selected) duplicate(selected.id); }, { ...listKeys, enabled: () => Boolean(selected) });
  useKeybindCommand("edit.delete", () => { if (selected) remove(selected.id); },
    { ...listKeys, enabled: () => Boolean(selected) && renamingId === null });

  const nodes: TreeViewNode[] = clips.map((clip) => ({
    id: clip.id,
    label: clip.name,
    depth: 0,
    hasChildren: false,
    expanded: false,
    renamable: true,
    draggable: false,
    icon: <FilmIcon className="size-3.5 text-muted-foreground" />,
    trailing: clipBadges(clip),
  }));

  return <PanelFrame>
    <div className="flex min-h-0 flex-1 flex-col" data-testid="timeline-clips-panel">
      <ToolbarStrip data-testid="timeline-clips-toolbar">
        {clips.length
          ? <><span className="flex-1" /><IconActionButton label="New Clip" variant="ghost" disabled={!scene} onClick={create} data-testid="timeline-clips-new">
            <PlusIcon />
          </IconActionButton></>
          : <Button size="sm" variant="ghost" disabled={!scene} onClick={create} data-testid="timeline-clips-new">
            <PlusIcon data-icon="inline-start" />New Clip
          </Button>}
      </ToolbarStrip>
      <div
        ref={listRef}
        className="min-h-0 flex-1"
        onContextMenu={(event) => { if (onBackground(event)) backgroundMenu.onContextMenu(event); }}
        onPointerDown={(event) => { if (onBackground(event)) backgroundMenu.onPointerDown(event); }}
        onPointerMove={backgroundMenu.onPointerMove}
        onPointerUp={backgroundMenu.onPointerUp}
        onPointerCancel={backgroundMenu.onPointerCancel}
      >
        {clips.length ? <TreeView
          aria-label="Timeline Clips"
          data-testid="timeline-clips-list"
          rowHeight={touch ? 44 : undefined}
          nodes={nodes}
          selectedId={selected?.id ?? null}
          onSelect={(id) => setClipId(id)}
          renamingId={renamingId}
          onRenameRequest={setRenamingId}
          onRenameDone={finishRename}
          onContextMenu={(id, x, y) => {
            setClipId(id);
            openMenuAt(x, y, rowItems(id));
          }}
        /> : <Empty className="h-full gap-3 p-4" data-testid="timeline-clips-empty">
          <EmptyHeader>
            <EmptyMedia variant="icon"><FilmIcon /></EmptyMedia>
            <EmptyTitle>No Timeline Clips</EmptyTitle>
            <EmptyDescription>A clip animates this document's actors over time.</EmptyDescription>
          </EmptyHeader>
        </Empty>}
      </div>
      <ContextMenuOverlay menu={menu} onClose={closeMenu} />
      <ChecklistDialog
        open={bindClip !== undefined}
        onOpenChange={(open) => { if (!open) setBindClipId(null); }}
        title="Bind to Timeline Asset"
        description={bindClip ? `Any class can reach ${bindClip.name} through the Timeline Asset it is bound to. A clip belongs to one asset at a time.` : undefined}
        groups={bindGroups}
        selection="single"
        confirmLabel="Bind"
        emptyLabel="No Timeline Assets"
        searchPlaceholder="Search Timeline Assets"
        action={assetCreate ? { label: "New Timeline Asset…", icon: <PlusIcon />, testId: "timeline-bind-new",
          onSelect: () => setNewAssetClipId(bindClipId) } : undefined}
        onConfirm={([guid]) => { if (bindClipId && guid) bind(bindClipId, guid); }}
        data-testid="timeline-bind-dialog"
      />
      <NamePromptDialog
        open={newAssetClipId !== null}
        onOpenChange={(open) => { if (!open) setNewAssetClipId(null); }}
        title="New Timeline Asset and Bind"
        label="Name"
        description="The asset is created beside this document and the clip is bound to it."
        confirmLabel="Create and Bind"
        initialValue={`${clips.find((entry) => entry.id === newAssetClipId)?.name ?? "New"} Timeline`}
        onSubmit={(name) => { if (newAssetClipId) void createAndBind(newAssetClipId, name); }}
        data-testid="timeline-new-asset-dialog"
      />
      {bindError ? <p className="px-2 pb-2 text-xs text-destructive" role="alert" data-testid="timeline-bind-error">{bindError}</p> : null}
    </div>
  </PanelFrame>;
}

export { TimelinePanel } from "./timeline-panel";

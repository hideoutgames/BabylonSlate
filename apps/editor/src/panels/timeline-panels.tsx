import { useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import type { SerializedScene, SerializedTimelineClip } from "@haptic/core";
import {
  ContextMenuOverlay,
  PanelFrame,
  ToolbarStrip,
  TreeView,
  useContextMenu,
  useTouchUi,
  type ContextMenuItem,
  type TreeViewNode,
} from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@haptic/ui/components/empty";
import {
  ClipboardPasteIcon,
  CopyIcon,
  CopyPlusIcon,
  FilmIcon,
  Link2Icon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { IconActionButton } from "../components/icon-action-button";
import { useDocumentActions, useOpenDocument } from "../context/document-context";
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
  return { scene, clips, clip, commit, setClipId: tools.setTimelineClipId };
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
  const { scene, clips, clip: selected, commit, setClipId } = useTimelineScene();
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

  const pasteItem = (): ContextMenuItem => ({
    id: "paste-clip", label: "Paste", icon: <ClipboardPasteIcon />, shortcut: keybinds.get("edit.paste")?.[0],
    disabled: !canPaste, testId: "timeline-clip-menu-paste", onSelect: paste,
  });
  const rowItems = (id: string): ContextMenuItem[] => [
    { id: "rename-clip", label: "Rename", icon: <PencilIcon />, shortcut: keybinds.get("edit.rename")?.[0],
      testId: "timeline-clip-menu-rename", onSelect: () => setRenamingId(id) },
    { id: "duplicate-clip", label: "Duplicate", icon: <CopyPlusIcon />, shortcut: keybinds.get("edit.duplicate")?.[0],
      testId: "timeline-clip-menu-duplicate", onSelect: () => duplicate(id) },
    { id: "copy-clip", label: "Copy", icon: <CopyIcon />, shortcut: keybinds.get("edit.copy")?.[0],
      testId: "timeline-clip-menu-copy", onSelect: () => copy(id) },
    pasteItem(),
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
    </div>
  </PanelFrame>;
}

export { TimelinePanel } from "./timeline-panel";

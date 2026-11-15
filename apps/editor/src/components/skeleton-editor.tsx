import { useMemo, useState } from "react";
import { CrosshairIcon, PlusIcon, Trash2Icon } from "lucide-react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  AssetPicker,
  PanelFrame,
  PropertyGrid,
  TreeView,
  assetRowIdentity,
  type PropertyRow,
  type TreeViewNode,
} from "@haptic/editor-kit";
import {
  isGltfModelBytes,
} from "@haptic/render";
import {
  nextSkeletonSocketName,
  normalizeAnimationPayload,
  normalizeModelPayload,
  normalizeSkeletonPayload,
  quaternionToEulerDegrees,
  skeletonBoneTree,
  type SkeletonBone,
  type SkeletonPayload,
  type SkeletonRestChannel,
  type SkeletonSocket,
} from "@haptic/assets";
import { eulerDegreesToQuaternion, quaternionToEulerDegrees as socketEulerDegrees } from "@haptic/core";
import { Button } from "@haptic/ui/components/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@haptic/ui/components/empty";
import {
  useDocumentActions,
  useOpenDocument,
  useRegistryState,
} from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useOptionalSkeletonEditing } from "../context/skeleton-editing-context";
import { useModelSourceBytes } from "../lib/use-model-source-bytes";
import { ModelSourceReadError } from "./model-editor";
import { SkeletonPreviewCanvas } from "./skeleton-preview-canvas";
import { asRecord } from "../lib/as-record";

export function SkeletonPreviewPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { applyAssetDocumentChange } = useDocumentActions();
  const doc = useOpenDocument(documentId);
  const { assetRegistry } = useRegistryState();
  const content = asRecord(doc?.content);
  const skeleton = normalizeSkeletonPayload(content);
  const source = useModelSourceBytes(
    skeleton.modelGuid ? assetRegistry?.getByGuid(skeleton.modelGuid)?.path : undefined,
  );
  const editing = useOptionalSkeletonEditing();
  // The markers rebuild only when a socket changes.
  const socketsKey = JSON.stringify(skeleton.sockets);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by content
  const sockets = useMemo(() => skeleton.sockets, [socketsKey]);
  return (
    <PanelFrame data-testid="skeleton-preview-panel">
      <SkeletonPreview
        payload={skeleton}
        sourceBytes={source.bytes}
        sourceError={source.error}
        selectedBone={editing?.selectedBone ?? null}
        sockets={sockets}
        selectedSocket={editing?.selectedSocket ?? null}
        onSelectSocket={(name) => {
          if (name || editing?.selectedSocket) editing?.setSelectedSocket(name);
        }}
        onMoveSocket={(name, position) => {
          void applyAssetDocumentChange(documentId, {
            ...content,
            sockets: skeleton.sockets.map((socket) => (socket.name === name ? { ...socket, position } : socket)),
          });
        }}
      />
    </PanelFrame>
  );
}

export function SkeletonDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { applyAssetDocumentChange } = useDocumentActions();
  const { assetRegistry } = useRegistryState();
  const doc = useOpenDocument(documentId);
  const skeletonGuid = doc ? assetRegistry?.getByPath(doc.ref.path)?.header.guid ?? null : null;
  return (
    <PanelFrame data-testid="skeleton-details-panel">
      <SkeletonEditor
        payload={asRecord(doc?.content)}
        skeletonGuid={skeletonGuid}
        onChange={(next, mergeKey) => {
          void applyAssetDocumentChange(documentId, next, mergeKey);
        }}
      />
    </PanelFrame>
  );
}

function SkeletonPreview({
  payload,
  sourceBytes = null,
  sourceError = null,
  selectedBone = null,
  sockets,
  selectedSocket = null,
  onSelectSocket,
  onMoveSocket,
}: {
  payload: SkeletonPayload;
  sourceBytes?: Uint8Array | null;
  /** Why the owning Model source could not be read, shown instead of a mesh. */
  sourceError?: string | null;
  /** The bone drawn highlighted. */
  selectedBone?: string | null;
  sockets: readonly SkeletonSocket[];
  selectedSocket?: string | null;
  onSelectSocket?: (name: string | null) => void;
  onMoveSocket?: (name: string, position: [number, number, number]) => void;
}) {
  if (sourceError) {
    return (
      <div className="flex h-full flex-col p-3" data-testid="skeleton-preview">
        <ModelSourceReadError error={sourceError} />
      </div>
    );
  }
  if (!sourceBytes || !isGltfModelBytes(sourceBytes)) {
    return (
      <div className="flex h-full flex-col p-3" data-testid="skeleton-preview">
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No Mesh</EmptyTitle>
            <EmptyDescription>
              Pick a Preview Model to preview this Skeleton.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }
  return (
    <div className="h-full min-h-0" data-testid="skeleton-preview">
      <SkeletonPreviewCanvas
        sourceBytes={sourceBytes}
        kind={payload.kind}
        selectedBone={selectedBone}
        sockets={sockets}
        selectedSocket={selectedSocket}
        onSelectSocket={onSelectSocket}
        onMoveSocket={onMoveSocket}
      />
    </div>
  );
}

const AXES_DEGREES = "°";
/** Tree row ids of sockets; bone rows use the bone's name. */
const SOCKET_ID_PREFIX = "socket:";
const round = (value: number) => Math.round(value * 1000) / 1000;
const rounded3 = (value: readonly number[]): [number, number, number] => [round(value[0]!), round(value[1]!), round(value[2]!)];

/** A socket's Inspector rows: its name, the bone it follows and its offset from that bone. */
function socketPropertyRows(
  skeleton: SkeletonPayload,
  socket: SkeletonSocket,
  actions: {
    disabled: boolean;
    rename: (name: string) => void;
    nameError: (name: string) => string | undefined;
    patch: (change: Partial<SkeletonSocket>, field?: string) => void;
  },
): PropertyRow[] {
  const known = skeleton.bones.some((bone) => bone.name === socket.bone);
  const boneOptions = skeleton.bones.map((bone) => ({ value: bone.name, label: bone.name }));
  return [
    {
      id: "socket-name",
      kind: "text",
      label: "Name",
      value: socket.name,
      disabled: actions.disabled,
      error: actions.nameError(socket.name),
      onChange: actions.rename,
    },
    {
      id: "socket-bone",
      kind: "enum",
      label: "Bone",
      value: socket.bone,
      verbatim: true,
      options: known ? boneOptions : [{ value: socket.bone, label: socket.bone || "None" }, ...boneOptions],
      disabled: actions.disabled,
      ...(known ? {} : { error: "The Skeleton has no bone of this name." }),
      onChange: (bone) => actions.patch({ bone }),
    },
    {
      id: "socket-position",
      kind: "vector3",
      label: "Position",
      value: rounded3(socket.position),
      defaultValue: [0, 0, 0],
      disabled: actions.disabled,
      onChange: (position) => actions.patch({ position: [position[0], position[1], position[2]] }, "position"),
    },
    {
      id: "socket-rotation",
      kind: "vector3",
      label: "Rotation",
      value: rounded3(socketEulerDegrees(socket.rotation)),
      defaultValue: [0, 0, 0],
      unit: AXES_DEGREES,
      disabled: actions.disabled,
      onChange: (euler) => actions.patch({ rotation: eulerDegreesToQuaternion([euler[0], euler[1], euler[2]]) }, "rotation"),
    },
    {
      id: "socket-scale",
      kind: "vector3",
      label: "Scale",
      value: rounded3(socket.scale),
      defaultValue: [1, 1, 1],
      disabled: actions.disabled,
      onChange: (scale) => actions.patch({ scale: [scale[0], scale[1], scale[2]] }, "scale"),
    },
  ];
}

function SkeletonEditor({
  payload,
  skeletonGuid,
  onChange,
}: {
  payload: Record<string, unknown>;
  /** The open Skeleton's own guid, which its Models name. */
  skeletonGuid: string | null;
  onChange?: (next: Record<string, unknown>, mergeKey?: string) => void;
}) {
  const skeleton = normalizeSkeletonPayload(payload);
  const { assetRegistry } = useRegistryState();
  const editing = useOptionalSkeletonEditing();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const assets = assetRegistry?.list() ?? [];
  const model = assets.find((asset) => asset.header.guid === skeleton.modelGuid);
  // Any Model on this Skeleton can be the preview.
  const models = skeletonGuid
    ? assets.filter((asset) => asset.header.type === "Model" &&
      normalizeModelPayload(asset.header.payload ?? {}).skeletonGuid === skeletonGuid)
    : [];
  const animationCount = skeletonGuid
    ? assets.filter((asset) => asset.header.type === "Animation" &&
      normalizeAnimationPayload(asset.header.payload ?? {}).skeletonGuid === skeletonGuid).length
    : 0;
  const rows: PropertyRow[] = [
    {
      id: "kind",
      kind: "info",
      label: "Kind",
      value: skeleton.kind === "skin" ? "Skin" : "Hierarchy",
    },
    {
      id: "model",
      kind: "asset",
      label: "Preview Model",
      value: skeleton.modelGuid || null,
      placeholder: "None",
      assetTypes: ["Model"],
      disabled: !onChange,
      onPick: () => setModelPickerOpen(true),
      onChange: (guid) => {
        if (guid && models.some((entry) => entry.header.guid === guid)) onChange?.({ ...payload, modelGuid: guid });
      },
      ...assetRowIdentity(
        model ? { name: model.header.name, type: "Model" } : undefined,
      ),
    },
    { id: "models", kind: "info", label: "Models", value: String(models.length) },
    { id: "animations", kind: "info", label: "Animations", value: String(animationCount) },
    { id: "bones", kind: "info", label: "Bones", value: String(skeleton.bones.length) },
  ];
  const selected = skeleton.bones.find((bone) => bone.name === editing?.selectedBone) ?? null;
  const selectedSocket = skeleton.sockets.find((socket) => socket.name === editing?.selectedSocket) ?? null;
  const [renaming, setRenaming] = useState<string | null>(null);
  const writeSockets = (sockets: SkeletonSocket[], mergeKey?: string) => onChange?.({ ...payload, sockets }, mergeKey);
  const patchSocket = (name: string, change: Partial<SkeletonSocket>, field?: string) =>
    writeSockets(
      skeleton.sockets.map((socket) => (socket.name === name ? { ...socket, ...change } : socket)),
      field ? `skeleton:socket:${name}:${field}` : undefined,
    );
  const nameTaken = (name: string, except: string) =>
    name !== except && (skeleton.bones.some((bone) => bone.name === name) || skeleton.sockets.some((socket) => socket.name === name));
  const renameSocket = (from: string, to: string) => {
    const name = to.trim();
    if (!name || nameTaken(name, from)) return;
    writeSockets(skeleton.sockets.map((socket) => (socket.name === from ? { ...socket, name } : socket)));
    editing?.setSelectedSocket(name);
  };
  const addSocket = (bone: string) => {
    const name = nextSkeletonSocketName(skeleton, bone);
    writeSockets([...skeleton.sockets, { name, bone, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }]);
    editing?.setSelectedSocket(name);
  };
  const boneRows: PropertyRow[] = selected
    ? [
        { id: "bone-parent", kind: "info", label: "Parent", value: selected.parent ?? "None" },
        ...restRow(selected, "position", "Rest Position", selected.position),
        ...restRow(selected, "rotation", "Rest Rotation", quaternionToEulerDegrees(selected.rotation), AXES_DEGREES),
        ...restRow(selected, "scale", "Rest Scale", selected.scale),
      ]
    : [];
  const socketRows: PropertyRow[] = selectedSocket ? socketPropertyRows(skeleton, selectedSocket, {
    disabled: !onChange,
    rename: (name) => renameSocket(selectedSocket.name, name),
    nameError: (name) => (nameTaken(name.trim(), selectedSocket.name) ? "A bone or socket already has this name." : undefined),
    patch: (change, field) => patchSocket(selectedSocket.name, change, field),
  }) : [];
  const socketsByBone = new Map<string, SkeletonSocket[]>();
  for (const socket of skeleton.sockets) {
    const list = socketsByBone.get(socket.bone) ?? [];
    list.push(socket);
    socketsByBone.set(socket.bone, list);
  }
  const socketNode = (socket: SkeletonSocket, depth: number): TreeViewNode => ({
    id: `${SOCKET_ID_PREFIX}${socket.name}`,
    label: socket.name,
    depth,
    hasChildren: false,
    expanded: false,
    icon: <CrosshairIcon aria-hidden />,
    renamable: Boolean(onChange),
  });
  const visible: TreeViewNode[] = [];
  let hiddenBelow: number | null = null;
  for (const { bone, depth, hasChildren } of skeletonBoneTree(skeleton.bones)) {
    if (hiddenBelow !== null && depth > hiddenBelow) continue;
    hiddenBelow = null;
    const sockets = socketsByBone.get(bone.name) ?? [];
    const expanded = !collapsed.has(bone.name);
    if ((hasChildren || sockets.length > 0) && !expanded) hiddenBelow = depth;
    visible.push({ id: bone.name, label: bone.name, depth, hasChildren: hasChildren || sockets.length > 0, expanded });
    if (expanded) for (const socket of sockets) visible.push(socketNode(socket, depth + 1));
  }
  // A socket whose bone the Skeleton no longer has lists at the end, so it can be fixed or removed.
  const boneNames = new Set(skeleton.bones.map((bone) => bone.name));
  for (const socket of skeleton.sockets) if (!boneNames.has(socket.bone)) visible.push(socketNode(socket, 0));
  const selectedId = editing?.selectedSocket ? `${SOCKET_ID_PREFIX}${editing.selectedSocket}` : (editing?.selectedBone ?? null);
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="skeleton-editor">
      <PropertyGrid rows={rows} />
      <div className="min-h-0 flex-1 p-2">
        <TreeView
          nodes={visible}
          selectedId={selectedId}
          onSelect={(id) => {
            if (id.startsWith(SOCKET_ID_PREFIX)) {
              const name = id.slice(SOCKET_ID_PREFIX.length);
              editing?.setSelectedSocket(editing.selectedSocket === name ? null : name);
            } else {
              editing?.setSelectedBone(editing.selectedBone === id ? null : id);
            }
          }}
          onToggleExpanded={(id) => setCollapsed((current) => {
            const next = new Set(current);
            if (!next.delete(id)) next.add(id);
            return next;
          })}
          renamingId={renaming}
          onRenameRequest={(id) => {
            if (id.startsWith(SOCKET_ID_PREFIX)) setRenaming(id);
          }}
          onRenameDone={(id, name) => {
            setRenaming(null);
            if (name !== null && id.startsWith(SOCKET_ID_PREFIX)) renameSocket(id.slice(SOCKET_ID_PREFIX.length), name);
          }}
          emptyLabel="No bones"
          data-testid="skeleton-bone-tree"
        />
      </div>
      {boneRows.length > 0 ? (
        <div className="border-t border-border" data-testid="skeleton-bone-details">
          <PropertyGrid rows={boneRows} />
          <div className="flex px-2 py-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!onChange}
              data-testid="skeleton-add-socket"
              onClick={() => selected && addSocket(selected.name)}
            >
              <PlusIcon data-icon="inline-start" aria-hidden />
              Add Socket
            </Button>
          </div>
        </div>
      ) : null}
      {selectedSocket ? (
        <div className="border-t border-border" data-testid="skeleton-socket-details">
          <PropertyGrid rows={socketRows} />
          <div className="flex px-2 py-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!onChange}
              data-testid="skeleton-remove-socket"
              onClick={() => {
                writeSockets(skeleton.sockets.filter((socket) => socket.name !== selectedSocket.name));
                editing?.setSelectedSocket(null);
              }}
            >
              <Trash2Icon data-icon="inline-start" aria-hidden />
              Remove Socket
            </Button>
          </div>
        </div>
      ) : null}
      <AssetPicker
        open={modelPickerOpen}
        onOpenChange={setModelPickerOpen}
        assets={models.map((asset) => ({
          guid: asset.header.guid,
          name: asset.header.name,
          type: asset.header.type,
          path: asset.path,
        }))}
        allowedTypes={["Model"]}
        title="Pick Preview Model"
        allowNone={false}
        onPick={(guid) => {
          setModelPickerOpen(false);
          if (guid) onChange?.({ ...payload, modelGuid: guid });
        }}
        data-testid="skeleton-preview-model-picker"
      />
    </div>
  );
}

/** A read-only rest channel; an animation library's posed channel says so instead of showing a clip's frame. */
function restRow(
  bone: SkeletonBone,
  channel: SkeletonRestChannel,
  label: string,
  value: readonly number[],
  unit?: string,
): PropertyRow[] {
  const id = `bone-${channel}`;
  if (bone.posed?.includes(channel)) return [{ id, kind: "info", label, value: "Unknown" }];
  const rounded = value.map((entry) => Math.round(entry * 1000) / 1000);
  return [{
    id,
    kind: "vector3",
    label,
    value: [rounded[0]!, rounded[1]!, rounded[2]!],
    disabled: true,
    ...(unit ? { unit } : {}),
    onChange: () => {},
  }];
}

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  MIN_TIMELINE_CLIP_LENGTH,
  TIMELINE_CLIP_ASSET_CLIP_ID,
  labelFromPath,
  withTimelineClipOfAsset,
  SCENE_LAYER_EXCLUSIVE_COMPONENT_CLASS_IDS,
  TIMELINE_FRAME_RATES,
  defaultTimelineProxyPreview,
  timelineProxyPreviewAsset,
  isSceneLayerDeniedComponent,
  normalizeTimelineClipAsset,
  uniqueTimelineClipName,
  type SerializedTimelineClipAsset,
  type TimelineFrameRate,
  type TimelineLoopMode,
  type TimelineProxy,
  type TimelineProxyAssetRepresentation,
  type TimelineProxyPreview,
  type TimelineProxyRepresentation,
  type TimelineProxyRepresents,
  type TimelineWhenFinished,
} from "@haptic/core";
import {
  AssetPicker,
  ChecklistDialog,
  PanelFrame,
  PropertyGrid,
  ToolbarStrip,
  TreeView,
  TypeVisualIcon,
  resolveTypeVisual,
  useTouchUi,
  type ChecklistDialogGroup,
  type ColorValue,
  type PropertyRow,
  type TreeViewNode,
} from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";
import { Field, FieldLabel } from "@haptic/ui/components/field";
import { Input } from "@haptic/ui/components/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "@haptic/ui/components/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@haptic/ui/components/empty";
import { BoxIcon, BoxesIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useDocumentActions, useOpenDocument, useRegistryState } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { subclassClassEntries } from "../lib/component-property-rows";
import { useSceneTools } from "../context/scene-tools-context";
import { TimelineClipSourceProvider, useTimelinePropertyContext, type TimelineClipSource } from "../context/use-timeline-clip";
import { timelineProxyScene } from "../lib/timeline-proxy-scene";
import { TimelinePanel } from "../panels/timeline-panel";
import { TimelineInspectorContent } from "../panels/timeline-inspector";

/** The proxy the Inspector shows, per clip asset document. */
const selectedProxies = new Map<string, string>();
const selectionListeners = new Set<() => void>();
/** Selects a proxy of a clip asset document: the Inspector shows it. */
export function selectProxy(document: string, proxyId: string | null): void {
  if (proxyId) selectedProxies.set(document, proxyId);
  else selectedProxies.delete(document);
  for (const listener of selectionListeners) listener();
}
export function useSelectedProxy(document: string): string | undefined {
  return useSyncExternalStore(
    (listener) => {
      selectionListeners.add(listener);
      return () => selectionListeners.delete(listener);
    },
    () => selectedProxies.get(document),
    () => undefined,
  );
}

const LOOP_MODES: ReadonlyArray<{ value: TimelineLoopMode; label: string }> = [
  { value: "once", label: "Once" },
  { value: "loop", label: "Loop" },
  { value: "pingPong", label: "Ping Pong" },
];
const WHEN_FINISHED: ReadonlyArray<{ value: TimelineWhenFinished; label: string }> = [
  { value: "keep", label: "Keep State" },
  { value: "restore", label: "Restore State" },
];
const REPRESENTATION_LABELS: Record<TimelineProxyRepresentation, string> = {
  outline: "Outline", model: "Model", material: "Material", texture: "Texture", class: "Class",
};

const toColor = (hex: string): ColorValue => [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16) / 255) as ColorValue;
const toHex = (color: ColorValue) => `#${color.map((channel) => Math.round(Math.min(1, Math.max(0, channel)) * 255).toString(16).padStart(2, "0")).join("")}`;

/** The open clip asset, whether it is 2D, and its commit. */
export function useTimelineClipAsset() {
  const { documentId: id } = useDocumentWorkspace();
  const { applyAssetDocumentChange } = useDocumentActions();
  const doc = useOpenDocument(id);
  const payload = useMemo(() => normalizeTimelineClipAsset(doc?.content), [doc?.content]);
  const commit = useCallback((next: SerializedTimelineClipAsset, mergeKey: string) =>
    void applyAssetDocumentChange(id, next as unknown as Record<string, unknown>, mergeKey), [applyAssetDocumentChange, id]);
  return { id, doc, payload, twoD: doc?.ref.kind === "timeline-clip-2d", commit };
}

/**
 * The Timeline windows' clip for a clip asset document: its proxies as the
 * actors, its one clip named after the asset, and edits written back to the
 * asset. The document's Timeline tools always show that clip.
 */
export function TimelineClipAssetSource({ children }: { children: ReactNode }) {
  const { doc, payload, twoD, commit } = useTimelineClipAsset();
  const { assetRegistry } = useRegistryState();
  const property = useTimelinePropertyContext();
  const tools = useSceneTools();
  const name = doc ? assetRegistry?.getByPath(doc.ref.path)?.header.name ?? labelFromPath(doc.ref.path) : "";
  const scene = useMemo(() => timelineProxyScene(payload, name, property.graphs, twoD), [name, payload, property.graphs, twoD]);
  const { timelineClipId, setTimelineClipId } = tools;
  useEffect(() => {
    if (timelineClipId !== TIMELINE_CLIP_ASSET_CLIP_ID) setTimelineClipId(TIMELINE_CLIP_ASSET_CLIP_ID);
  }, [setTimelineClipId, timelineClipId]);
  const source = useMemo((): TimelineClipSource => {
    const clip = scene.timelineClips![0]!;
    const commitClip = (next: typeof clip) => commit(withTimelineClipOfAsset(payload, next), "timeline-clip-asset:clip");
    return {
      scene,
      clips: [clip],
      clip,
      commitClip,
      // Scene edits reach a clip asset only through its clip.
      commitScene: (next) => { const edited = next?.timelineClips?.[0]; if (edited) commitClip(edited); },
      proxies: true,
    };
  }, [commit, payload, scene]);
  return <TimelineClipSourceProvider value={source}>{children}</TimelineClipSourceProvider>;
}

/** Timeline window of a clip asset: the Timeline panel over its proxies. */
export function TimelineClipTimelinePanel(props: IDockviewPanelProps) {
  return <TimelineClipAssetSource><TimelinePanel {...props} /></TimelineClipAssetSource>;
}

/** The Classes a new proxy can stand in for: Actor or ActorComponent subclasses, components filtered by 2D or 3D. */
export function timelineProxyClassEntries(
  represents: TimelineProxyRepresents,
  twoD: boolean,
  assets: Parameters<typeof subclassClassEntries>[1],
) {
  const entries = subclassClassEntries(represents === "actor" ? "Actor" : "ActorComponent", assets);
  if (represents === "actor") return entries;
  const overlayOnly = new Set<string>(SCENE_LAYER_EXCLUSIVE_COMPONENT_CLASS_IDS);
  return entries.filter((entry) => (twoD ? !isSceneLayerDeniedComponent(entry.id) : !overlayOnly.has(entry.id)));
}

/** A new proxy for `classId`, named `name` or after its Class (numbered when taken), with the next preview colour. */
export function addTimelineProxy(
  payload: SerializedTimelineClipAsset,
  represents: TimelineProxyRepresents,
  classId: string,
  id: string,
  name?: string,
): SerializedTimelineClipAsset {
  const base = name?.trim() || classId.replace(/Component$/, "") || classId;
  const unique = uniqueTimelineClipName(base, payload.proxies.map((proxy) => proxy.name));
  const proxy: TimelineProxy = { id, name: unique, represents, classId, tracks: [] };
  return {
    ...payload,
    proxies: [...payload.proxies, proxy],
    editorPreview: { proxies: { ...payload.editorPreview?.proxies, [id]: defaultTimelineProxyPreview(payload.proxies.length) } },
  };
}

/** Removes a proxy, its tracks and its preview. */
export function removeTimelineProxy(payload: SerializedTimelineClipAsset, proxyId: string): SerializedTimelineClipAsset {
  const previews = Object.fromEntries(Object.entries(payload.editorPreview?.proxies ?? {}).filter(([id]) => id !== proxyId));
  return { ...payload, proxies: payload.proxies.filter((proxy) => proxy.id !== proxyId), editorPreview: { proxies: previews } };
}

/** Renames a proxy, numbering the name when another proxy has it. */
export function renameTimelineProxy(payload: SerializedTimelineClipAsset, proxyId: string, name: string): SerializedTimelineClipAsset {
  const taken = payload.proxies.filter((proxy) => proxy.id !== proxyId).map((proxy) => proxy.name);
  const next = uniqueTimelineClipName(name, taken);
  return { ...payload, proxies: payload.proxies.map((proxy) => (proxy.id === proxyId ? { ...proxy, name: next } : proxy)) };
}

/** Proxies window: the clip's stand-ins; + adds an Actor or Component proxy. */
export function TimelineClipProxiesPanel(_props: IDockviewPanelProps) {
  void _props;
  const { id, payload, twoD, commit } = useTimelineClipAsset();
  const { assetRegistry, registryEpoch } = useRegistryState();
  const touch = useTouchUi();
  const selected = useSelectedProxy(id);
  const [adding, setAdding] = useState<TimelineProxyRepresents | null>(null);
  // The new proxy's Name; empty names it after its Class.
  const [proxyName, setProxyName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const groups = useMemo((): ChecklistDialogGroup[] => {
    void registryEpoch;
    if (!adding) return [];
    const entries = timelineProxyClassEntries(adding, twoD, assetRegistry?.list() ?? []);
    return ["Engine", "Project"].map((group) => ({
      id: group, label: group,
      items: entries.filter((entry) => entry.group === group).map((entry) => ({
        id: entry.id, label: entry.name, testId: `timeline-proxy-class-${entry.id}`,
        trailing: <TypeVisualIcon visual={resolveTypeVisual({ classId: entry.id, ancestry: entry.ancestry ? [...entry.ancestry] : undefined, family: "class" })} />,
      })),
    }));
  }, [adding, assetRegistry, registryEpoch, twoD]);

  const add = (represents: TimelineProxyRepresents, classId: string) => {
    const proxyId = crypto.randomUUID();
    commit(addTimelineProxy(payload, represents, classId, proxyId, proxyName), `timeline-clip-asset:add-proxy:${proxyId}`);
    selectProxy(id, proxyId);
  };
  const nodes: TreeViewNode[] = payload.proxies.map((proxy) => {
    const color = payload.editorPreview?.proxies[proxy.id]?.color;
    return {
      id: proxy.id,
      label: proxy.name,
      depth: 0,
      hasChildren: false,
      expanded: false,
      renamable: true,
      draggable: false,
      icon: <span className="flex shrink-0 items-center [&_svg]:size-3.5" style={color ? { color } : undefined}>{proxy.represents === "actor" ? <BoxIcon /> : <BoxesIcon />}</span>,
      trailing: <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
        <span>{proxy.represents === "actor" ? "Actor" : "Component"}</span>
        <span className="max-w-28 truncate">{proxy.classId}</span>
        <Button size={touch ? "touch-icon" : "icon-xs"} variant="ghost" aria-label={`Delete ${proxy.name}`} data-testid={`timeline-proxy-delete-${proxy.id}`}
          onClick={(event) => { event.stopPropagation(); commit(removeTimelineProxy(payload, proxy.id), `timeline-clip-asset:remove-proxy:${proxy.id}`); }}>
          <Trash2Icon />
        </Button>
      </span>,
    };
  });

  const addMenu = <DropdownMenu modal={false}>
    <DropdownMenuTrigger render={<Button size="sm" variant="ghost" data-testid="timeline-proxies-add"><PlusIcon data-icon="inline-start" />Proxy</Button>} />
    <DropdownMenuContent align="end">
      <DropdownMenuGroup>
        <DropdownMenuItem onClick={() => { setProxyName(""); setAdding("actor"); }} data-testid="timeline-proxies-add-actor"><BoxIcon />Actor Proxy…</DropdownMenuItem>
        <DropdownMenuItem onClick={() => { setProxyName(""); setAdding("component"); }} data-testid="timeline-proxies-add-component"><BoxesIcon />Component Proxy…</DropdownMenuItem>
      </DropdownMenuGroup>
    </DropdownMenuContent>
  </DropdownMenu>;

  return <PanelFrame>
    <div className="flex min-h-0 flex-1 flex-col" data-testid="timeline-clip-proxies-panel">
      <ToolbarStrip data-testid="timeline-proxies-toolbar"><span className="flex-1" />{addMenu}</ToolbarStrip>
      {payload.proxies.length ? <TreeView
        aria-label="Proxies"
        nodes={nodes}
        selectedId={selected ?? null}
        onSelect={(proxyId) => selectProxy(id, proxyId)}
        renamingId={renamingId}
        onRenameRequest={setRenamingId}
        onRenameDone={(proxyId, name) => {
          setRenamingId(null);
          if (name !== null && name.trim()) commit(renameTimelineProxy(payload, proxyId, name), `timeline-clip-asset:rename-proxy:${proxyId}`);
        }}
        rowHeight={touch ? 44 : undefined}
        data-testid="timeline-proxies-list"
      /> : <Empty className="h-full gap-3 p-4">
        <EmptyHeader>
          <EmptyMedia variant="icon"><BoxIcon /></EmptyMedia>
          <EmptyTitle>No Proxies</EmptyTitle>
          <EmptyDescription>A proxy stands in for an actor or a component. Each instance of the clip binds it to a real one.</EmptyDescription>
        </EmptyHeader>
      </Empty>}
    </div>
    <ChecklistDialog
      open={adding !== null}
      onOpenChange={(open) => { if (!open) setAdding(null); }}
      title={adding === "component" ? "New Component Proxy" : "New Actor Proxy"}
      description={adding === "component"
        ? "Pick the component Class the proxy stands in for. Its properties become the tracks you can add."
        : "Pick the actor Class the proxy stands in for. Its transform, variables and components become the tracks you can add."}
      groups={groups}
      selection="single"
      confirmLabel="Add Proxy"
      searchPlaceholder="Search Classes"
      onConfirm={([classId]) => { if (adding && classId) add(adding, classId); }}
      fields={<Field>
        <FieldLabel htmlFor="timeline-proxy-name">Name</FieldLabel>
        <Input id="timeline-proxy-name" value={proxyName} placeholder="The Class's name" onChange={(event) => setProxyName(event.target.value)}
          className="pointer-coarse:min-h-11" data-testid="timeline-proxy-name" />
      </Field>}
      data-testid="timeline-proxy-class-dialog"
    />
  </PanelFrame>;
}

/** Inspector: the selected proxy's Name and Editor Preview, then the clip's settings and Timeline Asset. */
export function TimelineClipInspectorPanel(_props: IDockviewPanelProps) {
  void _props;
  const { id, payload, twoD, commit } = useTimelineClipAsset();
  const { assetRegistry, registryEpoch } = useRegistryState();
  const [picker, setPicker] = useState<"timeline" | "representation" | null>(null);
  const selectedId = useSelectedProxy(id);
  const proxy = payload.proxies.find((entry) => entry.id === selectedId);
  const preview = proxy ? payload.editorPreview?.proxies[proxy.id] ?? defaultTimelineProxyPreview(0) : undefined;
  const assets = useMemo(() => {
    void registryEpoch;
    return (assetRegistry?.list() ?? []).map((asset) => ({ guid: asset.header.guid, name: asset.header.name, type: asset.header.type, path: asset.path }));
  }, [assetRegistry, registryEpoch]);
  const nameOf = (guid: string | undefined) => (guid ? assets.find((asset) => asset.guid === guid)?.name : undefined);
  const setPreview = (patch: Partial<TimelineProxyPreview>, key: string) => {
    if (!proxy || !preview) return;
    commit({ ...payload, editorPreview: { proxies: { ...payload.editorPreview?.proxies, [proxy.id]: { ...preview, ...patch } } } }, `timeline-clip-asset:preview:${proxy.id}:${key}`);
  };
  // A Model draws only in 3D; a Material or Texture only in 2D.
  const representations = (["outline", twoD ? "material" : "model", ...(twoD ? ["texture" as const] : []), "class"] as TimelineProxyRepresentation[]);
  const representationType = preview?.representation === "model" ? "Model" : preview?.representation === "material" ? "Material" : preview?.representation === "texture" ? "Texture" : undefined;
  const representationAsset = preview ? timelineProxyPreviewAsset(preview) : undefined;
  // Each of Model, Material and Texture keeps its own pick, so switching back shows it again.
  const setRepresentationAsset = (guid: string | null) => {
    if (!preview || !representationType) return;
    const kind = preview.representation as TimelineProxyAssetRepresentation;
    const others = Object.fromEntries(Object.entries(preview.assets ?? {}).filter(([entry]) => entry !== kind));
    const assets: Partial<Record<TimelineProxyAssetRepresentation, string>> = guid ? { ...others, [kind]: guid } : others;
    setPreview({ assets: Object.keys(assets).length ? assets : undefined }, "asset");
  };

  const proxyRows: PropertyRow[] = proxy && preview ? [
    { kind: "text", id: "timeline-proxy-name", label: "Name", value: proxy.name, onChange: () => {},
      onCommit: (name) => { if (name.trim()) commit(renameTimelineProxy(payload, proxy.id, name), `timeline-clip-asset:rename-proxy:${proxy.id}`); } },
    { kind: "text", id: "timeline-proxy-represents", label: "Represents", value: proxy.represents === "actor" ? "Actor" : "Component", disabled: true, onChange: () => {} },
    { kind: "text", id: "timeline-proxy-class", label: "Class", value: proxy.classId, disabled: true, onChange: () => {} },
  ] : [];
  const previewRows: PropertyRow[] = proxy && preview ? [
    { kind: "color", id: "timeline-proxy-color", label: "Color", value: toColor(preview.color), onChange: (color) => setPreview({ color: toHex(color) }, "color") },
    { kind: "enum", id: "timeline-proxy-representation", label: "Representation", value: preview.representation,
      options: representations.map((value) => ({ value, label: REPRESENTATION_LABELS[value] })),
      onChange: (representation) => setPreview({ representation: representation as TimelineProxyRepresentation }, "representation") },
    ...(representationType ? [{
      kind: "asset" as const, id: "timeline-proxy-asset", label: representationType, value: representationAsset ?? null, displayLabel: nameOf(representationAsset),
      displayType: representationType, onPick: () => setPicker("representation"), onChange: (guid: string | null) => setRepresentationAsset(guid),
    }] : []),
    { kind: "vector3", id: "timeline-proxy-location", label: "Location", value: preview.location, onChange: (location) => setPreview({ location: [...location] as [number, number, number] }, "location") },
    { kind: "vector3", id: "timeline-proxy-rotation", label: "Rotation", unit: "°", value: preview.rotation, onChange: (rotation) => setPreview({ rotation: [...rotation] as [number, number, number] }, "rotation") },
    { kind: "vector3", id: "timeline-proxy-scale", label: "Scale", value: preview.scale, onChange: (scale) => setPreview({ scale: [...scale] as [number, number, number] }, "scale") },
    { kind: "enum", id: "timeline-proxy-preview-as", label: "Preview As", value: preview.previewAs,
      options: [{ value: "relative", label: "Relative" }, { value: "absolute", label: "Absolute" }],
      description: "How transform keys show here: as offsets from the preview placement, or as exact values. In Play, each binding chooses.",
      onChange: (previewAs) => setPreview({ previewAs: previewAs === "absolute" ? "absolute" : "relative" }, "preview-as") },
  ] : [];
  const clipRows: PropertyRow[] = [
    { kind: "asset", id: "timeline-clip-asset-timeline", label: "Timeline Asset", value: payload.timelineAsset || null, displayLabel: nameOf(payload.timelineAsset),
      displayType: "Timeline", placeholder: "Required", description: "Scripts reach the clip through this Timeline Asset. You can change it, not clear it.",
      onPick: () => setPicker("timeline"), onChange: (guid) => { if (guid) commit({ ...payload, timelineAsset: guid }, "timeline-clip-asset:timeline"); } },
    { kind: "number", id: "timeline-clip-asset-length", label: "Length", unit: "s", min: MIN_TIMELINE_CLIP_LENGTH, precision: 2, value: payload.length,
      onChange: (length) => commit({ ...payload, length: Math.max(MIN_TIMELINE_CLIP_LENGTH, length) }, "timeline-clip-asset:length") },
    { kind: "enum", id: "timeline-clip-asset-frame-rate", label: "Frame Rate", value: String(payload.frameRate),
      options: TIMELINE_FRAME_RATES.map((rate) => ({ value: String(rate), label: `${rate} fps` })),
      onChange: (rate) => commit({ ...payload, frameRate: Number(rate) as TimelineFrameRate }, "timeline-clip-asset:frame-rate") },
    { kind: "number", id: "timeline-clip-asset-play-rate", label: "Play Rate", min: 0, precision: 2, value: payload.playRate,
      onChange: (playRate) => commit({ ...payload, playRate: Math.max(0, playRate) }, "timeline-clip-asset:play-rate") },
    { kind: "enum", id: "timeline-clip-asset-loop-mode", label: "Loop Mode", value: payload.loopMode, options: [...LOOP_MODES],
      onChange: (loopMode) => commit({ ...payload, loopMode: loopMode as TimelineLoopMode }, "timeline-clip-asset:loop-mode") },
    { kind: "enum", id: "timeline-clip-asset-when-finished", label: "When Finished", value: payload.whenFinished, options: [...WHEN_FINISHED],
      onChange: (whenFinished) => commit({ ...payload, whenFinished: whenFinished as TimelineWhenFinished }, "timeline-clip-asset:when-finished") },
  ];

  return <PanelFrame data-testid="timeline-clip-inspector">
    <div className="flex flex-col gap-3 pb-4">
      {/* The key, keys or track selected in the Timeline come first, as in a Scene's Timeline mode. */}
      <TimelineClipAssetSource><TimelineInspectorContent showClip={false} /></TimelineClipAssetSource>
      {proxy ? <>
        <PropertyGrid title="Proxy" rows={proxyRows} data-testid="timeline-clip-inspector-proxy" />
        <PropertyGrid title="Editor Preview" rows={previewRows} data-testid="timeline-clip-inspector-preview" />
        <p className="px-2 text-xs text-muted-foreground">Editor Preview never leaves the editor: Play and exports leave it out.</p>
      </> : <p className="px-2 pt-2 text-xs text-muted-foreground">Select a proxy to edit it here.</p>}
      <PropertyGrid title={twoD ? "2D Timeline Clip" : "3D Timeline Clip"} rows={clipRows} data-testid="timeline-clip-inspector-clip" />
    </div>
    <AssetPicker
      open={picker !== null}
      onOpenChange={(open) => { if (!open) setPicker(null); }}
      assets={assets}
      allowedTypes={picker === "timeline" ? ["Timeline"] : representationType ? [representationType] : []}
      allowNone={picker === "representation"}
      title={picker === "timeline" ? "Choose Timeline Asset" : `Choose ${representationType ?? "Asset"}`}
      onPick={(guid) => {
        if (picker === "timeline" && guid) commit({ ...payload, timelineAsset: guid }, "timeline-clip-asset:timeline");
        if (picker === "representation") setRepresentationAsset(guid);
        setPicker(null);
      }}
    />
  </PanelFrame>;
}

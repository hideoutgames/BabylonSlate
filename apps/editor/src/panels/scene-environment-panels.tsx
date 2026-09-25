import { useState, type ReactNode } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { createActor, identitySerializedTransform, parseFoliageProperties, parseLandscapeProperties, resizeLandscape, type SerializedScene, type FoliageGroup, type SerializedComponent } from "@babylonslate/core";
import { AssetPicker, PanelFrame, PropertyGrid, PropertySectionTitle, ToolbarStrip, TreeView, TypeVisualIcon, resolveTypeVisual, type PropertyRow } from "@babylonslate/editor-kit";
import { Alert, AlertDescription } from "@babylonslate/ui/components/alert";
import { Badge } from "@babylonslate/ui/components/badge";
import { Button } from "@babylonslate/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@babylonslate/ui/components/empty";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@babylonslate/ui/components/select";
import { MountainIcon, PlusIcon, ScanIcon, Trash2Icon, TreesIcon } from "lucide-react";
import { IconActionButton } from "../components/icon-action-button";
import { LANDSCAPE_TOOL_LABELS, FOLIAGE_TOOL_LABELS } from "../lib/scene-brush-tools";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useSceneEditing } from "../context/scene-editing-context";
import { useSceneTools } from "../context/scene-tools-context";
import { materialDomainsFromAssets } from "../lib/content-browser-helpers";
import { useCoarsePointer } from "../shell/use-platform-layout";

const NEW_LANDSCAPE_SIZE = 64;
const NEW_LANDSCAPE_CELLS = 64;
const MODEL_VISUAL = resolveTypeVisual({ assetType: "Model" });

function useEnvironmentScene() {
  const { documentId } = useDocumentWorkspace();
  const documents = useDocuments();
  const doc = documents.openDocuments.find((entry) => entry.id === documentId);
  const scene = doc?.ref.kind === "scene" ? doc.content as SerializedScene : null;
  return { scene, documentId, ...documents, commit: (next: SerializedScene) => documents.applySceneChange(documentId, next) };
}

function environmentEntries(scene: SerializedScene | null, classId: string) {
  return scene?.actors.flatMap((actor) => actor.components.filter((c) => c.classId === classId).map((component) => ({ actor, component, id: `${actor.id}/${component.id}` }))) ?? [];
}

function formatUnits(value: number) {
  return String(Number(value.toFixed(2)));
}

function foliageInstanceCount(component: SerializedComponent) {
  return parseFoliageProperties(component.properties).batches.reduce((sum, batch) => sum + batch.transforms.length, 0);
}

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function EnvironmentEmpty({ icon, title, children, testId }: { icon: ReactNode; title: string; children: ReactNode; testId?: string }) {
  return <Empty className="flex-1 gap-3 p-4" data-testid={testId}>
    <EmptyHeader>
      <EmptyMedia variant="icon">{icon}</EmptyMedia>
      <EmptyTitle>{title}</EmptyTitle>
      <EmptyDescription>{children}</EmptyDescription>
    </EmptyHeader>
  </Empty>;
}

function ToolBadge({ label, testId }: { label: string; testId: string }) {
  return <Badge variant="secondary" className="font-normal" data-testid={testId}>{label}</Badge>;
}

export function LandscapeOutlinerPanel(_props: IDockviewPanelProps) { void _props; return <EnvironmentOutliner classId="LandscapeComponent" />; }
export function FoliageOutlinerPanel(_props: IDockviewPanelProps) { void _props; return <EnvironmentOutliner classId="FoliageComponent" />; }

function EnvironmentOutliner({ classId }: { classId: string }) {
  const coarsePointer = useCoarsePointer();
  const { scene, commit } = useEnvironmentScene();
  const { selectedActorIds, selectActor, frameActor } = useSceneEditing();
  const { landscapeSelection, setLandscapeSelection } = useSceneTools();
  const entries = environmentEntries(scene, classId);
  const landscape = classId === "LandscapeComponent";
  const selection = entries.find((entry) => landscape ? entry.id === landscapeSelection : selectedActorIds.includes(entry.actor.id));
  const Icon = landscape ? MountainIcon : TreesIcon;
  const summary = (component: SerializedComponent) => {
    if (landscape) {
      const data = parseLandscapeProperties(component.properties);
      return `${data.width} × ${data.depth}`;
    }
    return String(foliageInstanceCount(component));
  };
  const createLandscape = () => {
    if (!scene) return;
    const actor = createActor(crypto.randomUUID(), `Landscape ${entries.length + 1}`, { components: [{ id: crypto.randomUUID(), classId: "LandscapeComponent", transform: identitySerializedTransform(), properties: { ...parseLandscapeProperties({ width: NEW_LANDSCAPE_SIZE, depth: NEW_LANDSCAPE_SIZE, subdivisions: NEW_LANDSCAPE_CELLS }) } }] });
    void commit({ ...scene, actors: [...scene.actors, actor] }).then((ok) => { if (ok) { selectActor(actor.id); setLandscapeSelection(`${actor.id}/${actor.components[0]!.id}`); frameActor(actor.id); } });
  };
  const deleteSelection = () => {
    if (!scene || !selection) return;
    void commit({ ...scene, actors: scene.actors.flatMap((actor) => actor.id !== selection.actor.id ? [actor] : actor.components.length === 1 && !scene.actors.some((child) => child.parentId === actor.id) ? [] : [{ ...actor, components: actor.components.filter((c) => c.id !== selection.component.id) }]) });
  };
  return <PanelFrame className="scene-environment-panel">
    <div className="flex h-full min-h-0 flex-col">
      <ToolbarStrip data-testid={landscape ? "landscape-outliner-toolbar" : "foliage-outliner-toolbar"}>
        {landscape
          ? <Button size="sm" variant="ghost" disabled={!scene} onClick={createLandscape}><PlusIcon data-icon="inline-start" />Create Landscape</Button>
          : <span className="px-1 text-xs text-muted-foreground" data-testid="foliage-outliner-count">{plural(entries.length, "Stroke")}{entries.length ? ` · ${plural(entries.reduce((sum, entry) => sum + foliageInstanceCount(entry.component), 0), "Instance")}` : ""}</span>}
        <span className="flex-1" />
        <IconActionButton label="Frame" variant="ghost" disabled={!selection} onClick={() => { if (selection) frameActor(selection.actor.id); }}><ScanIcon /></IconActionButton>
        <IconActionButton label="Delete Component" variant="ghost" disabled={!selection || selection.actor.locked} onClick={deleteSelection}><Trash2Icon /></IconActionButton>
      </ToolbarStrip>
      {entries.length ? <div className="min-h-0 flex-1 py-1">
        <TreeView aria-label={landscape ? "Landscape Components" : "Foliage Components"}
          rowHeight={coarsePointer ? 44 : undefined}
          nodes={entries.map(({ actor, component, id }) => ({
            id, depth: 0, hasChildren: false, expanded: false, muted: actor.locked || !actor.visible, icon: <Icon />,
            label: `${actor.name}${actor.components.filter((c) => c.classId === classId).length > 1 ? ` · ${component.id}` : ""}`,
            preview: <span className="text-xs text-muted-foreground tabular-nums">{summary(component)}</span>,
          }))}
          selectedId={selection?.id}
          onSelect={(id) => { const entry = entries.find((e) => e.id === id); if (!entry) return; selectActor(entry.actor.id); if (landscape) setLandscapeSelection(id); }}
          onActivate={(id) => { const entry = entries.find((e) => e.id === id); if (entry) frameActor(entry.actor.id); }}
        />
      </div> : <EnvironmentEmpty icon={<Icon />} title={landscape ? "No Landscapes" : "No Foliage"} testId={landscape ? "landscape-outliner-empty" : "foliage-outliner-empty"}>
        {landscape ? "Create a landscape, then pick a sculpt tool in the viewport." : "Pick a Foliage Group, then paint in the viewport."}
      </EnvironmentEmpty>}
    </div>
  </PanelFrame>;
}

export function LandscapeSettingsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { scene, commit, assetRegistry, openDocuments } = useEnvironmentScene();
  const tools = useSceneTools();
  const [materialPicker, setMaterialPicker] = useState(false);
  const selected = environmentEntries(scene, "LandscapeComponent").find((entry) => entry.id === tools.landscapeSelection);
  const data = selected ? parseLandscapeProperties(selected.component.properties) : null;
  const update = (component: SerializedComponent) => {
    if (!scene || !selected || selected.actor.locked) return;
    void commit({ ...scene, actors: scene.actors.map((actor) => actor.id === selected.actor.id ? { ...actor, components: actor.components.map((entry) => entry.id === component.id ? component : entry) } : actor) });
  };
  const setData = (next: typeof data) => { if (selected && next) update({ ...selected.component, properties: { ...next } }); };
  const brush = tools.landscapeBrush;
  const tool = tools.landscapeTool;
  const brushRows: PropertyRow[] = [
    { id: "radius", label: "Radius", kind: "number", value: brush.radius, min: 0.1, max: 512, onChange: (radius) => tools.setLandscapeBrush({ ...brush, radius }) },
    { id: "strength", label: "Strength", kind: "number", value: brush.strength, min: 0.01, max: 10, onChange: (strength) => tools.setLandscapeBrush({ ...brush, strength }) },
    { id: "falloff", label: "Falloff", kind: "slider", value: brush.falloff, min: 0.01, max: 1, step: 0.01, onChange: (falloff) => tools.setLandscapeBrush({ ...brush, falloff }) },
  ];
  if (tool === "flatten") brushRows.push({ id: "height", label: "Flatten Height", kind: "number", value: brush.height, onChange: (height) => tools.setLandscapeBrush({ ...brush, height }) });
  if (tool === "paint") brushRows.push({ id: "layer", label: "Paint Layer", kind: "enum", value: String(brush.layer), options: [0, 1, 2, 3].map((i) => ({ value: String(i), label: `Layer ${i + 1}` })), onChange: (layer) => tools.setLandscapeBrush({ ...brush, layer: Number(layer) }) });
  const domains = materialDomainsFromAssets(assetRegistry?.list() ?? [], openDocuments);
  const materials = (assetRegistry?.list({ type: "Material" }) ?? []).filter((entry) => domains[entry.header.guid] === "landscape").map((entry) => ({ guid: entry.header.guid, name: entry.header.name, path: entry.path, type: entry.header.type }));
  return <PanelFrame className="scene-environment-panel"><div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid="landscape-settings">
    <PropertySectionTitle aside={<ToolBadge label={LANDSCAPE_TOOL_LABELS[tool]} testId="landscape-settings-tool" />}>Brush</PropertySectionTitle>
    <PropertyGrid rows={brushRows} />
    {data && selected ? <PropertyGrid title="Landscape" readOnly={selected.actor.locked} rows={[
      { id: "name", label: "Name", kind: "text", value: selected.actor.name, onChange: (name) => { if (scene) void commit({ ...scene, actors: scene.actors.map((a) => a.id === selected.actor.id ? { ...a, name } : a) }); } },
      { id: "size", label: "Size", kind: "vector3", axes: ["W", "D"], value: [data.width, data.depth, 0], onChange: ([width, depth]) => setData({ ...data, width: Math.min(4096, Math.max(1, width)), depth: Math.min(4096, Math.max(1, depth)) }) },
      { id: "cells", label: "Cells", kind: "number", value: data.subdivisions, min: 4, max: 256, sensitivity: 1, description: `${formatUnits(data.width / data.subdivisions)} × ${formatUnits(data.depth / data.subdivisions)} units per cell`, onChange: (value) => setData(resizeLandscape(data, value)) },
      { id: "material", label: "Landscape Material", kind: "asset", value: data.materialGuid, displayLabel: materials.find((m) => m.guid === data.materialGuid)?.name, displayType: "Material", visual: { assetType: "Material" }, placeholder: "Default", onPick: () => setMaterialPicker(true), onChange: (materialGuid) => setData({ ...data, materialGuid }) },
    ]} /> : <>
      <PropertySectionTitle>Landscape</PropertySectionTitle>
      <p className="px-2 py-3 text-xs text-muted-foreground" data-testid="landscape-settings-empty">Select a landscape in Landscape Outliner to edit its size, cells, and Material.</p>
    </>}
    <AssetPicker open={materialPicker} onOpenChange={setMaterialPicker} assets={materials} allowedTypes={["Material"]} allowNone title="Landscape Material" onPick={(materialGuid) => { if (data) setData({ ...data, materialGuid }); setMaterialPicker(false); }} />
  </div></PanelFrame>;
}

export function FoliageGroupsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { scene, commit, assetRegistry, openDocuments } = useEnvironmentScene();
  const tools = useSceneTools();
  const [picker, setPicker] = useState<"model" | number | null>(null);
  const groups = scene?.settings.foliageGroups ?? [];
  const group = groups.find((entry) => entry.id === tools.groupId);
  const setGroups = (foliageGroups: FoliageGroup[]) => { if (scene) void commit({ ...scene, settings: { ...scene.settings, foliageGroups } }); };
  const update = (next: FoliageGroup) => setGroups(groups.map((entry) => entry.id === next.id ? next : entry));
  const assets = (assetRegistry?.list() ?? []).map((entry) => ({ guid: entry.header.guid, name: entry.header.name, path: entry.path, type: entry.header.type }));
  const domains = materialDomainsFromAssets(assetRegistry?.list() ?? [], openDocuments);
  const surfaceMaterials = new Set((assetRegistry?.list({ type: "Material" }) ?? []).filter((entry) => {
    const domain = domains[entry.header.guid];
    return domain === undefined || domain === "surface";
  }).map((entry) => entry.header.guid));
  const pickerAssets = assets.filter((asset) => picker === "model" ? asset.type === "Model" : surfaceMaterials.has(asset.guid));
  const totalWeight = group?.models.reduce((sum, model) => sum + Math.max(0, model.weight), 0) ?? 0;
  const createGroup = () => {
    const next = { id: crypto.randomUUID(), name: `Foliage Group ${groups.length + 1}`, models: [] };
    setGroups([...groups, next]); tools.setGroupId(next.id);
  };
  const updateModel = (index: number, patch: Partial<FoliageGroup["models"][number]>) => {
    if (group) update({ ...group, models: group.models.map((m, i) => i === index ? { ...m, ...patch } : m) });
  };
  return <PanelFrame className="scene-environment-panel"><div className="flex min-h-0 flex-1 flex-col">
    <ToolbarStrip data-testid="foliage-groups-toolbar">
      {groups.length ? <Select value={tools.groupId ?? ""} items={groups.map((entry) => ({ value: entry.id, label: entry.name }))} onValueChange={(value) => { if (value) tools.setGroupId(value); }}>
        <SelectTrigger size="sm" aria-label="Foliage Group" className="w-0 min-w-0 flex-1" data-testid="foliage-group-select"><SelectValue placeholder="Select Group" /></SelectTrigger>
        <SelectContent><SelectGroup>{groups.map((entry) => <SelectItem key={entry.id} value={entry.id}>{entry.name}</SelectItem>)}</SelectGroup></SelectContent>
      </Select> : null}
      {groups.length
        ? <IconActionButton label="New Group" variant="ghost" disabled={!scene} onClick={createGroup}><PlusIcon /></IconActionButton>
        : <Button size="sm" variant="ghost" disabled={!scene} onClick={createGroup}><PlusIcon data-icon="inline-start" />New Group</Button>}
      {!groups.length && <span className="flex-1" />}
      <IconActionButton label="Delete Group" variant="ghost" disabled={!group} onClick={() => { setGroups(groups.filter((entry) => entry.id !== group?.id)); tools.setGroupId(null); }}><Trash2Icon /></IconActionButton>
    </ToolbarStrip>
    {group ? <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <PropertyGrid title="Group" rows={[{ id: "name", label: "Name", kind: "text", value: group.name, onChange: (name) => update({ ...group, name }) }]} />
      <PropertySectionTitle aside={<Button size="xs" variant="ghost" onClick={() => setPicker("model")}><PlusIcon data-icon="inline-start" />Add Model</Button>}>
        Models <span className="font-normal text-muted-foreground" data-testid="foliage-group-model-count">{group.models.length}</span>
      </PropertySectionTitle>
      {group.models.length ? <ul className="flex flex-col" data-testid="foliage-group-models">
        {group.models.map((model, index) => {
          const name = assets.find((asset) => asset.guid === model.modelGuid)?.name;
          const share = totalWeight > 0 ? Math.round(Math.max(0, model.weight) / totalWeight * 100) : Math.round(100 / group.models.length);
          return <li key={`${model.modelGuid}:${index}`} className="flex flex-col border-b border-border" data-testid={`foliage-model-${index}`}>
            <div className="flex min-w-0 items-center gap-2 px-2 pt-1.5">
              <TypeVisualIcon visual={MODEL_VISUAL} />
              <span className={name ? "min-w-0 flex-1 truncate text-sm" : "min-w-0 flex-1 truncate text-sm text-destructive"} data-testid={`foliage-model-${index}-name`}>{name ?? "Missing Model"}</span>
              {group.models.length > 1 && <span className="text-xs text-muted-foreground tabular-nums" title="Share of placed instances">{share}%</span>}
              <IconActionButton label="Remove Model" variant="ghost" onClick={() => update({ ...group, models: group.models.filter((_, i) => i !== index) })}><Trash2Icon /></IconActionButton>
            </div>
            <PropertyGrid rows={[
              { id: "weight", label: "Weight", kind: "number", value: model.weight, min: 0, max: 100, onChange: (weight) => updateModel(index, { weight }) },
              { id: "scale", label: "Scale Range", kind: "vector3", axes: ["Min", "Max"], value: [model.minScale, model.maxScale, 0], onChange: ([min, max]) => {
                const minScale = Math.min(100, Math.max(0.01, min)); const maxScale = Math.min(100, Math.max(0.01, max));
                updateModel(index, min !== model.minScale ? { minScale, maxScale: Math.max(minScale, maxScale) } : { maxScale, minScale: Math.min(minScale, maxScale) });
              } },
              { id: "material", label: "Material Override", kind: "asset", value: model.materialGuid, displayLabel: assets.find((asset) => asset.guid === model.materialGuid)?.name, displayType: "Material", visual: { assetType: "Material" }, placeholder: "Model Materials", onPick: () => setPicker(index), onChange: (materialGuid) => updateModel(index, { materialGuid }) },
            ]} />
          </li>;
        })}
      </ul> : <p className="px-2 py-3 text-xs text-muted-foreground" data-testid="foliage-group-models-empty">Add Models to scatter with this group. Each instance picks one Model by weight.</p>}
    </div> : <EnvironmentEmpty icon={<TreesIcon />} title={groups.length ? "No Group Selected" : "No Foliage Groups"} testId="foliage-groups-empty">
      {groups.length ? "Pick a group to edit its Models." : "A group lists the Models a foliage stroke scatters."}
    </EnvironmentEmpty>}
    <AssetPicker open={picker !== null} onOpenChange={(open) => { if (!open) setPicker(null); }} title={picker === "model" ? "Add Foliage Model" : "Foliage Material"} assets={pickerAssets} allowedTypes={picker === "model" ? ["Model"] : ["Material"]} allowNone={picker !== "model"} onPick={(guid) => {
      if (!group) return;
      if (picker === "model" && guid && assets.some((asset) => asset.guid === guid && asset.type === "Model")) update({ ...group, models: [...group.models, { modelGuid: guid, materialGuid: null, weight: 1, minScale: 0.8, maxScale: 1.2 }] });
      else if (typeof picker === "number" && (!guid || surfaceMaterials.has(guid))) update({ ...group, models: group.models.map((model, i) => i === picker ? { ...model, materialGuid: guid } : model) });
      setPicker(null);
    }} />
  </div></PanelFrame>;
}

export function FoliageSettingsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { scene } = useEnvironmentScene();
  const { foliageBrush: brush, setFoliageBrush, foliageTool, groupId } = useSceneTools();
  const group = scene?.settings.foliageGroups?.find((entry) => entry.id === groupId);
  const blocked = foliageTool === "paint" && !group?.models.length;
  return <PanelFrame className="scene-environment-panel"><div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid="foliage-settings">
    {blocked && <Alert className="m-2 w-auto" data-testid="foliage-settings-blocked">
      <TreesIcon />
      <AlertDescription>{group ? "Add Models to this Foliage Group to paint." : "Pick a Foliage Group with Models to paint."}</AlertDescription>
    </Alert>}
    <PropertySectionTitle aside={<ToolBadge label={FOLIAGE_TOOL_LABELS[foliageTool]} testId="foliage-settings-tool" />}>Brush</PropertySectionTitle>
    <PropertyGrid rows={[
      { id: "radius", label: "Radius", kind: "number", value: brush.radius, min: 0.1, max: 128, onChange: (radius) => setFoliageBrush({ ...brush, radius }) },
      { id: "density", label: "Density", kind: "number", value: brush.density, min: 0.01, max: 10, description: "Instances per square unit", onChange: (density) => setFoliageBrush({ ...brush, density }) },
    ]} />
    <PropertyGrid title="Placement" rows={[
      { id: "spacing", label: "Minimum Spacing", kind: "number", value: brush.spacing, min: 0.05, max: 50, onChange: (spacing) => setFoliageBrush({ ...brush, spacing }) },
      { id: "maxSlope", label: "Maximum Slope", kind: "slider", value: brush.maxSlope, min: 0, max: 90, step: 1, onChange: (maxSlope) => setFoliageBrush({ ...brush, maxSlope }) },
      { id: "alignToNormal", label: "Align To Surface", kind: "boolean", value: brush.alignToNormal, onChange: (alignToNormal) => setFoliageBrush({ ...brush, alignToNormal }) },
      { id: "randomYaw", label: "Random Rotation", kind: "boolean", value: brush.randomYaw, onChange: (randomYaw) => setFoliageBrush({ ...brush, randomYaw }) },
    ]} />
  </div></PanelFrame>;
}

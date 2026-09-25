import { useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { createActor, identitySerializedTransform, parseLandscapeProperties, resizeLandscape, type SerializedScene, type FoliageGroup, type SerializedComponent } from "@babylonslate/core";
import { AssetPicker, PanelFrame, PropertyGrid, TreeView, type PropertyRow } from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import { Empty, EmptyDescription, EmptyTitle } from "@babylonslate/ui/components/empty";
import { MountainIcon, TreesIcon } from "lucide-react";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useSceneEditing } from "../context/scene-editing-context";
import { useSceneTools } from "../context/scene-tools-context";
import { materialDomainsFromAssets } from "../lib/content-browser-helpers";
import { useCoarsePointer } from "../shell/use-platform-layout";

function useEnvironmentScene() {
  const { documentId } = useDocumentWorkspace();
  const documents = useDocuments();
  const doc = documents.openDocuments.find((entry) => entry.id === documentId);
  const scene = doc?.ref.kind === "scene" ? doc.content as SerializedScene : null;
  return { scene, documentId, ...documents, commit: (next: SerializedScene) => documents.applySceneChange(documentId, next) };
}

export function LandscapeOutlinerPanel(_props: IDockviewPanelProps) { void _props; return <EnvironmentOutliner classId="LandscapeComponent" />; }
export function FoliageOutlinerPanel(_props: IDockviewPanelProps) { void _props; return <EnvironmentOutliner classId="FoliageComponent" />; }

function EnvironmentOutliner({ classId }: { classId: string }) {
  const coarsePointer = useCoarsePointer();
  const { scene, commit } = useEnvironmentScene();
  const { selectedActorIds, selectActor, frameActor } = useSceneEditing();
  const { landscapeSelection, setLandscapeSelection } = useSceneTools();
  const entries = scene?.actors.flatMap((actor) => actor.components.filter((c) => c.classId === classId).map((component) => ({ actor, component, id: `${actor.id}/${component.id}` }))) ?? [];
  const landscape = classId === "LandscapeComponent";
  const selection = entries.find((entry) => landscape ? entry.id === landscapeSelection : selectedActorIds.includes(entry.actor.id));
  return <PanelFrame className="scene-environment-panel">
    <div className="flex h-full min-h-0 flex-col">
    <div className="min-h-0 flex-1">
    <TreeView aria-label={landscape ? "Landscape Components" : "Foliage Components"}
      rowHeight={coarsePointer ? 44 : undefined}
      nodes={entries.map(({ actor, component, id }) => ({ id, label: `${actor.name}${actor.components.filter((c) => c.classId === classId).length > 1 ? ` · ${component.id}` : ""}`, depth: 0, hasChildren: false, expanded: false, muted: actor.locked || !actor.visible, icon: landscape ? <MountainIcon /> : <TreesIcon /> }))}
      selectedId={selection?.id}
      onSelect={(id) => { const entry = entries.find((e) => e.id === id); if (!entry) return; selectActor(entry.actor.id); if (landscape) setLandscapeSelection(id); }}
      onActivate={(id) => { const entry = entries.find((e) => e.id === id); if (entry) frameActor(entry.actor.id); }}
    />
    </div>
    {!entries.length && <Empty><EmptyTitle>{landscape ? "No Landscapes" : "No Foliage"}</EmptyTitle><EmptyDescription>{landscape ? "Create a landscape in Landscape Settings." : "Add Models to a group, then select Paint in the viewport."}</EmptyDescription></Empty>}
    {selection && <div className="flex shrink-0 gap-1 p-2">
      <Button size="sm" variant="outline" onClick={() => frameActor(selection.actor.id)}>Frame</Button>
      <Button size="sm" variant="outline" disabled={selection.actor.locked} onClick={() => {
        if (!scene) return;
        void commit({ ...scene, actors: scene.actors.flatMap((actor) => actor.id !== selection.actor.id ? [actor] : actor.components.length === 1 && !scene.actors.some((child) => child.parentId === actor.id) ? [] : [{ ...actor, components: actor.components.filter((c) => c.id !== selection.component.id) }]) });
      }}>Delete Component</Button>
    </div>}
    </div>
  </PanelFrame>;
}

export function LandscapeSettingsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { scene, commit, assetRegistry, openDocuments } = useEnvironmentScene();
  const { selectActor, frameActor } = useSceneEditing();
  const tools = useSceneTools();
  const [materialPicker, setMaterialPicker] = useState(false);
  const [size, setSize] = useState(64);
  const [resolution, setResolution] = useState(64);
  const entries = scene?.actors.flatMap((actor) => actor.components.filter((c) => c.classId === "LandscapeComponent").map((component) => ({ actor, component, id: `${actor.id}/${component.id}` }))) ?? [];
  const selected = entries.find((entry) => entry.id === tools.landscapeSelection);
  const data = selected ? parseLandscapeProperties(selected.component.properties) : null;
  const update = (component: SerializedComponent) => {
    if (!scene || !selected || selected.actor.locked) return;
    void commit({ ...scene, actors: scene.actors.map((actor) => actor.id === selected.actor.id ? { ...actor, components: actor.components.map((entry) => entry.id === component.id ? component : entry) } : actor) });
  };
  const setData = (next: typeof data) => { if (selected && next) update({ ...selected.component, properties: { ...next } }); };
  const brush = tools.landscapeBrush;
  const rows: PropertyRow[] = [
    { id: "radius", label: "Brush Radius", kind: "number", value: brush.radius, min: 0.1, max: 512, onChange: (radius) => tools.setLandscapeBrush({ ...brush, radius }) },
    { id: "strength", label: "Brush Strength", kind: "number", value: brush.strength, min: 0.01, max: 10, onChange: (strength) => tools.setLandscapeBrush({ ...brush, strength }) },
    { id: "falloff", label: "Brush Falloff", kind: "slider", value: brush.falloff, min: 0.01, max: 1, step: 0.01, onChange: (falloff) => tools.setLandscapeBrush({ ...brush, falloff }) },
    { id: "height", label: "Flatten Height", kind: "number", value: brush.height, onChange: (height) => tools.setLandscapeBrush({ ...brush, height }) },
    { id: "layer", label: "Paint Layer", kind: "enum", value: String(brush.layer), options: [0, 1, 2, 3].map((i) => ({ value: String(i), label: `Layer ${i + 1}` })), onChange: (layer) => tools.setLandscapeBrush({ ...brush, layer: Number(layer) }) },
  ];
  const domains = materialDomainsFromAssets(assetRegistry?.list() ?? [], openDocuments);
  const materials = (assetRegistry?.list({ type: "Material" }) ?? []).filter((entry) => domains[entry.header.guid] === "landscape").map((entry) => ({ guid: entry.header.guid, name: entry.header.name, path: entry.path, type: entry.header.type }));
  return <PanelFrame className="scene-environment-panel"><div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
    <PropertyGrid rows={[
      { id: "size", label: "New Landscape Size", kind: "number", value: size, min: 1, max: 4096, onChange: setSize },
      { id: "resolution", label: "New Landscape Cells", kind: "number", value: resolution, min: 4, max: 256, sensitivity: 1, onChange: (value) => setResolution(Math.round(value)) },
    ]} />
    <div className="flex"><Button size="sm" onClick={() => {
      if (!scene) return;
      const actor = createActor(crypto.randomUUID(), `Landscape ${entries.length + 1}`, { components: [{ id: crypto.randomUUID(), classId: "LandscapeComponent", transform: identitySerializedTransform(), properties: { ...parseLandscapeProperties({ width: size, depth: size, subdivisions: resolution }) } }] });
      void commit({ ...scene, actors: [...scene.actors, actor] }).then((ok) => { if (ok) { selectActor(actor.id); tools.setLandscapeSelection(`${actor.id}/${actor.components[0]!.id}`); frameActor(actor.id); } });
    }}>Create Landscape</Button></div>
    {data && selected ? <PropertyGrid readOnly={selected.actor.locked} rows={[
      { id: "name", label: "Name", kind: "text", value: selected.actor.name, onChange: (name) => { if (scene) void commit({ ...scene, actors: scene.actors.map((a) => a.id === selected.actor.id ? { ...a, name } : a) }); } },
      { id: "width", label: "Width", kind: "number", value: data.width, min: 1, max: 4096, onChange: (width) => setData({ ...data, width }) },
      { id: "depth", label: "Depth", kind: "number", value: data.depth, min: 1, max: 4096, onChange: (depth) => setData({ ...data, depth }) },
      { id: "cells", label: "Cells", kind: "number", value: data.subdivisions, min: 4, max: 256, sensitivity: 1, onChange: (value) => setData(resizeLandscape(data, value)) },
      { id: "material", label: "Landscape Material", kind: "asset", value: data.materialGuid, displayLabel: materials.find((m) => m.guid === data.materialGuid)?.name, onPick: () => setMaterialPicker(true), onChange: (materialGuid) => setData({ ...data, materialGuid }) },
    ]} /> : <Empty><EmptyDescription>Select a Landscape to edit its settings.</EmptyDescription></Empty>}
    <PropertyGrid rows={rows} />
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
  return <PanelFrame className="scene-environment-panel"><div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
    <div className="flex flex-wrap gap-1"><Button size="sm" onClick={() => {
      const next = { id: crypto.randomUUID(), name: `Foliage Group ${groups.length + 1}`, models: [] };
      setGroups([...groups, next]); tools.setGroupId(next.id);
    }}>New Group</Button><Button size="sm" variant="outline" disabled={!group} onClick={() => { setGroups(groups.filter((entry) => entry.id !== group?.id)); tools.setGroupId(null); }}>Delete Group</Button></div>
    <PropertyGrid rows={[{ id: "group", label: "Foliage Group", kind: "enum", value: tools.groupId ?? "", options: groups.map((entry) => ({ value: entry.id, label: entry.name })), onChange: tools.setGroupId }]} />
    {group ? <>
      <PropertyGrid rows={[{ id: "name", label: "Group Name", kind: "text", value: group.name, onChange: (name) => update({ ...group, name }) }]} />
      {group.models.map((model, index) => <div key={`${model.modelGuid}:${index}`} className="flex flex-col gap-1">
        <PropertyGrid rows={[
          { id: "model", label: "Model", kind: "text", readOnly: true, value: assets.find((asset) => asset.guid === model.modelGuid)?.name ?? "Missing Model", onChange: () => {} },
          { id: "material", label: "Material Override", kind: "asset", value: model.materialGuid, displayLabel: assets.find((asset) => asset.guid === model.materialGuid)?.name, onPick: () => setPicker(index), onChange: (materialGuid) => update({ ...group, models: group.models.map((m, i) => i === index ? { ...m, materialGuid } : m) }) },
          ...(["weight", "minScale", "maxScale"] as const).map((key): PropertyRow => ({ id: key, label: key === "weight" ? "Weight" : key === "minScale" ? "Minimum Scale" : "Maximum Scale", kind: "number", value: model[key], min: key === "weight" ? 0 : 0.01, max: 100, onChange: (value) => update({ ...group, models: group.models.map((m, i) => i === index ? { ...m, [key]: value, ...(key === "minScale" && value > m.maxScale ? { maxScale: value } : {}), ...(key === "maxScale" && value < m.minScale ? { minScale: value } : {}) } : m) }) })),
        ]} />
        <div className="flex"><Button size="sm" variant="outline" onClick={() => update({ ...group, models: group.models.filter((_, i) => i !== index) })}>Remove Model</Button></div>
      </div>)}
      <div className="flex"><Button size="sm" variant="outline" onClick={() => setPicker("model")}>Add Model</Button></div>
    </> : <Empty><EmptyTitle>No Group Selected</EmptyTitle><EmptyDescription>Create a group and add Model assets to paint.</EmptyDescription></Empty>}
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
  const { foliageBrush: brush, setFoliageBrush } = useSceneTools();
  return <PanelFrame><div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2"><PropertyGrid rows={[
    { id: "radius", label: "Brush Radius", kind: "number", value: brush.radius, min: 0.1, max: 128, onChange: (radius) => setFoliageBrush({ ...brush, radius }) },
    { id: "density", label: "Instances Per Square Unit", kind: "number", value: brush.density, min: 0.01, max: 10, onChange: (density) => setFoliageBrush({ ...brush, density }) },
    { id: "spacing", label: "Minimum Spacing", kind: "number", value: brush.spacing, min: 0.05, max: 50, onChange: (spacing) => setFoliageBrush({ ...brush, spacing }) },
    { id: "maxSlope", label: "Maximum Slope", kind: "number", value: brush.maxSlope, min: 0, max: 90, onChange: (maxSlope) => setFoliageBrush({ ...brush, maxSlope }) },
    { id: "alignToNormal", label: "Align To Surface", kind: "boolean", value: brush.alignToNormal, onChange: (alignToNormal) => setFoliageBrush({ ...brush, alignToNormal }) },
    { id: "randomYaw", label: "Random Rotation", kind: "boolean", value: brush.randomYaw, onChange: (randomYaw) => setFoliageBrush({ ...brush, randomYaw }) },
  ]} /></div></PanelFrame>;
}

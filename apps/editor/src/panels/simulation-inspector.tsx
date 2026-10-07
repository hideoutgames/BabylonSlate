import { useEffect, useMemo, useRef, useState, type FocusEvent } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import type { RuntimeInspectorValue, RuntimeObjectIdentity, RuntimePropertyDescriptor } from "@babylonslate/bridge";
import type { MaterialParameterValue, SerializedTransform, ViewportMode } from "@babylonslate/core";
import { AssetPicker, EditorReadOnlyContext, PanelFrame, PropertyGrid, SearchInput, type AssetPickerEntry, type PropertyRow } from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import { useDocuments } from "../context/document-context";
import { useOptionalSceneEditing } from "../context/scene-editing-context";
import { useSimulationInspection } from "../context/simulation-inspection-context";
import { runtimeIdentityKey, type SimulationInspectionStore } from "../services/simulation-inspection-store";
import { spatialTransformPropertyRows } from "../lib/transform-property-rows";

const MATERIAL_ASSET_TYPES = ["Material", "MaterialInstance"];
const TEXTURE_ASSET_TYPES = ["Texture"];

function valueLabel(value: RuntimeInspectorValue): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (value.$runtime === "unavailable") return String(value.reason ?? "Unavailable");
    if (value.$runtime === "undefined") return "Not Set";
    if (value.$runtime === "reference") return `Reference · ${String(value.classId ?? "Object")}`;
    if (value.$runtime === "array" || value.$runtime === "map") return `${value.$runtime === "array" ? "Array" : "Map"} · ${value.length} Items`;
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

function useRuntimeDraft<T>(value: T) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const sequence = useRef(0);
  useEffect(() => { if (!focused && !pending) setDraft(value); }, [value, focused, pending]);
  const write = (next: T, request: () => Promise<unknown>) => {
    setDraft(next); setPending(true); setStatus("Pending…");
    const id = ++sequence.current;
    void request().then(() => { if (sequence.current === id) setStatus("Applied"); }, error => {
      if (sequence.current === id) setStatus(error instanceof Error ? error.message : String(error));
    }).finally(() => { if (sequence.current === id) setPending(false); });
  };
  return { draft, setDraft, write, status, pending,
    focusProps: { onFocusCapture: () => setFocused(true), onBlurCapture: (event: FocusEvent<HTMLDivElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
    } } };
}

function RuntimeTransformFields({ store, target, transform, mode, disabled, reason }: {
  store: SimulationInspectionStore; target: RuntimeObjectIdentity; transform: SerializedTransform;
  mode: ViewportMode; disabled: boolean; reason?: string;
}) {
  const field = useRuntimeDraft(transform);
  const update = (next: SerializedTransform, final: boolean) => field.write(next, () => store.request(
    { kind: "setTransform", target, transform: next }, final ? { final: true } : { continuous: true }));
  const rows = spatialTransformPropertyRows("simulation-transform", mode, field.draft, next => update(next, false));
  const commits = spatialTransformPropertyRows("simulation-transform", mode, field.draft, next => update(next, true));
  for (const [index, row] of rows.entries()) {
    row.disabled = disabled;
    const commit = commits[index];
    if (row.kind === "number" && commit?.kind === "number") row.onCommit = commit.onChange;
    if (row.kind === "vector3" && commit?.kind === "vector3") row.onCommit = commit.onChange;
  }
  return <div {...field.focusProps}>
    <PropertyGrid title="Local Transform" rows={rows} />
    <p role="status" className="px-2 text-xs text-muted-foreground">{reason ?? field.status ?? "Pause to place a moving actor without gameplay overwriting the pose."}</p>
  </div>;
}

function RuntimePropertyField({ descriptor, target, store, materialGuid, assets }: {
  descriptor: RuntimePropertyDescriptor; target: RuntimeObjectIdentity; store: SimulationInspectionStore; materialGuid?: string; assets: AssetPickerEntry[];
}) {
  const field = useRuntimeDraft(descriptor.value);
  const [picker, setPicker] = useState(false);
  const [expandedValue, setExpandedValue] = useState<RuntimeInspectorValue | null>(null);
  const [nextOffset, setNextOffset] = useState<number | undefined>();
  const [valueError, setValueError] = useState<string | null>(null);
  const material = descriptor.key.startsWith("material:");
  const writable = ["live", "rebuild"].includes(descriptor.capability);
  const description = descriptor.reason ?? (descriptor.capability === "rebuild" ? "Changing this property rebuilds its runtime resource." : undefined);
  const send = (value: RuntimeInspectorValue, final = true) => field.write(value, async () => {
    if (material) {
      if (!materialGuid) throw new Error("The selected component's material identity is unavailable on this page.");
      return store.request({ kind: "setMaterialParameter", target, materialGuid, parameter: descriptor.key.slice(9), value: value as MaterialParameterValue }, final ? { final: true } : { continuous: true });
    }
    return store.request({ kind: "setProperty", target, property: descriptor.key, value }, final ? { final: true } : { continuous: true });
  });
  const colorFinalRef = useRef<(() => void) | null>(null);
  const colorTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const finishColor = () => {
    clearTimeout(colorTimerRef.current); colorTimerRef.current = undefined;
    const commit = colorFinalRef.current; colorFinalRef.current = null; commit?.();
  };
  useEffect(() => () => { clearTimeout(colorTimerRef.current); colorFinalRef.current?.(); }, []);
  const sendColor = (value: RuntimeInspectorValue) => {
    send(value, false);
    colorFinalRef.current = () => send(value, true);
    clearTimeout(colorTimerRef.current);
    colorTimerRef.current = setTimeout(finishColor, 150);
  };
  const raw = field.draft;
  const materialValue = material && raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
  const value = materialValue ? materialValue.kind === "texture" ? materialValue.textureAssetGuid : materialValue.value : raw;
  const wrap = (next: RuntimeInspectorValue): RuntimeInspectorValue => materialValue
    ? materialValue.kind === "texture" ? { kind: "texture", textureAssetGuid: next } : { kind: materialValue.kind!, value: next }
    : next;
  const base = { id: `simulation-${descriptor.key}`, label: descriptor.name, disabled: !writable, description };
  const assetType = descriptor.key === "materialGuid" ? "Material" : descriptor.typeId === "material:texture" ? "Texture" : null;
  let row: PropertyRow;
  if (assetType && (value === null || typeof value === "string")) {
    const selected = assets.find(asset => asset.guid === value);
    row = { ...base, kind: "asset", value: value as string | null, displayLabel: selected?.name, displayType: selected?.type,
      onPick: () => setPicker(true), onChange: next => send(wrap(next)) };
  } else if (descriptor.typeId === "material:color" && Array.isArray(value) && value.length === 4 && value.every(item => typeof item === "number")) {
    row = { ...base, kind: "color4", value: value as [number, number, number, number], onChange: next => sendColor(wrap(next)) };
  } else if (typeof value === "number") {
    row = { ...base, kind: "number", value, onChange: next => send(wrap(next), false), onCommit: next => send(wrap(next), true) };
  } else if (typeof value === "boolean") {
    row = { ...base, kind: "boolean", value, onChange: next => send(wrap(next)) };
  } else if (typeof value === "string") {
    row = { ...base, kind: "text", value, readOnly: !writable, disabled: false,
      onChange: next => field.setDraft(wrap(next)), onCommit: next => send(wrap(next)) };
  } else {
    const vector = value && typeof value === "object" && !Array.isArray(value) && ["vector", "vector2", "vector3", "quaternion", "rotator"].includes(descriptor.typeId) ? value : null;
    if (vector && typeof vector.x === "number" && typeof vector.y === "number") {
      const count = typeof vector.w === "number" ? 4 : typeof vector.z === "number" ? 3 : 2;
      const encode = (next: [number, number, number] | [number, number, number, number]) => Object.fromEntries(["x", "y", "z", "w"].slice(0, count).map((key, index) => [key, next[index]!])) as RuntimeInspectorValue;
      row = { ...base, kind: "vector3", value: count === 4 ? [vector.x, vector.y, Number(vector.z), Number(vector.w)] : [vector.x, vector.y, Number(vector.z ?? 0)], axes: ["X", "Y", "Z", "W"].slice(0, count), onChange: next => send(encode(next), false), onCommit: next => send(encode(next)) };
    } else row = { ...base, kind: "text", disabled: false, readOnly: true, value: valueLabel(raw), onChange: () => {} };
  }
  const controlWritable = writable && !(row.kind === "text" && row.readOnly);
  const capabilityLabel = !controlWritable ? descriptor.capability === "restart" ? "Restart Required"
    : writable ? "Value inspection only for this type." : "Read-only" : null;
  const canExpand = raw !== null && typeof raw === "object" && !material && descriptor.container && descriptor.container !== "single";
  const expand = async (offset = 0) => {
    try {
      const result = await store.request({ kind: "value", target, property: descriptor.key, offset });
      if (result.payload?.kind === "value") { setExpandedValue(result.payload.value); setNextOffset(result.payload.nextOffset); setValueError(null); }
    } catch (error) { setValueError(String(error)); }
  };
  return <div {...field.focusProps} onPointerUpCapture={finishColor}
    onBlurCapture={event => { field.focusProps.onBlurCapture(event); finishColor(); }}>
    <PropertyGrid rows={[row]} />
    <p role="status" className="px-2 text-xs text-muted-foreground">{field.status ?? capabilityLabel}</p>
    {canExpand ? <Button size="sm" variant="ghost" onClick={() => { if (expandedValue) setExpandedValue(null); else void expand(); }}>{expandedValue ? "Close Value" : "Inspect Value"}</Button> : null}
    {expandedValue ? <div className="px-2"><pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(expandedValue, null, 2)}</pre><p className="text-xs text-muted-foreground">Last requested value · does not poll while expanded.</p>{nextOffset !== undefined ? <Button size="sm" variant="outline" onClick={() => void expand(nextOffset)}>Next Value Page</Button> : null}</div> : null}
    {valueError ? <p role="status" className="px-2 text-xs text-destructive">{valueError}</p> : null}
    {assetType ? <AssetPicker open={picker} onOpenChange={setPicker} assets={assets} allowedTypes={assetType === "Material" ? MATERIAL_ASSET_TYPES : TEXTURE_ASSET_TYPES}
      createTypes={[]} title={`Pick ${assetType ?? "Asset"}`} onPick={guid => { send(wrap(guid)); setPicker(false); }} /> : null}
  </div>;
}

export function SimulationInspector({ store, panel }: { store: SimulationInspectionStore; panel: IDockviewPanelProps }) {
  const state = useSimulationInspection(store, panel, "selection");
  const { assetRegistry, registryEpoch } = useDocuments();
  const assets = useMemo(() => {
    void registryEpoch;
    return (assetRegistry?.list() ?? []).map(asset => ({ guid: asset.header.guid, name: asset.header.name, type: asset.header.type, path: asset.path }));
  }, [assetRegistry, registryEpoch]);

  const mode = useOptionalSceneEditing()?.viewportMode ?? "3d";
  const [search, setSearch] = useState("");
  const selection = state.selection;
  const identity = state.selected ? runtimeIdentityKey(state.selected) : null;
  const selectedRow = state.rows.find(row => runtimeIdentityKey(row.identity) === identity);
  const materialGuid = selection?.materialGuid ?? selection?.properties.find(property => property.key === "materialGuid")?.value;
  return <PanelFrame title="Simulation Inspector" data-testid="simulation-inspector">
    <div className="p-2"><SearchInput value={search} onChange={setSearch} placeholder="Search Runtime Properties" /></div>
    <p className="px-2 pb-2 text-xs text-muted-foreground">{selectedRow ? `${selectedRow.name || selectedRow.classId} · Tick ${state.tickIndex}` : state.selected ? "Selected Runtime Object" : "Select a runtime object in the Outliner or viewport."}</p>
    {state.selectionError ? <p role="status" className="p-2 text-xs text-destructive">{state.selectionError}</p> : null}
    {selection ? <EditorReadOnlyContext.Provider value={false}><div key={identity} className="space-y-2 pb-2">
      {!search ? <RuntimeTransformFields store={store} target={selection.target} transform={selection.transform} mode={mode}
        disabled={selection.transformCapability !== "live"} reason={selection.transformReason} /> : null}
      {selection.properties.filter(property => `${property.name} ${property.typeId}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(descriptor =>
        <RuntimePropertyField key={descriptor.key} descriptor={descriptor} target={selection.target} store={store} assets={assets} materialGuid={typeof materialGuid === "string" ? materialGuid : undefined} />)}
      {selection.nextOffset !== undefined ? <Button size="sm" variant="outline" className="mx-2" onClick={store.loadMoreProperties}>Next Property Page</Button> : null}
      <Button size="sm" variant="ghost" className="mx-2" onClick={store.firstProperties}>First Property Page</Button>
    </div></EditorReadOnlyContext.Provider> : state.selected && !state.selectionError ? <p role="status" className="p-2 text-xs">Loading Selection…</p> : null}
  </PanelFrame>;
}

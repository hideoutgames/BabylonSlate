import { useEffect, useMemo, useState } from "react";
import { AssetPicker, ClassPicker, DisclosureSection, EntryListEditor, PropertyGrid, classRowIdentity, humanizePropertyLabel, walkAncestry, type ClassPickerEntry, type PropertyRow } from "@babylonslate/editor-kit";
import { parseMapDefaultEntries, type GraphClassMember, type SerializedGraph } from "@babylonslate/core";
import { Field, FieldDescription, FieldError, FieldLabel } from "@babylonslate/ui/components/field";
import { useDocumentActions, useRegistryState } from "../context/document-context";
import { useOpenDocumentsOfKinds } from "../lib/use-open-documents-of-kinds";
import { subclassClassEntries } from "../lib/component-property-rows";
import { classIdFromClassAsset, classParentLookup } from "../lib/content-browser-helpers";
import { collectEnumMemberNames, variableDefaultPropertyRows } from "../lib/graph-inspector";
import { collectGraphTypeAssets, typeSchemasFromGraphAssets } from "../lib/logic-graph-document";

/** Open type tabs override saved Structures, Enums and Data Definitions. */
const TYPE_KINDS = ["structure", "enum", "data-definition"] as const;
const CLASS_KINDS = ["graph"] as const;

type SwitcherEntry = { classId: string; defaults: Record<string, unknown> };
function entriesFrom(value: unknown): SwitcherEntry[] {
  return Array.isArray(value) ? value.flatMap(entry => typeof entry === "string" ? [{ classId: entry, defaults: {} }] : entry && typeof entry === "object" && typeof entry.classId === "string" ? [{ classId: entry.classId, defaults: entry.defaults && typeof entry.defaults === "object" && !Array.isArray(entry.defaults) ? entry.defaults : {} }] : []) : [];
}

/** Shared actor and prefab switcher authoring with inherited Class variable defaults. */
export function SceneLayerSwitcherFields({ properties: authoredProperties, classId, onChange }: { properties: Record<string, unknown>; classId?: string; onChange: (properties: Record<string, unknown>) => void }) {
  const { loadGraphDocument } = useDocumentActions();
  const { assetRegistry, registryEpoch } = useRegistryState();
  const typeDocuments = useOpenDocumentsOfKinds(TYPE_KINDS);
  const classDocuments = useOpenDocumentsOfKinds(CLASS_KINDS);
  const [picking, setPicking] = useState<number | null>(null);
  const assets = useMemo(() => { void registryEpoch; return assetRegistry?.list() ?? []; }, [assetRegistry, registryEpoch]);
  const classes = useMemo(() => subclassClassEntries("SceneLayerActor", assets), [assets]);
  const parentOf = useMemo(() => classParentLookup(assets), [assets]);
  const [graphs, setGraphs] = useState<Record<string, SerializedGraph>>({});
  const [error, setError] = useState<string | null>(null);
  const properties = Object.assign({}, ...walkAncestry(classId ?? "SceneLayerActorSwitcher", parentOf).reverse().map(id => graphs[id]?.actorDefaults?.properties ?? {}), authoredProperties);
  const entries = entriesFrom(properties.sceneLayerActors);
  const entryClassIds = [...entries.map(entry => entry.classId), ...(classId ? [classId] : [])].join("\n");
  const schemas = useMemo(() => typeSchemasFromGraphAssets(collectGraphTypeAssets({ assets, openDocuments: typeDocuments })), [assets, typeDocuments]);
  const enumMembers = useMemo(() => collectEnumMemberNames(typeDocuments, assets), [assets, typeDocuments]);
  useEffect(() => {
    let active = true;
    setError(null);
    const ids = new Set(entryClassIds.split("\n").flatMap(id => walkAncestry(id, parentOf)));
    void Promise.all(assets.filter(asset => asset.header.type === "Class" && ids.has(classIdFromClassAsset(asset))).map(async asset => {
      const open = classDocuments.find(doc => doc.ref.path === asset.path);
      return [classIdFromClassAsset(asset), open ? open.content as SerializedGraph : await loadGraphDocument(asset.path)] as const;
    })).then(results => { if (active) setGraphs(Object.fromEntries(results.filter((entry): entry is readonly [string, SerializedGraph] => entry[1] !== null))); }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "Unable to load Class defaults."); });
    return () => { active = false; };
  }, [assets, classDocuments, entryClassIds, loadGraphDocument, parentOf]);
  const changeEntries = (sceneLayerActors: SwitcherEntry[]) => onChange({ ...properties, sceneLayerActors });
  return <Field className="p-2" data-testid="scene-layer-switcher-fields">
    <FieldLabel>Scene Layer Actors</FieldLabel>
    <PropertyGrid density="compact" rows={[{ kind: "number", id: "switcher-initial-index", label: "Initial Index", value: typeof properties.initialIndex === "number" ? properties.initialIndex : 0, min: -1, max: Math.max(0, entries.length - 1), precision: 0, sensitivity: 1, description: "Zero selects the first entry. Use -1 to start empty.", onChange: initialIndex => onChange({ ...properties, initialIndex: Math.trunc(initialIndex) }) }]} />
    <EntryListEditor items={entries} onChange={changeEntries} onAdd={() => setPicking(entries.length)} addLabel="Add Scene Layer Actor" touchAdaptive data-testid="switcher-entries"
      renderItemHeader={({ item, index }) => <PropertyGrid density="compact" rows={[{ kind: "asset", id: `switcher-class-${index}`, label: `Actor ${index + 1} Class`, value: item.classId, ...classRowIdentity(classes.find(entry => entry.id === item.classId) ?? { id: item.classId, name: item.classId }), onPick: () => setPicking(index), onChange: () => {} }]} />}
      renderItem={({ item, index, onChange: update }) => {
        const variables = new Map<string, GraphClassMember>();
        for (const id of walkAncestry(item.classId, parentOf).reverse()) for (const member of graphs[id]?.members ?? []) if (member.kind === "variable" && !member.functionId) variables.set(member.propertyKey ?? member.name, member);
        return <SwitcherDefaults index={index} defaults={item.defaults} members={[...variables.values()]} schemas={schemas} enumMembers={enumMembers} classes={subclassClassEntries("BObject", assets)} assets={assets.map(asset => ({ guid: asset.header.guid, name: asset.header.name, type: asset.header.type, path: asset.path }))} onChange={defaults => update({ ...item, defaults })} />;
      }} />
    {error ? <FieldError>{error}</FieldError> : null}
    {entries.length === 0 ? <FieldDescription>Add the Scene Layer Actor classes available to this switcher.</FieldDescription> : null}
    <ClassPicker open={picking !== null} onOpenChange={open => { if (!open) setPicking(null); }} classes={classes} createBaseClass="SceneLayerActor" allowNone={false} title="Pick Scene Layer Actor Class" onPick={classId => { if (!classId || picking === null) return; const next = [...entries]; next[picking] = { classId, defaults: entries[picking]?.classId === classId ? entries[picking]!.defaults : {} }; changeEntries(next); setPicking(null); }} data-testid="switcher-class-picker" />
  </Field>;
}

function SwitcherDefaults({ index, defaults, members, schemas, enumMembers, classes, assets, onChange }: { index: number; defaults: Record<string, unknown>; members: GraphClassMember[]; schemas: ReturnType<typeof typeSchemasFromGraphAssets>; enumMembers: Record<string, readonly string[]>; classes: ClassPickerEntry[]; assets: Array<{ guid: string; name: string; type: string; path: string }>; onChange: (defaults: Record<string, unknown>) => void }) {
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState<{ kind: "asset" | "class"; constraint: string; change: (value: string | null) => void } | null>(null);
  const scalarRows = (member: GraphClassMember, value: unknown, change: (value: unknown) => void, suffix = ""): PropertyRow[] => variableDefaultPropertyRows(member.typeId ?? "string", value, change, {
    schemas, enumMembers, typeClassId: member.typeClassId, label: humanizePropertyLabel(member.name), pinId: `${index}-${member.id}${suffix}`,
    assetEntries: assets.map(asset => ({ id: asset.guid, name: asset.name, type: asset.type })), classEntries: classes,
    onPickAsset: (_id, constraint) => setPick({ kind: "asset", constraint, change }), onPickClass: (_id, constraint) => setPick({ kind: "class", constraint, change }),
  });
  const rows: PropertyRow[] = [
    { kind: "text", id: `switcher-default-name-${index}`, label: "Name", value: typeof defaults.name === "string" ? defaults.name : "", onChange: name => onChange({ ...defaults, name }) },
    { kind: "boolean", id: `switcher-default-visible-${index}`, label: "Visible", value: defaults.visible !== false, onChange: visible => onChange({ ...defaults, visible }) },
    ...members.filter(member => !member.container || member.container === "single").flatMap(member => {
      const key = member.propertyKey ?? member.name;
      return scalarRows(member, Object.hasOwn(defaults, key) ? defaults[key] : member.defaultValue, value => onChange({ ...defaults, [key]: value })).map(row => ({ ...row, defaultValue: member.defaultValue } as PropertyRow));
    }),
  ];
  return <DisclosureSection data-testid={`switcher-defaults-${index}`} title="Defaults" open={open} onOpenChange={setOpen}>
    <PropertyGrid density="compact" rows={rows} />
    {members.filter(member => member.container === "array").map(member => {
      const key = member.propertyKey ?? member.name, raw = Object.hasOwn(defaults, key) ? defaults[key] : member.defaultValue, items = Array.isArray(raw) ? raw : [];
      return <EntryListEditor key={member.id} title={humanizePropertyLabel(member.name)} items={items} onChange={value => onChange({ ...defaults, [key]: value })} onCreate={() => member.typeId === "bool" ? false : member.typeId === "int" || member.typeId === "float" ? 0 : ""} addLabel="Add Default Item" renderItem={({ item, index: itemIndex, onChange: update }) => <PropertyGrid density="compact" rows={scalarRows(member, item, update, `-${itemIndex}`)} />} />;
    })}
    {members.filter(member => member.container === "map").map(member => {
      const key = member.propertyKey ?? member.name;
      return <EntryListEditor key={member.id} title={humanizePropertyLabel(member.name)} items={parseMapDefaultEntries(Object.hasOwn(defaults, key) ? defaults[key] : member.defaultValue)} onChange={value => onChange({ ...defaults, [key]: value })} onCreate={() => ({ key: "", value: member.typeId === "bool" ? false : member.typeId === "int" || member.typeId === "float" ? 0 : "" })} addLabel="Add Default Entry" renderItem={({ item, index: entryIndex, onChange: update }) => <PropertyGrid density="compact" rows={[
        ...scalarRows({ ...member, name: "Key", typeId: member.keyTypeId ?? "string", typeClassId: member.keyTypeClassId }, item.key, value => update({ ...item, key: value }), `-${entryIndex}-key`),
        ...scalarRows({ ...member, name: "Value" }, item.value, value => update({ ...item, value }), `-${entryIndex}-value`),
      ]} />} />;
    })}
    <AssetPicker open={pick?.kind === "asset"} onOpenChange={value => { if (!value) setPick(null); }} assets={assets} allowedTypes={pick?.constraint && pick.constraint !== "Asset" ? [pick.constraint] : undefined} allowNone onPick={value => { pick?.change(value); setPick(null); }} />
    <ClassPicker open={pick?.kind === "class"} onOpenChange={value => { if (!value) setPick(null); }} classes={classes.filter(entry => !pick?.constraint || entry.ancestry?.includes(pick.constraint) || entry.id === pick.constraint)} allowNone onPick={value => { pick?.change(value); setPick(null); }} />
  </DisclosureSection>;
}

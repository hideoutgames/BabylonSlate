import { useId, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { carriesLoadingPolicy } from "@babylonslate/core";
import { reconcileDataDefinitionDefault } from "@babylonslate/scripting";
import {
  ASSET_REF_PICKER_TYPES, AssetLoadingField, AssetPicker, ClassPicker, PanelFrame, PinListEditor,
  PropertyGrid, PropertySectionTitle, TypeColorMark, VariableTypeFields, assetRowIdentity, classRowIdentity,
  humanizePropertyLabel, pinPickerColorVar, pinPickerLabel, type PropertyRow,
} from "@babylonslate/editor-kit";
import { Alert, AlertDescription } from "@babylonslate/ui/components/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@babylonslate/ui/components/empty";
import { DATA_DEFINITION_FIELD_TYPES, useDataDefinitionEditing } from "../context/data-definition-editing-context";
import { DataValueEditor } from "../components/data-value-editor";

/** Compact field authoring; selected field settings live in the Details dock. */
export function DataDefinitionFieldsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { definition, selected, setSelectedId, changeFields, readOnly, error, issues, typeAssets, catalog } = useDataDefinitionEditing();
  return <PanelFrame data-testid="data-definition-fields-panel">
    <div className="flex min-h-0 flex-col gap-2 overflow-y-auto p-2">
      {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
      {issues.length ? <Alert variant="destructive"><AlertDescription><ul className="list-disc pl-4">{issues.map((issue, index) => <li key={`${issue.path}:${issue.code}:${index}`}>{issue.path ? `${issue.path}: ` : ""}{issue.message}</li>)}</ul></AlertDescription></Alert> : null}
      <PinListEditor
        rows={definition.fields.map(field => ({ ...field, type: field.typeId, defaultValue: undefined }))}
        onChange={changeFields} selectedId={selected?.id} onSelect={setSelectedId}
        itemLabel="Field" addPosition="top" showDetails={false} showOptional={false} showDefault={false}
        types={DATA_DEFINITION_FIELD_TYPES} structAssetType="DataDefinition" typeAssets={typeAssets}
        classEntries={catalog.classEntries} readOnly={readOnly}
        testIdPrefix="definition-field" data-testid="data-definition-fields"
      />
      {definition.fields.length === 0 ? <Empty><EmptyHeader><EmptyTitle>No Fields</EmptyTitle><EmptyDescription>Add a field above, then edit its type, default and rules in Details. Reopen Details from the Windows menu.</EmptyDescription></EmptyHeader></Empty> : null}
    </div>
  </PanelFrame>;
}

function SelectedFieldDetails() {
  const controlId = useId();
  const { catalog, definition, selected, readOnly, typeAssets, patchSelected, setSelectedLoading, changeSelectedType, recursive, projectedSelected, selectedDefault, commit, issues } = useDataDefinitionEditing();
  const [classPickerOpen, setClassPickerOpen] = useState(false);
  const [typePickerOpen, setTypePickerOpen] = useState(false);
  if (!selected) return null;
  const pickerType = selected.typeId === "struct" && selected.typeClassId === "engine:TagContainer" ? "tagContainer" : selected.typeId;
  const typeAsset = typeAssets.find(entry => entry.guid === selected.typeClassId);
  const container = selected.container ?? "single";
  const typeSummary = [
    typeAsset?.name ?? (pickerType === "struct" ? "Data Definition" : pinPickerLabel(pickerType)),
    container === "single" ? null : container === "map" ? `Map From ${pinPickerLabel(selected.keyTypeId ?? "string")}` : "Array",
  ].filter(Boolean).join(" · ");
  const constraints: PropertyRow[] = [];
  if (selected.typeId === "class") {
    const classId = selected.typeClassId?.trim() || "BObject";
    constraints.push({ id: `${controlId}:class-type`, kind: "asset", label: "Class Type", value: classId,
      ...classRowIdentity(catalog.classEntries.find(entry => entry.id === classId), classId),
      onPick: () => setClassPickerOpen(true), onChange: value => changeSelectedType({ typeClassId: value ?? "BObject" }),
    });
  } else if ((selected.typeId === "struct" && selected.typeClassId !== "engine:TagContainer") || selected.typeId === "enum") {
    constraints.push({ id: `${controlId}:type-asset`, kind: "asset", label: selected.typeId === "enum" ? "Enum Type" : "Data Definition Type", value: selected.typeClassId ?? null,
      ...assetRowIdentity(typeAsset), placeholder: "Choose Type",
      onPick: () => setTypePickerOpen(true), onChange: value => changeSelectedType({ typeClassId: value ?? undefined }),
    });
  } else if (selected.typeId === "asset") {
    constraints.push({ id: `${controlId}:asset-type`, kind: "enum", label: "Asset Type", value: selected.typeClassId ?? "",
      options: [{ value: "", label: "Any Asset" }, ...ASSET_REF_PICKER_TYPES.map(type => ({ value: type, label: humanizePropertyLabel(type) }))],
      onChange: value => changeSelectedType({ typeClassId: value || undefined }),
    });
  }
  const rules: PropertyRow[] = [
    { id: `${controlId}:category`, kind: "text", label: "Category", value: selected.category ?? "", onChange: value => patchSelected({ category: value }) },
    { id: `${controlId}:description`, kind: "text", label: "Description", value: selected.description ?? "", onChange: value => patchSelected({ description: value }) },
    { id: `${controlId}:required`, kind: "boolean", label: "Required", value: selected.required === true, onChange: value => patchSelected({ required: value }) },
  ];
  if ((selected.typeId === "float" || selected.typeId === "int") && container === "single") {
    for (const bound of ["min", "max"] as const) {
      const label = bound === "min" ? "Minimum" : "Maximum";
      rules.push({ id: `${controlId}:use-${bound}`, kind: "boolean", label: `Limit ${label}`, value: selected[bound] !== undefined, onChange: value => patchSelected({ [bound]: value ? 0 : undefined }) });
      if (selected[bound] !== undefined) rules.push({ id: `${controlId}:${bound}`, kind: "number", label, value: selected[bound]!, onChange: value => patchSelected({ [bound]: value }, `definition:${selected.id}:${bound}`) });
    }
  }
  return <>
    <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-panel-header px-2 py-1.5">
      <TypeColorMark colorVar={pinPickerColorVar(pickerType)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] font-medium" title={selected.name}>{selected.name || "Unnamed Field"}</span>
        <span className="truncate text-xs text-muted-foreground" title={typeSummary}>{typeSummary}</span>
      </div>
    </div>
    <PropertyGrid title="Field" rows={[{ id: `${controlId}:name`, kind: "text", label: "Name", value: selected.name, onChange: value => patchSelected({ name: value }) }]} readOnly={readOnly} />
    <fieldset disabled={readOnly} className="min-w-0 border-b border-border/30 px-2 py-1.5">
      <VariableTypeFields
        value={{ ...selected, container }}
        onChange={changeSelectedType} classEntries={catalog.classEntries} typeAssets={typeAssets}
        structAssetType="DataDefinition" types={DATA_DEFINITION_FIELD_TYPES}
      />
    </fieldset>
    {constraints.length ? <PropertyGrid rows={constraints} readOnly={readOnly} /> : null}
    {carriesLoadingPolicy(selected) ? <div className="border-b border-border/30 px-2 py-1.5">
      <AssetLoadingField value={selected.loading} onChange={setSelectedLoading} disabled={readOnly} data-testid="data-definition-field-loading" />
    </div> : null}
    {recursive ? null : <>
      <PropertySectionTitle>Default</PropertySectionTitle>
      <DataValueEditor field={selected}
        value={projectedSelected?.defaultValue !== undefined ? projectedSelected.defaultValue : selectedDefault?.values[selected.name]}
        defaultValue={selectedDefault?.values[selected.name]}
        onChange={value => {
          const base = projectedSelected?.defaultValue !== undefined ? projectedSelected : { ...selected, ...selectedDefault?.schema[0] };
          const next = reconcileDataDefinitionDefault({ ...base, defaultValue: value }, catalog.schemas);
          commit(definition.fields.map(field => field.id === selected.id ? next : field), `definition:${selected.id}:default`);
        }}
        label="Default Value" path={selected.name} disabled={readOnly} catalog={catalog} issues={issues}
      />
    </>}
    <PropertyGrid title="Field Rules" rows={rules} readOnly={readOnly} />
    <ClassPicker open={classPickerOpen} onOpenChange={setClassPickerOpen}
      classes={catalog.classEntries} allowNone={false} title="Pick Class Type"
      onPick={classId => { if (classId) changeSelectedType({ typeClassId: classId }); setClassPickerOpen(false); }}
    />
    <AssetPicker open={typePickerOpen} onOpenChange={setTypePickerOpen}
      assets={typeAssets} allowedTypes={[selected.typeId === "enum" ? "Enum" : "DataDefinition"]}
      title={selected.typeId === "enum" ? "Pick Enum Type" : "Pick Data Definition Type"} allowNone
      onPick={guid => { changeSelectedType({ typeClassId: guid ?? undefined }); setTypePickerOpen(false); }}
    />
  </>;
}

export function DataDefinitionDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { selected, error } = useDataDefinitionEditing();
  return <PanelFrame data-testid="data-definition-details-panel">
    <div className="flex min-h-0 flex-col">
      {error ? <div className="p-2"><Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert></div> : null}
      {selected ? <SelectedFieldDetails key={selected.id} /> : <Empty><EmptyHeader><EmptyTitle>No Field Selected</EmptyTitle><EmptyDescription>Add a field in Fields to edit its type, defaults and rules.</EmptyDescription></EmptyHeader></Empty>}
    </div>
  </PanelFrame>;
}

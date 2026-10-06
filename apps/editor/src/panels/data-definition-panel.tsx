import { useMemo, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { normalizeDataDefinitionAsset, type DataDefinitionField } from "@babylonslate/core";
import { structInstanceDefault, validateDataDefinition } from "@babylonslate/scripting";
import { PanelFrame, PinListEditor, PropertyGrid, type PinListRow, type PropertyRow } from "@babylonslate/editor-kit";
import { Alert, AlertDescription } from "@babylonslate/ui/components/alert";
import { Separator } from "@babylonslate/ui/components/separator";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useDataCatalog } from "../lib/use-data-catalog";
import { DataValueEditor } from "../components/data-value-editor";

const FIELD_TYPES = ["bool", "int", "float", "string", "tag", "tagContainer", "enum", "vec2", "vec3", "vec4", "rotator", "quat", "color", "transform", "class", "asset", "struct"];

/** Definition fields own their defaults and authoring rules, independently of Structures. */
export function DataDefinitionFieldsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const documents = useDocuments();
  const catalog = useDataCatalog();
  const doc = documents.openDocuments.find(entry => entry.id === documentId);
  const definition = useMemo(() => normalizeDataDefinitionAsset(doc?.content ?? {}), [doc?.content]);
  const asset = catalog.assets.find(entry => entry.path === doc?.ref.path);
  const readOnly = Boolean(asset && documents.assetRegistry?.getRoot(asset.rootId)?.readOnly) || Boolean(doc && documents.sourceControl.isDocumentReadOnly(doc.ref.path));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selected = definition.fields.find(field => field.id === selectedId) ?? definition.fields[0];
  const issues = useMemo(() => validateDataDefinition(definition, catalog.schemas, asset?.header.guid), [definition, catalog.schemas, asset?.header.guid]);
  const recursive = issues.some(issue => issue.code === "recursive-schema");
  const typeAssets = useMemo(() => [
    ...catalog.types.dataDefinitions.filter(entry => entry.guid !== asset?.header.guid).map(entry => ({ guid: entry.guid, name: entry.name, type: "DataDefinition" })),
    ...catalog.types.enums.map(entry => ({ guid: entry.guid, name: entry.name, type: "Enum" })),
  ], [catalog.types, asset?.header.guid]);

  const commit = (fields: DataDefinitionField[], mergeKey?: string) => {
    if (readOnly || !doc) return;
    setError(null);
    void documents.applyAssetDocumentChange(documentId, { ...definition, fields }, mergeKey).catch(reason => setError(reason instanceof Error ? reason.message : String(reason)));
  };
  const patchSelected = (patch: Partial<DataDefinitionField>, mergeKey?: string) => {
    if (!selected) return;
    commit(definition.fields.map(field => field.id === selected.id ? { ...field, ...patch } : field), mergeKey);
  };
  const changeFields = (rows: PinListRow[]) => {
    const current = new Map(definition.fields.map(field => [field.id, field]));
    const fields = rows.map(row => {
      const previous = current.get(row.id);
      const field: DataDefinitionField = {
        ...previous, id: row.id, name: row.name, typeId: row.type,
        typeClassId: row.typeClassId, container: row.container ?? "single",
        keyTypeId: row.keyTypeId, keyTypeClassId: row.keyTypeClassId,
      };
      if (!previous || previous.typeId !== field.typeId || previous.typeClassId !== field.typeClassId ||
        (previous.container ?? "single") !== field.container || previous.keyTypeId !== field.keyTypeId || previous.keyTypeClassId !== field.keyTypeClassId) {
        field.defaultValue = structInstanceDefault([{ ...field, defaultValue: undefined }], catalog.schemas)[field.name];
        delete field.min;
        delete field.max;
      }
      return field;
    });
    const added = fields.find(field => !current.has(field.id));
    if (added) setSelectedId(added.id);
    commit(fields);
  };

  const rules: PropertyRow[] = selected ? [
    { id: "category", kind: "text", label: "Category", value: selected.category ?? "", onChange: value => patchSelected({ category: value }) },
    { id: "description", kind: "text", label: "Description", value: selected.description ?? "", onChange: value => patchSelected({ description: value }) },
    { id: "required", kind: "boolean", label: "Required", value: selected.required === true, onChange: value => patchSelected({ required: value }) },
  ] : [];
  if (selected && (selected.typeId === "float" || selected.typeId === "int") && (selected.container ?? "single") === "single") {
    for (const bound of ["min", "max"] as const) {
      const label = bound === "min" ? "Minimum" : "Maximum";
      rules.push({ id: `use-${bound}`, kind: "boolean", label: `Limit ${label}`, value: selected[bound] !== undefined, onChange: value => patchSelected({ [bound]: value ? 0 : undefined }) });
      if (selected[bound] !== undefined) rules.push({ id: bound, kind: "number", label, value: selected[bound]!, onChange: value => patchSelected({ [bound]: value }, `definition:${selected.id}:${bound}`) });
    }
  }

  return <PanelFrame data-testid="data-definition-fields-panel">
    <div className="flex min-h-0 flex-col gap-2 overflow-y-auto p-2">
      {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
      <PinListEditor
        rows={definition.fields.map(field => ({ ...field, type: field.typeId, defaultValue: undefined }))}
        onChange={changeFields} selectedId={selected?.id} onSelect={setSelectedId}
        itemLabel="Field" showOptional={false} showDefault={false} showContainer
        types={FIELD_TYPES} structAssetType="DataDefinition" typeAssets={typeAssets}
        classEntries={catalog.classEntries} readOnly={readOnly}
        testIdPrefix="definition-field" data-testid="data-definition-fields"
      />
      {selected ? <>
        <Separator />
        {recursive ? null : <DataValueEditor field={selected}
          value={selected.defaultValue !== undefined ? selected.defaultValue : structInstanceDefault([{ ...selected, defaultValue: undefined }], catalog.schemas)[selected.name]}
          defaultValue={structInstanceDefault([{ ...selected, defaultValue: undefined }], catalog.schemas)[selected.name]}
          onChange={value => patchSelected({ defaultValue: value }, `definition:${selected.id}:default`)}
          label="Default Value" path={selected.name} disabled={readOnly} catalog={catalog} issues={issues}
        />}
        <PropertyGrid title="Field Rules" rows={rules} readOnly={readOnly} />
      </> : null}
      {issues.length ? <Alert variant="destructive"><AlertDescription><ul className="list-disc pl-4">{issues.map((issue, index) => <li key={`${issue.path}:${issue.code}:${index}`}>{issue.path ? `${issue.path}: ` : ""}{issue.message}</li>)}</ul></AlertDescription></Alert> : null}
    </div>
  </PanelFrame>;
}

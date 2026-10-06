import { defaultValueForPinType, pinDefaultPropertyKey, type LiteralPinDefault } from "@babylonslate/scripting";
import { humanizePropertyLabel } from "@babylonslate/editor-kit";
import { graphDataLiteralField } from "../lib/graph-inspector";
import { useDataCatalog } from "../lib/use-data-catalog";
import { DataValueEditor } from "./data-value-editor";

/** The sheet editor's recursive controls also author typed graph row literals. */
export function GraphDataLiteralEditor({ entry, catalog, onChange, hasAuthoredValue = true }: {
  entry: LiteralPinDefault;
  catalog: ReturnType<typeof useDataCatalog>;
  onChange: (value: unknown) => void;
  hasAuthoredValue?: boolean;
}) {
  const field = graphDataLiteralField(entry, catalog.schemas);
  if (!field) return null;
  const defaults = defaultValueForPinType(entry.type, catalog.schemas);
  return <DataValueEditor
    field={field} value={hasAuthoredValue ? entry.value : defaults} defaultValue={defaults}
    onChange={onChange} label={humanizePropertyLabel(entry.name)} path={entry.pinId}
    disabled={false} catalog={catalog} issues={[]}
  />;
}

export function GraphDataLiteralDefaults({ entries, nodeData, onPatch }: {
  entries: readonly LiteralPinDefault[];
  nodeData: Record<string, unknown>;
  onPatch: (patch: Record<string, unknown>) => void;
}) {
  const catalog = useDataCatalog();
  return <div className="flex flex-col gap-2" data-testid="inspector-data-literal-defaults">
    {entries.map((entry) => <GraphDataLiteralEditor key={entry.pinId} entry={entry} catalog={catalog}
      hasAuthoredValue={nodeData[pinDefaultPropertyKey(entry.pinId)] !== undefined}
      onChange={(value) => onPatch({ [pinDefaultPropertyKey(entry.pinId)]: value })} />)}
  </div>;
}

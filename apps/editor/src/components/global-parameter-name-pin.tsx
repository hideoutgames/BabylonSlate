import { PropertyGrid, type PropertyRow } from "@haptic/editor-kit";
import type { PinDefaultEditorRequest } from "@haptic/graph-ui";
import { useGlobalParameterCatalog } from "../lib/global-parameter-catalog";
import { globalParameterPinTypes } from "../lib/global-parameter-pin-types";

/**
 * The Parameter pin of a Set or Get Global Parameter node with a Collection: a list of that
 * collection's parameters of the node's type. A name the list lacks stays selected and is
 * marked; a collection with no such parameter leaves free text.
 */
export function GlobalParameterNamePin({ request }: { request: PinDefaultEditorRequest }) {
  const catalog = useGlobalParameterCatalog();
  const types = globalParameterPinTypes(request) ?? [];
  const collection = String(request.nodeData["default:collection"] ?? "");
  const names = (catalog[collection] ?? []).filter((parameter) => types.includes(parameter.type)).map((parameter) => parameter.name);
  const value = typeof request.value === "string" ? request.value : "";
  const id = `${request.nodeId}:${request.pin.id}`;
  const row: PropertyRow = names.length
    ? {
        id, kind: "enum", label: request.pin.name, value,
        options: [
          ...(value && !names.includes(value) ? [{ value, label: `${value} (Not In Collection)` }] : []),
          ...names.map((name) => ({ value: name, label: name })),
        ],
        onChange: (next) => { if (!request.disabled) request.onChange(next); },
      }
    : {
        id, kind: "text", label: request.pin.name, value,
        onChange: () => undefined,
        onCommit: (next) => { if (!request.disabled) request.onChange(next); },
      };
  return (
    <div className="min-w-24 max-w-(--graph-pin-default-max-width)" data-testid={`global-parameter-name-${request.nodeId}`}>
      <PropertyGrid rows={[row]} hideLabels density="compact" orientation="horizontal" readOnly={request.disabled} />
    </div>
  );
}
